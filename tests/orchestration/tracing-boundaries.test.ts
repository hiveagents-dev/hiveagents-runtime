import { expect, it } from 'vitest';
import { openTraceEpisode, readTraceEpisode, WorkflowTraceStore, type TraceEpisode, type TraceIdentity, type TraceStore } from '../../src/orchestration/tracing/index.js';
import type { WorkflowCheckpoint, WorkflowStore } from '../../src/orchestration/workflow/types.js';

const identity: TraceIdentity = { episodeId: 'boundaries', task: { id: 'task', version: '1', inputDigest: 'a'.repeat(64) },
  source: { id: 'source', version: '1', digest: 'b'.repeat(64) }, profile: { id: 'profile', version: '1', digest: 'c'.repeat(64) } };
function workflowMemory() {
  let checkpoint: WorkflowCheckpoint | undefined;
  const workflow: WorkflowStore = { acquire: async () => ({ load: async () => checkpoint,
    save: async value => { checkpoint = structuredClone(value); }, release: async () => {} }) };
  return { store: new WorkflowTraceStore(workflow), current: () => checkpoint! };
}

it('uses only interaction binding IDs while excluding questions, arguments and authority data', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  await recorder.observe({ type: 'interaction.requested', request: { kind: 'dynamic-tool', toolName: 'CANARY_TOOL',
    arguments: { secret: 'CANARY_ARGS' }, availableDecisions: ['CANARY_AUTHORITY'], signal: new AbortController().signal,
    binding: { interactionId: 'interaction-1', provider: 'codex', transportEpoch: 'epoch', method: 'CANARY_METHOD',
      sessionId: 'session-1', turnId: 'turn-1', payloadDigest: 'd'.repeat(64) } } });
  expect(recorder.snapshot().entries[0]).toMatchObject({ interactionId: 'interaction-1', sessionId: 'session-1', turnId: 'turn-1' });
  expect(JSON.stringify(recorder.snapshot())).not.toContain('CANARY');
  await recorder.close();
});

it('rejects accessor-backed persisted entries without executing their getters', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  const valid = recorder.snapshot(); await recorder.close();
  let reads = 0;
  const entries: unknown[] = [];
  Object.defineProperty(entries, '0', { enumerable: true, get: () => { reads++; return { type: 'x', sequence: 1, timestamp: valid.startedAt }; } });
  const unsafe: TraceStore = { acquire: async () => ({ load: async () => ({ ...valid, entries }), save: async () => {}, release: async () => {} }) };
  await expect(readTraceEpisode(unsafe, identity.episodeId)).rejects.toThrow();
  expect(reads).toBe(0);
});

it('store leases bind the episode identity and reject terminal overwrite and history rewrites', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  await recorder.append({ type: 'prepared' });
  const running = recorder.snapshot(); await recorder.close();
  const wrong = await store.acquire('different');
  await expect(wrong.save(running)).rejects.toThrow(/identity/i); await wrong.release();
  const owned = await store.acquire(identity.episodeId);
  const other = await openTraceEpisode({ acquire: async () => ({ load: async () => undefined, save: async () => {}, release: async () => {} }) }, identity);
  await expect(owned.save(other.snapshot())).rejects.toThrow(/history|identity/i); await owned.release(); await other.close();
  const finished = await openTraceEpisode(store, identity);
  const terminal = await finished.finish('completed'); await finished.close();
  const lease = await store.acquire(identity.episodeId);
  await expect(lease.save(terminal)).rejects.toThrow(/finished/i); await lease.release();
});

it('rejects unknown workflow envelope fields even when a trusted store returns valid trace data', async () => {
  const { store, current } = workflowMemory(); const recorder = await openTraceEpisode(store, identity); await recorder.close();
  Object.assign(current().steps.record!, { error: 'CANARY' });
  await expect(readTraceEpisode(store, identity.episodeId)).rejects.toThrow(/field/i);
});

it('waits for pending durable writes before close releases ownership', async () => {
  let finishSave!: () => void; let saves = 0; let releases = 0;
  const pending = new Promise<void>(resolve => { finishSave = resolve; });
  const store: TraceStore = { acquire: async () => ({ load: async () => undefined,
    save: async () => { if (++saves === 2) await pending; }, release: async () => { releases++; } }) };
  const recorder = await openTraceEpisode(store, identity);
  const appending = recorder.append({ type: 'prepared' });
  const closing = recorder.close();
  await Promise.resolve(); await Promise.resolve();
  expect(releases).toBe(0);
  await expect(recorder.append({ type: 'late' })).rejects.toThrow(/closed/i);
  finishSave(); await appending; await closing; await recorder.close(); expect(releases).toBe(1);
});

it('snapshots identity, events and usage before callers can mutate them', async () => {
  const { store } = workflowMemory(); const mutableIdentity = structuredClone(identity);
  const recorder = await openTraceEpisode(store, mutableIdentity);
  mutableIdentity.source.version = 'changed';
  const event = { type: 'turn.usage', usage: { inputTokens: 3, costMeaning: 'estimate' as const, perModel: { local: { outputTokens: 4 } } } };
  const saving = recorder.append(event); event.usage.inputTokens = 100; event.usage.perModel.local.outputTokens = 200; await saving;
  const episode = recorder.snapshot();
  expect(episode.identity.source.version).toBe('1');
  expect(episode.entries[0]!.usage).toEqual({ inputTokens: 3, costMeaning: 'estimate', perModel: { local: { outputTokens: 4 } } });
  expect(() => { (episode as TraceEpisode).identity.source.version = 'mutated'; }).toThrow();
  await recorder.close();
});

it('releases an initial failing sink and never returns a recorder', async () => {
  let released = 0;
  const store: TraceStore = { acquire: async () => ({ load: async () => undefined,
    save: async () => { throw new Error('disk failed'); }, release: async () => { released++; } }) };
  await expect(openTraceEpisode(store, identity)).rejects.toThrow('disk failed'); expect(released).toBe(1);
});

it('restores correlation from durable turn completion when the stream lacked start events', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  await recorder.observe({ type: 'turn.completed', turn: { id: 'turn-1', status: 'completed', text: '', events: [], warnings: [], providerMetadata: {},
    session: { schemaVersion: 1, id: 'session-1', provider: 'codex', transport: 'control', transportEpoch: 'epoch',
      cwd: '/', persistence: 'provider', createdAt: '2026-11-09T00:00:00Z' } } });
  await recorder.close();
  const next = await openTraceEpisode(store, identity);
  await next.observe({ type: 'message.delta', text: 'abc' });
  expect(next.snapshot().entries[1]).toMatchObject({ sessionId: 'session-1', turnId: 'turn-1', count: 3 });
  await next.close();
});

it('rejects invalid projected terminal states', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  await expect(recorder.observe({ type: 'turn.completed', turn: { id: 'turn-1', status: 'raw-secret-state',
    session: { id: 'session-1' } } } as never)).rejects.toThrow(/status/i);
  await recorder.close();
});

it('rejects array subclasses at public persistence boundaries', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  const valid = recorder.snapshot(); await recorder.close();
  class Entries extends Array {}
  const unsafe: TraceStore = { acquire: async () => ({ load: async () => ({ ...valid, entries: new Entries() }), save: async () => {}, release: async () => {} }) };
  await expect(readTraceEpisode(unsafe, identity.episodeId)).rejects.toThrow(/entries/i);
});

it('rejects episodes exceeding entry and byte bounds before trusting their checksum', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  const valid = recorder.snapshot(); await recorder.close();
  const load = (value: unknown): TraceStore => ({ acquire: async () => ({ load: async () => value, save: async () => {}, release: async () => {} }) });
  const entry = { type: 'observed', timestamp: valid.startedAt };
  await expect(readTraceEpisode(load({ ...valid, entries: Array.from({ length: 10_001 }, (_, index) => ({ ...entry, sequence: index + 1 })) }), identity.episodeId)).rejects.toThrow(/entries/i);
  const entries = Array.from({ length: 10_000 }, (_, index) => ({ ...entry, sequence: index + 1, code: 'x'.repeat(256), phaseId: 'x'.repeat(256) }));
  await expect(readTraceEpisode(load({ ...valid, entries }), identity.episodeId)).rejects.toThrow(/size limit/i);
});

it('rejects excess usage buckets and invalid costs without persisting the observation', async () => {
  const { store } = workflowMemory(); const recorder = await openTraceEpisode(store, identity);
  for (const usage of [{ costMeaning: 'estimate', reportedCostUsd: -1 }, { costMeaning: 'unavailable', outputTokens: 0.5 },
    { costMeaning: 'estimate', perModel: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`model-${i}`, { inputTokens: 1 }])) },
    { costMeaning: 'estimate', raw: 'CANARY' }]) {
    await expect(recorder.append({ type: 'usage', usage } as never)).rejects.toThrow(/usage/i);
  }
  expect(recorder.snapshot().entries).toHaveLength(0); await recorder.close();
});
