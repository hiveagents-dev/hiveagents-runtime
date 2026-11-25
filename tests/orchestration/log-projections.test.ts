import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { createRequiredLogCapture } from '../../src/orchestration/log/capture.js';
import { createLogTraceProjector } from '../../src/orchestration/log/trace-projector.js';
import { createLogAuditProjector } from '../../src/orchestration/log/audit-projector.js';
import { mergeLogProjectionPages } from '../../src/orchestration/log/projection.js';
import { createLogArtifactStore } from '../../src/orchestration/log/artifacts.js';
import type { LogDraft } from '../../src/orchestration/log/types.js';
const identity = { systemId: 'fixture', generation: 1, runId: 'run-secret', agentId: 'agent-secret', harness: { id: 'sdk', version: '1', digest: 'a'.repeat(64) } };
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function store() { const d = await mkdtemp(join(tmpdir(), 'oar-project-')); cleanup.push(() => rm(d, { recursive: true, force: true })); const s = new SqliteRunLogStore({ databasePath: join(d, 'log.sqlite'), systemId: 'fixture' }); cleanup.push(() => s.close()); return s; }
function draft(schema: string, type: string, inline: unknown): LogDraft { return { identity, schema: { id: schema, version: 1 }, type, causal: [], payload: { inline } } as LogDraft; }
it('rebuilds identical safe trace/audit positions and exact source head without reconstructing text', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'provider-secret', model: 'model-secret', attemptId: 'attempt-secret' } });
  await capture.run(async () => { await capture.observe({ type: 'message.completed', text: 'text-secret' }); });
  const trace = await createLogTraceProjector({ reader: log, identity }).rebuild(), audit = await createLogAuditProjector({ reader: log, identity }).rebuild();
  expect(trace.kind).toBe('observed'); expect(trace.items.map(e => e.position)).toEqual(audit.items.map(e => e.position)); expect(trace.through).toEqual((await log.readPage()).through);
  expect(trace).toMatchObject({ textReconstruction: 'unavailable', qualityAssessment: 'not-derived' });
  const json = JSON.stringify(trace); for (const secret of ['text-secret', 'provider-secret', 'model-secret', 'attempt-secret', 'run-secret', 'agent-secret']) expect(json).not.toContain(secret);
});
it('deduplicates replayed committed pages and rebuilds the identical source snapshot after a crash cursor', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => { await capture.observe({ type: 'turn.started' }); });
  const projector = createLogTraceProjector({ reader: log, identity }), first = await projector.read({ limit: 1 });
  const second = await projector.read({ limit: 1, cursor: first.nextCursor! }), third = await projector.read({ limit: 1, cursor: second.nextCursor! });
  const merged = mergeLogProjectionPages([second, first, first, third]); expect(merged).toEqual(await projector.rebuild({ limit: 1 })); expect(merged.items).toHaveLength(3);
  await expect(createLogAuditProjector({ reader: log, identity }).read({ cursor: first.nextCursor! })).rejects.toThrow();
});
it('retains unresolved decisions despite an optimistic observed terminal and never opens private recordJson', async () => {
  const log = await store(), h = 'b'.repeat(64);
  await log.append({ requestId: 'intent', records: [draft('oar.execution.decision', 'decision.intent', { kind: 'decision', key: h, revision: 1, recordJson: 'private-secret not even JSON', recordDigest: h,
    metadata: { kind: 'decision', decisionIdDigest: h, status: 'intent', attempts: 1, intentIdDigest: h, inputHash: h, authorityHash: h, inputVersionDigest: h, authorityVersionDigest: h } })] });
  const capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => {});
  const result = await createLogAuditProjector({ reader: log, identity }).rebuild(); expect(result.kind).toBe('awaiting-owner'); expect(JSON.stringify(result)).not.toContain('private-secret');
});
it('reports unknown schema, private artifact and unresolved cross-source ancestry explicitly without reading files', async () => {
  const log = await store(); const record = draft('future.schema', 'future', { privateSecret: 'secret' });
  await log.append({ requestId: 'future', records: [{ ...record, causal: [{ sourceId: 'other-source', sequence: 1, digest: 'b'.repeat(64) }] }] });
  const result = await createLogTraceProjector({ reader: log, identity }).rebuild(); expect(result.kind).toBe('incomplete'); expect(result.issues).toContain('UNKNOWN_SCHEMA'); expect(result.issues).toContain('UNRESOLVED_CAUSAL_REFERENCE'); expect(JSON.stringify(result)).not.toContain('privateSecret');
});
it('cannot hide integrity failures behind a different run filter', async () => {
  const log = await store(); const record = draft('future', 'future', {}); await log.append({ requestId: 'bad', records: [record] });
  const reader = { descriptor: log.descriptor, readPage: async () => { const page = await log.readPage(); return { ...page, items: page.items.map(e => ({ ...e, digest: 'f'.repeat(64) })) }; } };
  const result = await createLogTraceProjector({ reader, identity: { ...identity, runId: 'different' } }).rebuild(); expect(result.kind).toBe('corrupt'); expect(result.issues).toContain('LOG_CORRUPT');
});
it('reports bounded rebuild and missing initial coverage as incomplete instead of whole captured history', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => {});
  const projector = createLogTraceProjector({ reader: log, identity, maxPages: 1 }); const page = await projector.read({ limit: 1 });
  expect((await projector.rebuild({ limit: 1 })).issues).toContain('PROJECTION_LIMIT');
  const tail = await projector.read({ cursor: page.nextCursor!, limit: 1 }); expect(mergeLogProjectionPages([tail]).kind).toBe('incomplete');
});
it('treats a settled metadata invocation with missing start as incomplete origin', async () => {
  const log = await store(), h = 'b'.repeat(64);
  await log.append({ requestId: 'orphan', records: [draft('oar.sdk.capture-operation', 'capture.settled', { mode: 'metadata-only', invocationDigest: h, actual: { providerDigest: h, attemptDigest: h }, stage: 'settled', outcome: 'returned' })] });
  const result = await createLogTraceProjector({ reader: log, identity }).rebuild(); expect(result.kind).toBe('incomplete'); expect(result.issues).toContain('INCOMPLETE_ORIGIN');
});
it('does not accept seeded prose in fields of a malformed known metadata schema', async () => {
  const log = await store(), h = 'b'.repeat(64);
  await log.append({ requestId: 'bad-metadata', records: [draft('oar.sdk.agent-event-metadata', 'turn.completed', { mode: 'metadata-only', invocationDigest: h, actual: { providerDigest: h, attemptDigest: h }, event: { type: 'turn.completed' } })] });
  const result = await createLogTraceProjector({ reader: log, identity }).rebuild(); expect(result.issues).toContain('INVALID_METADATA');
});
it('never opens or verifies private artifacts while projecting a committed reference', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-private-project-'))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let artifacts!: Awaited<ReturnType<typeof createLogArtifactStore>>, reads = 0;
  const log = new SqliteRunLogStore({ databasePath: join(directory, 'log.sqlite'), systemId: 'fixture', payloadVerifier: { verify: (...args) => { reads++; return artifacts.verify(...args); } } }); cleanup.push(() => log.close());
  artifacts = await createLogArtifactStore({ directory: join(directory, 'blobs'), binding: { sourceId: log.sourceId, systemId: 'fixture', generation: 1 } });
  const ref = await artifacts.write('private-native-secret', { mediaType: 'application/octet-stream' });
  await log.append({ requestId: 'private', records: [{ ...draft('private.raw', 'raw', null), payload: { artifact: ref } }] }); const before = reads;
  const result = await createLogAuditProjector({ reader: log, identity }).rebuild(); expect(result.issues).toContain('PRIVATE_PAYLOAD'); expect(reads).toBe(before); expect(JSON.stringify(result)).not.toContain('private-native-secret');
});
it('rejects a proxy reader without executing traps', async () => {
  const log = await store(); let invoked = false;
  const reader = new Proxy(log, { getOwnPropertyDescriptor() { invoked = true; throw Error('secret'); } });
  expect(() => createLogTraceProjector({ reader, identity })).toThrow(); expect(invoked).toBe(false);
});
it('rejects getters in restored pages without executing them', async () => {
  const log = await store(); let invoked = false;
  const capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => {});
  const page = await createLogTraceProjector({ reader: log, identity }).read(); const copy = structuredClone(page);
  Object.defineProperty(copy.items[0]!, 'metadata', { get() { invoked = true; return {}; } });
  expect(() => mergeLogProjectionPages([copy])).toThrow(); expect(invoked).toBe(false);
});
it('enforces the operator event bound before returning a projection', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => {});
  const result = await createLogTraceProjector({ reader: log, identity, maxEntries: 1 }).rebuild(); expect(result.items).toHaveLength(1); expect(result.issues).toContain('PROJECTION_LIMIT');
});
it('does not invoke traps in a source page array or restored workflow steps', async () => {
  const log = await store(); let invoked = false;
  const capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => {});
  const reader = { descriptor: log.descriptor, readPage: async () => { const page = await log.readPage(); return { ...page, items: new Proxy(page.items, { get() { invoked = true; throw Error('private'); } }) }; } };
  expect((await createLogTraceProjector({ reader, identity }).rebuild()).kind).toBe('corrupt'); expect(invoked).toBe(false);
  const h = 'b'.repeat(64); await log.append({ requestId: 'workflow', records: [draft('oar.execution.workflow', 'workflow.running', { kind: 'workflow', key: h, revision: 1, recordDigest: h, recordJson: 'private', metadata: { kind: 'workflow', workflowIdDigest: h, workflowVersionDigest: h, fingerprint: h, status: 'running', steps: [] } })] });
  const page = structuredClone(await createLogTraceProjector({ reader: log, identity }).read());
  const metadata = page.items.at(-1)!.metadata as Record<string, unknown>; metadata.steps = new Proxy([], { get() { invoked = true; throw Error('private'); } });
  expect(() => mergeLogProjectionPages([page])).toThrow(); expect(invoked).toBe(false);
});
it('keeps arbitrary causal source labels private while preserving a digest-bound join', async () => {
  const log = await store(); await log.append({ requestId: 'causal-secret', records: [{ ...draft('future', 'future', null), causal: [{ sourceId: 'seeded-causal-credential', sequence: 1, digest: 'b'.repeat(64) }] }] });
  const result = await createLogTraceProjector({ reader: log, identity }).rebuild(); expect(JSON.stringify(result)).not.toContain('seeded-causal-credential'); expect(result.items[0]!.causal[0]).toHaveProperty('sourceIdDigest');
});
it('does not invoke traps on an unknown source error object', async () => {
  const log = await store(); let invoked = false;
  const error = new Proxy({}, { getOwnPropertyDescriptor() { invoked = true; throw Error('private-error'); } });
  const reader = { descriptor: log.descriptor, readPage: async () => { throw error; } };
  const result = await createLogTraceProjector({ reader, identity }).rebuild(); expect(result.kind).toBe('corrupt'); expect(invoked).toBe(false);
});
it('resumes a JSON cursor against its original head after concurrent source appends', async () => {
  const log = await store(), capture = createRequiredLogCapture({ store: log, identity, actual: { provider: 'p', attemptId: 'a' } }); await capture.run(async () => {});
  const projector = createLogTraceProjector({ reader: log, identity }), expected = await projector.rebuild({ limit: 1 }), first = await projector.read({ limit: 1 });
  await log.append({ requestId: 'after-snapshot', records: [draft('future', 'future', null)] });
  const next = await projector.read({ limit: 1, cursor: JSON.parse(JSON.stringify(first.nextCursor)) });
  expect(mergeLogProjectionPages([first, next])).toEqual(expected); expect(next.through).not.toEqual((await log.readPage()).through);
});
