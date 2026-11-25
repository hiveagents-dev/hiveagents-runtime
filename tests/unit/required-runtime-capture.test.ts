import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../src/public/execution-halt.js';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import { runProcess } from '../../src/process/run-process.js';
import type { ExecAdapter, ExecTurnRequest, ProcessRunner } from '../../src/adapters/provider.js';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { createLogTraceProjector } from '../../src/orchestration/log/trace-projector.js';
import { digest } from '../../src/orchestration/log/encoding.js';
import { createAgent } from '../../src/routing/selector.js';
import { AgentRuntimeError } from '../../src/public/errors.js';
import { RequiredTurnCapture } from '../../src/session/required-capture.js';
import type { SessionConfig } from '../../src/session/config.js';
const fixture = fileURLToPath(new URL('../fixtures/process/required-capture-cli.mjs', import.meta.url));
const identity = { systemId: 'fixture', generation: 1, runId: 'run', agentId: 'logical-agent', harness: { id: 'sdk', version: '1', digest: 'a'.repeat(64) } };
const cleanup: Array<() => unknown> = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class OwnedCli implements ExecAdapter {
  calls = 0; installed = true; readonly delegate: ClaudeExecAdapter | CodexExecAdapter;
  executeImpl: ExecAdapter['execute'] | undefined;
  constructor(readonly id: 'claude' | 'codex', runner: ProcessRunner = runProcess) {
    const options = { target: { command: process.execPath, argsPrefix: [fixture, id] }, runner };
    this.delegate = id === 'claude' ? new ClaudeExecAdapter(options) : new CodexExecAdapter(options);
  }
  async detect() { return { installed: this.installed, path: '/oar-owned-test/no-installed-cli', version: '1.0.0' }; }
  async auth() { return { authenticated: true, source: 'subscription' as const }; }
  async models() { return []; }
  async execute(request: ExecTurnRequest) { this.calls++; return this.executeImpl ? this.executeImpl(request) : this.delegate.execute(request); }
  async *stream(request: ExecTurnRequest) { this.calls++; yield* this.delegate.stream(request); }
}
async function setup(storeOverride?: (store: SqliteRunLogStore) => { append: SqliteRunLogStore['append'] }, maxWriteMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'oar-runtime-capture-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const log = new SqliteRunLogStore({ databasePath: join(directory, 'log.sqlite'), systemId: 'fixture' }); cleanup.push(() => log.close());
  const launches: number[] = [], runner: ProcessRunner = async request => { launches.push((await log.readPage()).items.length); return runProcess(request); };
  const claude = new OwnedCli('claude', runner), codex = new OwnedCli('codex', runner);
  const runtime = new Runtime({ adapters: [claude, codex], capture: { store: storeOverride?.(log) ?? log, identity, maxWriteMs } });
  const agent = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime); cleanup.push(() => agent.close());
  return { log, runtime, agent, claude, codex, launches };
}
it.each(['send', 'start', 'stream'] as const)('captures actual owned CLI %s with durable ACK before inference and real identity', async mode => {
  const { agent, log, launches } = await setup();
  if (mode === 'send') expect((await agent.send('fixture')).text).toBe('seeded-native-secret');
  else if (mode === 'start') expect((await agent.start('fixture').result).session.id).toBeTruthy();
  else { const events = []; for await (const event of agent.stream('fixture')) events.push(event); expect(events.at(-1)?.type).toBe('turn.completed'); }
  expect(launches).toHaveLength(1); expect(launches[0]).toBeGreaterThan(0);
  const page = await log.readPage(); expect(page.items[0]!.record.type).toBe('capture.started'); expect(page.items.at(-1)!.record.type).toBe('capture.settled');
  expect(JSON.stringify(page)).not.toContain('seeded-native-secret');
  const view = await createLogTraceProjector({ reader: log, identity: (agent as unknown as { logIdentity: typeof identity }).logIdentity }).rebuild(); expect(view.kind).toBe('observed');
  expect(view.items.some(item => item.category === 'agent-event' && (item.metadata as { event?: { type: string } }).event?.type === 'session.started')).toBe(true);
});
it('keeps ordinary cancellation prompt while a real owned CLI finishes late and records its usage as interrupted', async () => {
  const { agent, claude, log } = await setup(), controller = new AbortController();
  claude.executeImpl = request => { const { signal: _signal, ...remaining } = request; return claude.delegate.execute(remaining); };
  const started = performance.now(), running = agent.send('slow', { signal: controller.signal, timeoutMs: 2000 });
  await expect.poll(() => claude.calls).toBe(1); controller.abort(); await expect(running).rejects.toMatchObject({ code: 'ABORTED' }); expect(performance.now() - started).toBeLessThan(220);
  await expect.poll(async () => (await log.readPage()).items.at(-1)!.record.type).toBe('capture.interrupted');
  expect((await log.readPage()).items.at(-1)!.record.payload).toMatchObject({ inline: { usage: { outputTokens: 3 } } });
  expect((await createLogTraceProjector({ reader: log, identity: agent.logIdentity! }).rebuild()).kind).toBe('incomplete');
});
it('early stream return keeps an explicit incomplete capture and closes the owned fixture without waiting for its text', async () => {
  const { agent, log, claude } = await setup(); const started = performance.now();
  for await (const event of agent.stream('hang', { timeoutMs: 2000 })) { if (event.type === 'message.delta') break; }
  expect(performance.now() - started).toBeLessThan(1500); expect(claude.calls).toBe(1);
  await expect.poll(async () => (await log.readPage()).items.at(-1)!.record.type).toBe('capture.interrupted');
  expect((await createLogTraceProjector({ reader: log, identity: agent.logIdentity! }).rebuild()).kind).toBe('incomplete');
});
it('preserves an actual late nominal halt through awaitSettlement and blocks dependent new agents', async () => {
  const { agent, runtime, claude } = await setup(), controller = new AbortController();
  const halt = new AggregateError([new ExecutionHaltedError()], 'private-original-late-halt');
  claude.executeImpl = async request => { const { signal: _signal, ...remaining } = request; await claude.delegate.execute(remaining); throw halt; };
  const running = agent.send('slow', { signal: controller.signal, awaitSettlement: true, timeoutMs: 2000 }); await expect.poll(() => claude.calls).toBe(1); controller.abort();
  await expect(running).rejects.toBe(halt);
  const other = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime); cleanup.push(() => other.close()); await expect(other.send('must-not-launch')).rejects.toSatisfy(isExecutionHalted); expect(claude.calls).toBe(1);
});
it('a global capture-capacity halt prevents a sibling from launching after its delayed initial ACK', async () => {
  let release!: () => void; const block = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const { agent, runtime, claude } = await setup(log => ({ append: async commit => { if (++calls <= 2) await block; return log.append(commit); } }));
  // Runtime's default capacity2: a third concurrent initial append must close intake for all three.
  const second = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime), third = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime); cleanup.push(() => second.close()); cleanup.push(() => third.close());
  const one = agent.send('fixture'); void one.catch(() => {}); await expect.poll(() => calls).toBe(1);
  const two = second.send('fixture'); void two.catch(() => {}); await expect.poll(() => calls).toBe(2);
  const three = third.send('fixture'); void three.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20)); release();
  const results = await Promise.allSettled([one, two, three]); expect(results.every(result => result.status === 'rejected' && isExecutionHalted(result.reason))).toBe(true); expect(claude.calls).toBe(0);
});
it('a required terminal write timeout halts after actual inference and leaves incomplete metadata', async () => {
  const { agent, claude, log } = await setup(log => ({ append: commit => commit.records.some(record => record.type === 'turn.completed') ? new Promise(() => {}) : log.append(commit) }), 40);
  const error = await agent.send('fixture').catch(error => error); expect(isExecutionHalted(error)).toBe(true); expect(error.message).not.toContain('seeded'); expect(claude.calls).toBe(1);
  expect((await createLogTraceProjector({ reader: log, identity: agent.logIdentity! }).rebuild()).kind).toBe('incomplete');
});
it('retains usage from an actual late provider rejection after ordinary cancellation', async () => {
  const { agent, claude, log } = await setup(), controller = new AbortController();
  claude.executeImpl = async request => { const { signal: _signal, ...remaining } = request; await claude.delegate.execute(remaining); throw new AgentRuntimeError('PROTOCOL_ERROR', 'private-late-error', { retryable: false, observedUsage: { outputTokens: 19, costMeaning: 'unavailable' } }); };
  const running = agent.send('slow', { signal: controller.signal, timeoutMs: 2000 }); await expect.poll(() => claude.calls).toBe(1); controller.abort(); await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
  await expect.poll(async () => (await log.readPage()).items.at(-1)!.record.payload).toMatchObject({ inline: { usage: { outputTokens: 19 } } });
});
it('preserves an ordinary typed provider failure and its actual usage instead of converting it to cancellation', async () => {
  const { agent, claude, log } = await setup();
  claude.executeImpl = async request => ({ ...await claude.delegate.execute(request), failure: { kind: 'model-unavailable', message: 'private-provider-denial' } });
  await expect(agent.send('fixture')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE_FOR_AUTH', context: { observedUsage: { outputTokens: 3 } } });
  expect((await log.readPage()).items.at(-1)!.record.payload).toMatchObject({ inline: { outcome: 'failed', usage: { outputTokens: 3 } } });
});
it('does not invoke an optional Runtime capture getter', () => {
  let invoked = false; const options = {}; Object.defineProperty(options, 'capture', { get() { invoked = true; throw Error('private'); } });
  expect(() => new Runtime(options)).toThrow(); expect(invoked).toBe(false);
});
it('observes actual settlement promises without reading untrusted usage getters', async () => {
  const { runtime } = await setup(), capture = runtime.bindLogCapture()!, model = runtime.resolveModel('claude/opus'); let invoked = false;
  const producer = new RequiredTurnCapture({ capture, model, transport: 'exec' } as SessionConfig, {}); await producer.begin();
  const result = {}; Object.defineProperty(result, 'usage', { get() { invoked = true; throw Error('private-usage'); } }); producer.track(Promise.resolve(result));
  await new Promise(resolve => setImmediate(resolve)); expect(invoked).toBe(false); await producer.complete(undefined);
});
it('keeps the selected native model immutable while its required ACK is delayed', async () => {
  let release!: () => void, appends = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const { agent, claude } = await setup(log => ({ append: async commit => { if (++appends === 1) await gate; return log.append(commit); } })); const actualModel = agent.model.id;
  const running = agent.send('fixture'); void running.catch(() => {}); await expect.poll(() => appends).toBe(1); expect(claude.calls).toBe(0);
  let refused = false; try { agent.model.id = 'mutated-native-model'; } catch { refused = true; } release();
  const turn = await running; expect(refused).toBe(true); expect(turn.session.model).toBe(actualModel);
});
it('persists an actual stream-fork ACK and captures its child model before native inference', async () => {
  const { agent, log, launches, runtime } = await setup(), parent = await agent.openSession(); await parent.send('fixture'); const head = (await log.readPage()).through;
  const childModel = 'claude/sonnet', child = await parent.forkAndSend('fixture', { model: childModel }); cleanup.push(() => child.session.close());
  expect(launches).toHaveLength(2); expect(launches[1]).toBeGreaterThan(head.sequence);
  const records = (await log.readPage()).items.filter(entry => entry.sequence > head.sequence); expect(records.at(-1)!.record.type).toBe('capture.settled');
  for (const record of records) expect(record.record.payload).toMatchObject({ inline: { actual: { modelDigest: digest(runtime.resolveModel(childModel).id) } } });
  expect(child.turn.session.id).not.toBe(parent.identity!.id);
});
it('requires an ACK for execute-only native forks and preserves their settled child', async () => {
  const { runtime, claude, log } = await setup(), initial = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime); cleanup.push(() => initial.close());
  const session = await initial.openSession(); await session.send('fixture'); const head = (await log.readPage()).through;
  // Bind an execute-only adapter before opening a fresh parent, avoiding fixture internals in the runtime.
  const adapter = { id: claude.id, detect: claude.detect.bind(claude), auth: claude.auth.bind(claude), models: claude.models.bind(claude), execute: claude.execute.bind(claude) };
  const otherRuntime = new Runtime({ adapters: [adapter], capture: { store: log, identity, maxWriteMs: 1000 } }), owner = new Agent({ model: 'claude/opus', transport: 'exec' }, otherRuntime); cleanup.push(() => owner.close());
  const parent = await owner.openSession(); await parent.send('fixture'); const beforeFork = (await log.readPage()).through;
  const { session: child } = await parent.forkAndSend('fixture'); cleanup.push(() => child.close());
  const records = (await log.readPage()).items.filter(entry => entry.sequence > beforeFork.sequence); expect(records[0]!.record.type).toBe('capture.started'); expect(records.at(-1)!.record.type).toBe('capture.settled'); expect(beforeFork.sequence).toBeGreaterThan(head.sequence);
});
it('refuses model dispatch after absent/failed initial persistence and keeps subsequent calls halted', async () => {
  const { agent, runtime, claude, log } = await setup(() => ({ append: async () => { throw Error('private-disk-secret'); } }));
  await expect(agent.send('must-not-launch')).rejects.toSatisfy(isExecutionHalted);
  const other = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime); cleanup.push(() => other.close());
  await expect(other.send('must-not-launch')).rejects.toSatisfy(isExecutionHalted); expect(claude.calls).toBe(0); expect((await log.readPage()).items).toHaveLength(0);
});
it('bounds an uncooperative required sink before inference', async () => {
  const { agent, claude } = await setup(() => ({ append: async () => new Promise(() => {}) }), 40); const started = performance.now();
  await expect(agent.send('must-not-launch', { timeoutMs: 1000 })).rejects.toSatisfy(isExecutionHalted); expect(performance.now() - started).toBeLessThan(500); expect(claude.calls).toBe(0);
});
it('retains the real session epoch and model binding across send/start/resume', async () => {
  const { agent, log } = await setup(), session = await agent.openSession(); await session.send('fixture'); await session.start('fixture').result;
  const items = (await log.readPage()).items, terminal = items.filter(entry => entry.record.type === 'turn.completed');
  expect(terminal).toHaveLength(2);
  for (const entry of terminal) expect(entry.record.payload).toMatchObject({ inline: { sessionBinding: { transportEpochDigest: digest(session.identity!.transportEpoch), providerDigest: digest('claude'), modelDigest: digest(agent.model.id), persistence: 'provider', transport: 'exec' } } });
});
it('logs the actual auto-selector fallback provider rather than the first requested candidate', async () => {
  const { runtime, log, claude, codex } = await setup(); claude.installed = false;
  const selected = await createAgent({ transport: 'exec', model: { mode: 'auto', candidates: ['claude/opus', 'codex/gpt-5.4'], fallback: 'codex/gpt-5.4', allowUnverifiedModels: true } }, { runtime, receipts: { save: async () => {}, load: async () => undefined } });
  cleanup.push(() => selected.agent.close()); await selected.agent.send('fixture');
  expect(claude.calls).toBe(0); expect(codex.calls).toBe(1);
  for (const entry of (await log.readPage()).items) expect(entry.record.payload).toMatchObject({ inline: { actual: { providerDigest: digest('codex'), modelDigest: digest(selected.agent.model.id), transport: 'exec', phase: 'turn' } } });
});
it('attributes two agents sharing one runtime to stable distinct child identities', async () => {
  const { agent, runtime, log } = await setup(), other = new Agent({ model: 'codex/gpt-5.4', transport: 'exec' }, runtime); cleanup.push(() => other.close());
  await agent.send('fixture'); await other.send('fixture'); const items = (await log.readPage()).items;
  const ids = [...new Set(items.map(entry => entry.record.identity.agentId))]; expect(ids).toHaveLength(2);
  expect((agent as unknown as { logIdentity: typeof identity }).logIdentity.agentId).not.toBe((other as unknown as { logIdentity: typeof identity }).logIdentity.agentId);
});
it('keeps the public Agent identity when one-shot context uses an internal owner clone', async () => {
  const { agent, log } = await setup(); const expected = agent.logIdentity!;
  await agent.run('fixture', { context: { profile: 'clean' } });
  expect((await log.readPage()).items.every(entry => entry.record.identity.agentId === expected.agentId)).toBe(true);
});
