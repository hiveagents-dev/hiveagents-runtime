import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { createRequiredLogCapture } from '../../src/orchestration/log/capture.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../src/public/execution-halt.js';
import { AgentRuntimeError } from '../../src/public/errors.js';
import type { AgentEvent } from '../../src/public/types.js';
import type { LogCommit } from '../../src/orchestration/log/types.js';

const identity = { systemId: 'fixture', generation: 1, runId: 'run', agentId: 'agent', harness: { id: 'sdk', version: '1', digest: 'a'.repeat(64) } };
const actual = { provider: 'seed-provider-secret', model: 'seed-model-secret', attemptId: 'attempt-1' };
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-capture-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const value = new SqliteRunLogStore({ databasePath: join(directory, 'log.sqlite'), systemId: 'fixture' }); cleanup.push(() => value.close()); return value;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it('commits initial capture before work and immutable metadata-only events before final invocation ACK', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual });
  expect(await capture.run(async () => {
    expect((await log.readPage()).items.map(e => e.record.type)).toEqual(['capture.started']);
    await capture.observe({ type: 'message.delta', text: 'native-seeded-secret 😀' }); return 42;
  })).toBe(42);
  expect((await log.readPage()).items.map(e => e.record.type)).toEqual(['capture.started', 'message.delta', 'capture.settled']);
  const encoded = JSON.stringify(await log.readPage()); expect(encoded).not.toContain('native-seeded-secret'); expect(encoded).not.toContain(actual.provider); expect(encoded).not.toContain(actual.model);
  expect(capture.snapshot()).toMatchObject({ state: 'settled', pending: 0, textReconstruction: 'unavailable' });
  await expect(capture.run(async () => 1)).rejects.toSatisfy(isExecutionHalted);
});
it('never invokes work when the required initial durable ACK is lost', async () => {
  const log = await store(); let ran = false;
  const capture = createRequiredLogCapture({ store: { append: async (commit: LogCommit) => { await log.append(commit); throw Error('private-ack-loss'); } }, identity, actual });
  const error = await capture.run(async () => { ran = true; }).catch(e => e);
  expect(isExecutionHalted(error)).toBe(true); expect(ran).toBe(false); expect((await log.readPage()).items).toHaveLength(1);
  expect(error.message).not.toContain('private-ack-loss'); expect(capture.snapshot().state).toBe('halted');
});
it('bounds a blocked capture sink and retains sticky halt even when the observer rejection was ignored', async () => {
  const log = await store(), block = deferred<void>(); let calls = 0;
  const capture = createRequiredLogCapture({ store: { append: async (commit: LogCommit) => { if (++calls === 2) await block.promise; return log.append(commit); } }, identity, actual, maxPending: 1 });
  const started = deferred<void>(); const run = capture.run(async () => {
    const pending = capture.observe({ type: 'turn.started' });
    void capture.observe({ type: 'context.compacted' }).catch(() => {}); started.resolve(); await pending;
  });
  await started.promise; expect(capture.snapshot()).toMatchObject({ state: 'halted', pending: 1 });
  expect(capture.signal.aborted).toBe(true); block.resolve(); await expect(run).rejects.toSatisfy(isExecutionHalted); expect(calls).toBe(2);
});
it('preserves genuine halt identity and the latest failed-attempt usage after an optimistic terminal event', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual });
  const halt = new ExecutionHaltedError({ observedUsage: { outputTokens: 9, costMeaning: 'unavailable' } });
  await expect(capture.run(async () => {
    await capture.observe({ type: 'turn.completed', turn: { id: 'turn-secret', session: { id: 'session-secret' }, status: 'completed', usage: { outputTokens: 1, costMeaning: 'unavailable' } } } as AgentEvent);
    throw halt;
  })).rejects.toBe(halt);
  expect((await log.readPage()).items.at(-1)!.record.payload).toMatchObject({ inline: { outcome: 'halted', usage: { outputTokens: 9 } } });
});
it('keeps original work failure as first cause when terminal persistence also fails', async () => {
  const log = await store(); let calls = 0; const original = new AgentRuntimeError('PROTOCOL_ERROR', 'private-provider-prose', { retryable: false });
  const capture = createRequiredLogCapture({ store: { append: (commit: LogCommit) => ++calls === 2 ? Promise.reject(Error('private-disk')) : log.append(commit) }, identity, actual });
  const error = await capture.run(async () => { throw original; }).catch(e => e);
  expect(isExecutionHalted(error)).toBe(true); expect(error.cause).toBe(original); expect(error.message).not.toContain('private');
});
it('omits private ignored getters and rejects a selected getter without invoking it', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual }); let invoked = false;
  await capture.run(async () => {
    const event = { type: 'tool.started', id: 'secret-tool-id', name: 'secret-name' };
    Object.defineProperty(event, 'input', { get() { invoked = true; throw Error('secret'); } }); await capture.observe(event as AgentEvent);
  });
  expect(invoked).toBe(false); expect(JSON.stringify(await log.readPage())).not.toContain('secret-tool-id');
  const other = createRequiredLogCapture({ store: log, identity, actual });
  await expect(other.run(async () => {
    const event = { type: 'message.delta' }; Object.defineProperty(event, 'text', { get() { invoked = true; return 'secret'; } }); await other.observe(event as AgentEvent);
  })).rejects.toSatisfy(isExecutionHalted); expect(invoked).toBe(false);
});
it('captures mutable configuration once and refuses constructor accessors/proxies', async () => {
  const log = await store(), options = { store: log, identity: structuredClone(identity), actual: { ...actual }, maxPending: 1 };
  const capture = createRequiredLogCapture(options); options.actual.provider = 'mutated'; options.identity.runId = 'mutated';
  await capture.run(async () => {}); expect((await log.readPage()).items[0]!.record.identity.runId).toBe('run');
  expect(JSON.stringify(await log.readPage())).not.toContain('mutated');
  expect(() => createRequiredLogCapture(new Proxy(options, {}))).toThrow();
});
it('cannot publish an event before the initial ACK or start work after that boundary halted', async () => {
  const log = await store(), block = deferred<void>(); let ran = false;
  const capture = createRequiredLogCapture({ store: { append: async (commit: LogCommit) => { await block.promise; return log.append(commit); } }, identity, actual });
  const run = capture.run(async () => { ran = true; });
  const early = capture.observe({ type: 'turn.started' }); void early.catch(() => {});
  block.resolve(); await expect(run).rejects.toSatisfy(isExecutionHalted); expect(ran).toBe(false);
  expect((await log.readPage()).items.map(e => e.record.type)).toEqual(['capture.started']);
});
it('retains late observed usage inside an original native aggregate without changing the halt graph', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual });
  const halt = new ExecutionHaltedError(), provider = new AgentRuntimeError('PROTOCOL_ERROR', 'private', { retryable: false, observedUsage: { outputTokens: 17, costMeaning: 'unavailable' } });
  const aggregate = new AggregateError([halt, provider], 'private-aggregate');
  await expect(capture.run(async () => { throw aggregate; })).rejects.toBe(aggregate);
  expect((await log.readPage()).items.at(-1)!.record.payload).toMatchObject({ inline: { usage: { outputTokens: 17 }, outcome: 'halted' } });
});
it('requires a closed receipt before invoking work rather than accepting an absent acknowledgement', async () => {
  let ran = false; const capture = createRequiredLogCapture({ store: { append: async () => undefined as never }, identity, actual });
  await expect(capture.run(async () => { ran = true; })).rejects.toSatisfy(isExecutionHalted); expect(ran).toBe(false);
});
it('records actual attempt boundaries and usage model hashes without seeded labels', async () => {
  const log = await store();
  for (const provider of ['seed-claude', 'seed-codex']) {
    const capture = createRequiredLogCapture({ store: log, identity, actual: { provider, attemptId: provider } });
    await capture.run(async () => { await capture.observe({ type: 'turn.completed', turn: { status: 'failed', session: { id: 'session' }, usage: { costMeaning: 'unavailable', perModel: { 'seed-model': { outputTokens: 3 } } } } } as unknown as AgentEvent); });
  }
  const page = await log.readPage(); const json = JSON.stringify(page); for (const label of ['seed-claude', 'seed-codex', 'seed-model']) expect(json).not.toContain(label);
  const starts = page.items.filter(entry => entry.record.type === 'capture.started'); expect(starts).toHaveLength(2); expect(starts[0]!.record.payload).not.toEqual(starts[1]!.record.payload);
});
it('preserves the original genuine halt as a cause when a required write is interrupted', async () => {
  const controller = new AbortController(), original = new AggregateError([new ExecutionHaltedError()], 'private-original');
  const capture = createRequiredLogCapture({ store: { append: async () => new Promise(() => {}) }, identity, actual, signal: controller.signal, maxWriteMs: 1000 });
  const run = capture.run(async () => {}); controller.abort(original); const error = await run.catch(error => error); expect(isExecutionHalted(error)).toBe(true); expect(error.cause).toBe(original);
});
