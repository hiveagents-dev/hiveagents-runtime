import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { isExecutionHalted } from '../../src/public/execution-halt.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import type { LogCommit } from '../../src/orchestration/log/types.js';
import { digest } from '../../src/orchestration/log/encoding.js';
import type { ControlSessionHandle } from '../../src/session/control-session.js';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
const identity = { systemId: 'fixture', generation: 1, runId: 'control-run', agentId: 'logical-agent', harness: { id: 'sdk', version: '1', digest: 'a'.repeat(64) } };
const cleanup: Array<() => unknown> = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(failType?: string, openGate?: Promise<void>, eager = false) {
  const directory = await mkdtemp(join(tmpdir(), 'oar-control-capture-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const log = new SqliteRunLogStore({ databasePath: join(directory, 'log.sqlite'), systemId: 'fixture' }); cleanup.push(() => log.close());
  const counts = { opened: 0, turns: 0, closed: 0, forks: 0, headAtOpen: 0, headAtTurn: 0, headAtFork: 0 };
  const handle: ControlSessionHandle = { transportEpoch: 'fixture-epoch', identity: eager ? { schemaVersion: 1, provider: 'claude', id: 'fixture-session', transport: 'control', persistence: 'provider', transportEpoch: 'fixture-epoch', cwd: process.cwd(), createdAt: new Date().toISOString() } : undefined, state: () => 'active',
    startTurn: async () => {
      counts.turns++; counts.headAtTurn = (await log.readPage()).items.length;
      return { stream: (async function* () { yield { kind: 'session' as const, sessionId: 'fixture-session' }; yield { kind: 'event' as const, event: { type: 'message.delta' as const, text: 'private-control-secret' } }; yield { kind: 'result' as const, result: { completed: true, failed: false, refused: false, sessionId: 'fixture-session', turnId: 'fixture-turn', text: 'private-control-secret', events: [], nativeEvents: [], usage: { outputTokens: 7, costMeaning: 'unavailable' as const } } }; })(), interrupt: async () => ({ requested: true, terminal: 'unknown' as const }) };
    }, respond: async () => {}, fork: async () => {
      counts.forks++; counts.headAtFork = (await log.readPage()).items.length;
      return { ...handle, transportEpoch: 'fixture-child-epoch', startTurn: async request => {
        const turn = await handle.startTurn(request); return { ...turn, stream: (async function* () { for await (const item of turn.stream) yield item.kind === 'session' ? { ...item, sessionId: 'fixture-child' } : item.kind === 'result' ? { ...item, result: { ...item.result, sessionId: 'fixture-child' } } : item; })() };
      } };
    }, close: async () => { counts.closed++; } };
  const adapter = { id: 'claude', detect: async () => ({ installed: true, path: '/oar-owned-test/no-cli', version: '1.0.0' }), auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [], execute: async () => { throw Error('must never fall back to exec'); } } as unknown as ExecAdapter;
  const runtime = new Runtime({ adapters: [adapter], controlAdapters: [{ provider: 'claude', token: 'claudeControlV1', packageName: '@open-agent-runtime/claude-control', adapterVersion: '0.1.0', evidenceSource: 'sdk-capability', capabilityVerdicts: { messageDeltas: 'full', processPersistence: 'full', steering: 'none' }, createSession: async () => { counts.opened++; counts.headAtOpen = (await log.readPage()).items.length; if (openGate) await openGate; return handle; } }],
    capture: { identity, maxWriteMs: 40, store: { append: (commit: LogCommit) => { if (commit.records.some(record => record.type === failType)) throw Error('private-storage-secret'); return log.append(commit); } } } });
  const agent = new Agent({ model: 'claude/opus', transport: 'control', providerOptions: { experimentalControl: true } }, runtime); cleanup.push(() => agent.close()); return { agent, log, counts, runtime, setFailure: (type: string) => { failType = type; } };
}
it.each(['send', 'start', 'stream'] as const)('captures real control producer %s independently of ordinary observers', async mode => {
  const { agent, log, counts } = await setup();
  if (mode === 'send') await agent.send('fixture'); else if (mode === 'start') await agent.start('fixture').result; else for await (const _ of agent.stream('fixture')) { /* drain */ }
  expect(counts).toMatchObject({ opened: 1, turns: 1 }); expect(counts.headAtOpen).toBe(1); expect(counts.headAtTurn).toBeGreaterThan(2);
  const items = (await log.readPage()).items; expect(items.filter(entry => entry.record.type === 'capture.started')).toHaveLength(2);
  expect(items.at(-1)!.record.type).toBe('capture.settled'); expect(items.some(entry => entry.record.type === 'message.delta')).toBe(true); expect(JSON.stringify(items)).not.toContain('private-control-secret');
});
it('requires startup persistence before calling the control factory', async () => {
  const { agent, counts } = await setup('capture.started'); await expect(agent.send('fixture')).rejects.toSatisfy(isExecutionHalted); expect(counts).toMatchObject({ opened: 0, turns: 0 });
});
it('preserves a genuine required capture halt through control cancellation and ordinary event lanes', async () => {
  const { agent, counts } = await setup('message.delta'); await expect(agent.send('fixture')).rejects.toSatisfy(isExecutionHalted); expect(counts.turns).toBe(1);
});
it('does not start a capture or leave a scope behind for a rejected control option', async () => {
  const { agent, log, counts } = await setup(), session = await agent.openSession(); const before = (await log.readPage()).through;
  expect(() => session.start('invalid', { signalBehavior: 'detach', timeoutMs: 50 })).toThrow();
  await new Promise(resolve => setTimeout(resolve, 70)); expect((await log.readPage()).through).toEqual(before);
  await session.send('valid'); expect(counts.turns).toBe(1);
});
it('requires startup capture before the actual control fork and attributes its first child turn', async () => {
  const { agent, log, counts } = await setup(), parent = await agent.openSession(); await parent.send('fixture'); const head = (await log.readPage()).through;
  const child = await parent.forkAndSend('fixture'); cleanup.push(() => child.session.close());
  expect(counts.forks).toBe(1); expect(counts.headAtFork).toBeGreaterThan(head.sequence); expect(child.turn.session.id).toBe('fixture-child');
  expect((await log.readPage()).items.filter(entry => entry.sequence > head.sequence && entry.record.type === 'capture.started')).toHaveLength(2);
});
it('halts a pending control startup promptly on global sink failure and closes its late actual handle', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const { agent, counts, runtime, setFailure } = await setup(undefined, gate), other = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime); cleanup.push(() => other.close());
  const running = agent.send('fixture'); void running.catch(() => {}); await expect.poll(() => counts.opened).toBe(1); setFailure('capture.started');
  await expect(other.send('must-not-launch')).rejects.toSatisfy(isExecutionHalted);
  let error: unknown; const raced = Promise.race([running.catch(value => { error = value; return 'halted'; }), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
  const result = await raced; release(); await expect.poll(() => counts.closed).toBe(1);
  expect(result).toBe('halted'); expect(isExecutionHalted(error)).toBe(true); expect(counts.turns).toBe(0);
});
it('includes an already-confirmed native session and epoch in the pre-dispatch turn record', async () => {
  const { agent, log } = await setup(undefined, undefined, true); await agent.send('fixture');
  const started = (await log.readPage()).items.filter(entry => entry.record.type === 'capture.started').at(-1)!;
  expect(started.record.payload).toMatchObject({ inline: { actual: { sessionIdDigest: digest('fixture-session'), transportEpochDigest: digest('fixture-epoch') } } });
});
