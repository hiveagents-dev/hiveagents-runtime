import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileWorkflowStore } from '../../src/orchestration/workflow/file-store.js';
import { openTraceEpisode, readTraceEpisode, WorkflowTraceStore,
  type TraceIdentity, type TraceEpisode, type TraceStore } from '../../src/orchestration/tracing/index.js';
import type { AgentEvent } from '../../src/public/types.js';

const digest = 'a'.repeat(64);
const identity: TraceIdentity = { episodeId: 'episode-one', task: { id: 'case', version: '1', inputDigest: digest },
  source: { id: 'source', version: '1', digest }, profile: { id: 'local', version: '1', digest } };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fileStore() {
  const parent = await mkdtemp(join(tmpdir(), 'oar-trace-')); directories.push(parent);
  const directory = join(parent, 'private');
  return { directory, store: () => new WorkflowTraceStore(new FileWorkflowStore(directory)) };
}

it('durably orders concurrent appends, resumes the same identity and writes private files', async () => {
  const { directory, store } = await fileStore();
  const recorder = await openTraceEpisode(store(), identity);
  await Promise.all([recorder.append({ type: 'dispatch.prepared', phaseId: 'phase-1' }), recorder.append({ type: 'dispatch.started', count: 1 })]);
  expect(recorder.snapshot().entries.map(entry => entry.sequence)).toEqual([1, 2]);
  await recorder.close();
  const next = await openTraceEpisode(store(), identity);
  await next.append({ type: 'dispatch.verified', code: 'verified' });
  const finished = await next.finish('completed');
  expect(finished.status).toBe('completed');
  expect(finished.entries.map(entry => entry.type)).toEqual(['dispatch.prepared', 'dispatch.started', 'dispatch.verified']);
  await next.close(); await next.close();
  expect(await readTraceEpisode(store(), identity.episodeId)).toEqual(finished);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
});

it('projects event types, correlation and validated usage without retaining raw canaries', async () => {
  const { directory, store } = await fileStore();
  const recorder = await openTraceEpisode(store(), identity);
  const canary = 'CANARY_RAW_SECRET_do_not_persist';
  const events: AgentEvent[] = [
    { type: 'session.started', session: { schemaVersion: 1, provider: 'codex', transport: 'control', id: 'session-1', cwd: '/', persistence: 'provider', createdAt: '2026-11-09T00:00:00Z' } },
    { type: 'turn.started', turnId: 'turn-1' },
    { type: 'message.delta', text: canary },
    { type: 'tool.started', id: 'tool-1', name: canary, input: { prompt: canary } },
    { type: 'tool.updated', id: 'tool-1', update: canary },
    { type: 'tool.completed', id: 'tool-1', output: canary, error: new Error(canary) },
    { type: 'provider.event', provider: 'codex', event: { raw: canary } },
    { type: 'turn.completed', turn: { id: 'turn-1', session: { schemaVersion: 1, provider: 'codex', transport: 'control', id: 'session-1', transportEpoch: 'epoch-1', cwd: '/', persistence: 'provider', createdAt: '2026-11-09T00:00:00Z' },
      status: 'completed', text: canary, output: { secret: canary }, events: [], warnings: [{ code: 'x', message: canary }],
      providerMetadata: canary, usage: { inputTokens: 4, outputTokens: 2, costMeaning: 'unavailable' } } },
  ];
  for (const event of events) await recorder.observe(event);
  const trace = await recorder.finish('completed'); await recorder.close();
  expect(trace.entries.map(entry => entry.type)).toEqual(events.map(event => event.type));
  expect(trace.entries[2]).toMatchObject({ count: canary.length, sessionId: 'session-1', turnId: 'turn-1' });
  expect(trace.entries[3]).toMatchObject({ toolId: 'tool-1' });
  expect(trace.entries.at(-1)).toMatchObject({ status: 'completed', usage: { inputTokens: 4, outputTokens: 2, costMeaning: 'unavailable' } });
  const contents = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('');
  expect(contents).not.toContain(canary);
  expect(contents).not.toContain('providerMetadata');
});

it('rejects conflicting owners, changed identity and all writes after a terminal episode', async () => {
  const { store } = await fileStore();
  const recorder = await openTraceEpisode(store(), identity);
  await expect(openTraceEpisode(store(), identity)).rejects.toThrow(/owned|locked/i);
  await recorder.close();
  await expect(openTraceEpisode(store(), { ...identity, source: { ...identity.source, version: '2' } })).rejects.toThrow(/identity/i);
  const resumed = await openTraceEpisode(store(), identity);
  await resumed.finish('failed');
  await expect(resumed.append({ type: 'late' })).rejects.toThrow(/finished|terminal/i);
  await expect(resumed.finish('completed')).rejects.toThrow(/finished|terminal/i);
  await resumed.close();
  await expect(openTraceEpisode(store(), identity)).rejects.toThrow(/finished|terminal/i);
});

function memoryStore(value?: unknown): { store: TraceStore; state: () => unknown } {
  let current = value;
  return { store: { acquire: async () => ({ load: async () => current, save: async episode => { current = structuredClone(episode); }, release: async () => {} }) },
    state: () => current };
}
function rehash(value: TraceEpisode): TraceEpisode {
  const canonical = (item: unknown): string => item === null || typeof item !== 'object' ? JSON.stringify(item)
    : Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
      : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
  const { digest: _digest, ...body } = value;
  return { ...body, digest: createHash('sha256').update(canonical(body)).digest('hex') };
}

it('validates loaded digest, sequence, bounds and unknown fields independently of checksums', async () => {
  const memory = memoryStore();
  const recorder = await openTraceEpisode(memory.store, identity);
  await recorder.append({ type: 'one' }); await recorder.close();
  const valid = structuredClone(memory.state()) as TraceEpisode;
  const corruptions = [
    { ...valid, digest: 'b'.repeat(64) },
    rehash({ ...valid, entries: [{ ...valid.entries[0]!, sequence: 2 }] }),
    rehash({ ...valid, entries: [{ ...valid.entries[0]!, count: -1 }] }),
    rehash({ ...valid, entries: [{ ...valid.entries[0]!, prompt: 'secret' }] } as unknown as TraceEpisode),
    rehash({ ...valid, status: 'completed' }),
  ];
  for (const value of corruptions) await expect(readTraceEpisode(memoryStore(value).store, identity.episodeId)).rejects.toThrow(/trace|digest|sequence|field|timestamp/i);
});

it('rejects arbitrary metadata and malformed bounds before replacing durable state', async () => {
  const memory = memoryStore(); const recorder = await openTraceEpisode(memory.store, identity);
  const initial = recorder.snapshot();
  for (const event of [{ type: 'ok', input: 'secret' }, { type: '' }, { type: 'x'.repeat(257) },
    { type: 'x', count: Infinity }, { type: 'x', count: -1 }, { type: 'x', usage: { inputTokens: -1, costMeaning: 'estimate' } }]) {
    await expect(recorder.append(event as never)).rejects.toThrow();
  }
  expect(recorder.snapshot()).toEqual(initial);
  expect(memory.state()).toEqual(initial);
  await recorder.close();
  await expect(openTraceEpisode(memoryStore().store, { ...identity, task: { ...identity.task, inputDigest: 'invalid' } })).rejects.toThrow();
});

it('makes sink failure fatal for later appends without claiming a durable event', async () => {
  let writes = 0; let saved: TraceEpisode | undefined;
  const store: TraceStore = { acquire: async () => ({ load: async () => undefined,
    save: async value => { writes++; if (writes > 1) throw new Error('disk failed'); saved = value; }, release: async () => {} }) };
  const recorder = await openTraceEpisode(store, identity);
  await expect(recorder.append({ type: 'dispatch.prepared' })).rejects.toThrow('disk failed');
  await expect(recorder.append({ type: 'dispatch.started' })).rejects.toThrow('disk failed');
  await expect(recorder.finish('failed')).rejects.toThrow('disk failed');
  expect(writes).toBe(2);
  expect(recorder.snapshot()).toEqual(saved);
  await recorder.close();
});
