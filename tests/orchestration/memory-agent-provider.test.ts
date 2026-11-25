import { describe, expect, it } from 'vitest';
import { memoryProviderFromPorts } from '../../src/orchestration/memory/index.js';
import type {
  MemoryPersistencePort, MemoryQuery, MemoryQueryPort, ScopedMemoryRecord,
} from '../../src/orchestration/memory/index.js';
import { CAPTURED_AT, IDENTITY, captureRequest, completedTurn, hanging, letterEmbedder, recallRequest } from './memory-agent-fixture.js';
import { episode, scopeOf } from './memory-store-fixture.js';

/** Deterministic fakes only: these tests check what the adapter does with any port, honest or not. */
const scope = scopeOf('grow', 'support', 'cliente-42');

function fakePort(records: readonly ScopedMemoryRecord[], queries: MemoryQuery[] = []): MemoryQueryPort {
  return { async query(query) { queries.push(query); return records; } };
}
function fakeStore(puts: ScopedMemoryRecord[] = []): MemoryPersistencePort {
  return {
    async put(record, signal) { signal?.throwIfAborted(); puts.push(record); },
    async revoke() { throw new Error('not used'); },
  };
}
const at = (id: string, where = scope, extra: Partial<ScopedMemoryRecord> = {}) => episode('grow', id, `nota ${id}`, { scope: where, ...extra });

describe('memoryProviderFromPorts options', () => {
  it('needs at least one port and offers only the methods its ports support', () => {
    expect(() => memoryProviderFromPorts({})).toThrow(TypeError);
    expect(() => memoryProviderFromPorts({ recall: {} as MemoryQueryPort })).toThrow(TypeError);
    expect(() => memoryProviderFromPorts({ recall: fakePort([]), id: ' spaced ' })).toThrow(TypeError);
    expect(() => memoryProviderFromPorts({ recall: fakePort([]), embedder: letterEmbedder({ ...IDENTITY, dimensions: 0 }) }))
      .toThrow(TypeError);

    const reader = memoryProviderFromPorts({ recall: fakePort([]) });
    const writer = memoryProviderFromPorts({ persistence: fakeStore() });
    expect(reader.id).toBe('memory-ports');
    expect(typeof reader.recall).toBe('function');
    expect('capture' in reader).toBe(false);
    expect(typeof writer.capture).toBe('function');
    expect('recall' in writer).toBe(false);
  });
});

describe('memoryProviderFromPorts recall', () => {
  it('asks the port for the exact scope, the limit and the bounded text, and nothing else', async () => {
    const queries: MemoryQuery[] = [];
    const provider = memoryProviderFromPorts({ recall: fakePort([], queries) });
    const request = recallRequest({ ...scope }, 'x'.repeat(5000), { limit: 3 });

    await provider.recall!(request);

    expect(Object.keys(queries[0]!).sort()).toEqual(['limit', 'scope', 'signal', 'text']);
    expect(queries[0]).toMatchObject({ scope, limit: 3, signal: request.signal });
    expect(queries[0]!.text).toHaveLength(4096);
  });

  it('filters foreign-scope, revoked, malformed and duplicate records and never exceeds the limit', async () => {
    const records = [
      at('foreign', scopeOf('grow', 'support', 'cliente-7')),
      at('other-tenant', scopeOf('marketing', 'support', 'cliente-42')),
      at('no-subject', scopeOf('grow', 'support')),
      at('revoked', scope, { revokedAt: '2026-11-10T11:00:00.000Z' }),
      { id: 'broken', scope } as unknown as ScopedMemoryRecord,
      at('first'),
      at('first'),
      at('second', scope, { metadata: { title: 42 } }),
      at('third'),
    ];
    const provider = memoryProviderFromPorts({ recall: fakePort(records) });

    const recalled = await provider.recall!(recallRequest(scope, 'nota', { limit: 2 }));

    expect(recalled).toEqual([
      { id: 'first', text: 'nota first', source: 'operator-note', observedAt: '2026-11-10T10:00:00.000Z' },
      { id: 'second', text: 'nota second', source: 'operator-note', observedAt: '2026-11-10T10:00:00.000Z' },
    ]);
  });

  it('does not ask the port at all for a zero limit', async () => {
    const queries: MemoryQuery[] = [];
    const provider = memoryProviderFromPorts({ recall: fakePort([at('a')], queries) });

    expect(await provider.recall!(recallRequest(scope, 'nota', { limit: 0 }))).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('sends the query embedding under the embedder identity', async () => {
    const queries: MemoryQuery[] = [];
    const calls: string[][] = [];
    const provider = memoryProviderFromPorts({ recall: fakePort([], queries), embedder: letterEmbedder(IDENTITY, calls) });

    await provider.recall!(recallRequest(scope, 'paga a treinta'));

    expect(calls).toEqual([['paga a treinta']]);
    expect(queries[0]!.embedding).toEqual({ identity: IDENTITY, values: [4, 1, 0] });
  });

  it.each([
    ['too few dimensions', [[1, 2]]],
    ['too many dimensions', [[1, 2, 3, 4]]],
    ['a non-finite value', [[1, Number.NaN, 3]]],
    ['an infinite value', [[1, Number.POSITIVE_INFINITY, 3]]],
    ['no vector', []],
    ['two vectors for one text', [[1, 2, 3], [1, 2, 3]]],
  ])('rejects an embedder returning %s before asking the port', async (_, vectors) => {
    const queries: MemoryQuery[] = [];
    const embedder = { identity: IDENTITY, embed: async () => vectors };
    const provider = memoryProviderFromPorts({ recall: fakePort([at('a')], queries), embedder });

    await expect(provider.recall!(recallRequest(scope, 'nota'))).rejects.toThrow(RangeError);
    expect(queries).toEqual([]);
  });

  it('propagates an abort: before the call, and while a port ignores its signal', async () => {
    const queries: MemoryQuery[] = [];
    const provider = memoryProviderFromPorts({ recall: fakePort([at('a')], queries) });
    const reason = new Error('recall deadline');
    const aborted = new AbortController();
    aborted.abort(reason);

    await expect(provider.recall!(recallRequest(scope, 'nota', { signal: aborted.signal }))).rejects.toBe(reason);
    expect(queries).toEqual([]);

    const controller = new AbortController();
    const stuck = memoryProviderFromPorts({ recall: { query: () => hanging() } });
    const pending = stuck.recall!(recallRequest(scope, 'nota', { signal: controller.signal }));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('propagates an abort while the embedder runs', async () => {
    const controller = new AbortController();
    const reason = new Error('turn cancelled');
    const provider = memoryProviderFromPorts({ recall: fakePort([]), embedder: { identity: IDENTITY, embed: () => hanging() } });

    const pending = provider.recall!(recallRequest(scope, 'nota', { signal: controller.signal }));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

describe('memoryProviderFromPorts capture', () => {
  it('builds one episode per completed turn with provenance and bounded metadata, no secrets or events', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const provider = memoryProviderFromPorts({ persistence: fakeStore(puts), now: () => new Date('2026-11-10T12:30:00.000Z') });

    await provider.capture!(captureRequest(scope));

    const [record] = puts;
    expect(record!.id).toMatch(/^agent-turn-[a-f0-9]{64}$/);
    expect(record!.scope).toEqual(scope);
    expect(record!.text).toBe('User:\n¿Cuándo paga el cliente?\n\nAssistant:\nEl cliente paga a treinta días.');
    expect(record!.provenance).toEqual({
      source: 'agent-turn', sourceVersion: 'claude/claude-test', observedAt: CAPTURED_AT,
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(record!.metadata).toEqual({ provider: 'claude', transport: 'exec', sessionId: 'session-1', turnId: 'turn-1' });
    expect(JSON.stringify(record)).not.toMatch(/never-stored|secret-looking/);
    expect(record!.embedding).toBeUndefined();
  });

  it('derives the id from session and turn, or from the content when the turn has no id', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const provider = memoryProviderFromPorts({ persistence: fakeStore(puts) });
    const anonymous = completedTurn({ id: undefined } as never);
    delete (anonymous as { id?: string }).id;

    await provider.capture!(captureRequest(scope));
    await provider.capture!(captureRequest(scope, { input: 'otra pregunta' }));
    await provider.capture!(captureRequest(scope, { turn: completedTurn({}, { sessionId: 'native-2' }) }));
    await provider.capture!(captureRequest(scope, { turn: anonymous }));
    await provider.capture!(captureRequest(scope, { turn: anonymous }));
    await provider.capture!(captureRequest(scope, { turn: anonymous, input: 'otra pregunta' }));

    const ids = puts.map(record => record.id);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[4]).toBe(ids[3]);
    expect(new Set([ids[0], ids[2], ids[3], ids[5]]).size).toBe(4);
  });

  it('bounds the episode text to the store limit and keeps both sides of a long turn', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const provider = memoryProviderFromPorts({ persistence: fakeStore(puts) });

    await provider.capture!(captureRequest(scope, { input: 'q'.repeat(9000), turn: completedTurn({ text: 'r'.repeat(9000) }) }));
    await provider.capture!(captureRequest(scope, { input: 'corta', turn: completedTurn({ id: 't2', text: `${'r'.repeat(6098)}😀` }) }));

    expect(puts[0]!.text.length).toBeLessThanOrEqual(8192);
    expect(puts[0]!.text).toMatch(/^User:\nq{3000,}\n\nAssistant:\nr{3000,}$/);
    expect(puts[1]!.text.length).toBeLessThanOrEqual(8192);
    expect(puts[1]!.text).toContain('corta');
    expect(puts[1]!.text.endsWith('\ud83d')).toBe(false);
  });

  it('stores nothing for a turn that did not complete or said nothing', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const provider = memoryProviderFromPorts({ persistence: fakeStore(puts) });

    await provider.capture!(captureRequest(scope, { turn: completedTurn({ status: 'failed' }) }));
    await provider.capture!(captureRequest(scope, { input: ' ', turn: completedTurn({ text: '' }) }));

    expect(puts).toEqual([]);
  });

  it('adds the embedder vector of the stored text', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const calls: string[][] = [];
    const provider = memoryProviderFromPorts({ persistence: fakeStore(puts), embedder: letterEmbedder(IDENTITY, calls) });

    await provider.capture!(captureRequest(scope));

    expect(calls).toEqual([[puts[0]!.text]]);
    expect(puts[0]!.embedding?.identity).toEqual(IDENTITY);
    expect(puts[0]!.embedding?.values).toHaveLength(3);
  });

  it('uses toRecord instead of the default, stores nothing when it returns undefined, and refuses another scope', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const seen: string[] = [];
    const custom = memoryProviderFromPorts({
      persistence: fakeStore(puts),
      toRecord: async request => {
        seen.push(request.input);
        return request.input === 'skip' ? undefined : episode('grow', 'custom', `resumen: ${request.turn.text}`, { scope: request.scope });
      },
    });
    const escaping = memoryProviderFromPorts({
      persistence: fakeStore(puts), toRecord: () => at('escape', scopeOf('grow', 'support', 'cliente-7')),
    });

    await custom.capture!(captureRequest(scope));
    await custom.capture!(captureRequest(scope, { input: 'skip' }));
    await expect(escaping.capture!(captureRequest(scope))).rejects.toThrow(TypeError);

    expect(seen).toEqual(['¿Cuándo paga el cliente?', 'skip']);
    expect(puts.map(record => [record.id, record.text])).toEqual([['custom', 'resumen: El cliente paga a treinta días.']]);
  });

  it('propagates an abort: before the write, and while the store ignores its signal', async () => {
    const puts: ScopedMemoryRecord[] = [];
    const reason = new Error('session closed');
    const aborted = new AbortController();
    aborted.abort(reason);
    const provider = memoryProviderFromPorts({ persistence: fakeStore(puts) });

    await expect(provider.capture!(captureRequest(scope, { signal: aborted.signal }))).rejects.toBe(reason);
    expect(puts).toEqual([]);

    const controller = new AbortController();
    const stuck = memoryProviderFromPorts({ persistence: { put: () => hanging(), revoke: () => hanging() } });
    const pending = stuck.capture!(captureRequest(scope, { signal: controller.signal }));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
