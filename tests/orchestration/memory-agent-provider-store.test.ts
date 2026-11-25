import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryProviderFromPorts } from '../../src/orchestration/memory/index.js';
import type { MemoryScope } from '../../src/orchestration/memory/index.js';
import { measureMemory } from '../../src/orchestration/memory/system.js';
import type { SqliteSystemMemory } from '../../src/orchestration/memory/system.js';
import { CAPTURED_AT, IDENTITY, captureRequest, completedTurn, letterEmbedder, recallRequest } from './memory-agent-fixture.js';
import { episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

/**
 * End to end over a real `SqliteSystemMemory`: the adapter recalls only what the
 * gate promoted, in the exact scope asked, and capture adds episodes that stay
 * out of recall until the application promotes them.
 */
const scope = scopeOf('grow', 'support', 'cliente-42');
const other = scopeOf('grow', 'support', 'cliente-7');
const fixedNow = () => new Date('2026-11-10T12:30:00.000Z');

let workspace: ReturnType<typeof memoryWorkspace>;
let store: SqliteSystemMemory;
beforeEach(async () => {
  workspace = memoryWorkspace();
  store = workspace.open('grow');
  await store.enable({ by: 'operator' });
});
afterEach(() => { workspace.cleanup(); });

async function lesson(where: MemoryScope, id: string, text: string, extra: Parameters<typeof episode>[3] = {}): Promise<void> {
  await store.put(episode('grow', id, text, { scope: where, ...extra }));
  const result = await store.promote({ scope: where, id, gate: await gateFor(store, where, id), by: 'consolidacion' });
  expect(result.promoted).toBe(true);
}

describe('memoryProviderFromPorts over SqliteSystemMemory: recall', () => {
  it('returns promoted lessons only, mapped to recalled items', async () => {
    await lesson(scope, 'l1', 'el cliente paga a treinta días', { metadata: { title: 'Plazo de pago' } });
    await store.put(episode('grow', 'e1', 'el cliente paga tarde a veces', { scope }));
    const provider = memoryProviderFromPorts({ id: 'sqlite-system-memory', recall: store });

    const recalled = await provider.recall!(recallRequest(scope, '¿cuándo paga el cliente?'));

    expect(provider.id).toBe('sqlite-system-memory');
    expect(recalled).toEqual([{
      id: 'l1', text: 'el cliente paga a treinta días', title: 'Plazo de pago',
      source: 'operator-note', observedAt: '2026-11-10T10:00:00.000Z',
    }]);
  });

  it('respects the limit and the exact scope', async () => {
    for (const id of ['a', 'b', 'c']) await lesson(scope, id, `el cliente paga, nota ${id}`);
    await lesson(other, 'x', 'el cliente paga, otro cliente');
    await lesson(scopeOf('grow', 'support'), 'y', 'el cliente paga, sin sujeto');
    const provider = memoryProviderFromPorts({ recall: store });

    const two = await provider.recall!(recallRequest(scope, 'cliente paga', { limit: 2 }));
    const all = await provider.recall!(recallRequest(scope, 'cliente paga', { limit: 8 }));

    expect(two).toHaveLength(2);
    expect(all.map(item => item.id).sort()).toEqual(['a', 'b', 'c']);
    expect((await provider.recall!(recallRequest(other, 'cliente paga'))).map(item => item.id)).toEqual(['x']);
  });

  it('stops returning a lesson once it is revoked', async () => {
    await lesson(scope, 'l1', 'el cliente paga a treinta días');
    const provider = memoryProviderFromPorts({ recall: store });
    expect(await provider.recall!(recallRequest(scope, 'cliente paga'))).toHaveLength(1);

    await store.revoke({ scope, id: 'l1', revokedAt: '2026-11-10T13:00:00.000Z', reason: 'pedido del operador' });

    expect(await provider.recall!(recallRequest(scope, 'cliente paga'))).toEqual([]);
  });

  it('recalls with a matching embedder and is refused by the store under another identity', async () => {
    const embedder = letterEmbedder();
    const values = (await embedder.embed(['el cliente paga a treinta días']))[0]!;
    await lesson(scope, 'l1', 'el cliente paga a treinta días', { embedding: { identity: IDENTITY, values } });

    const matching = memoryProviderFromPorts({ recall: store, embedder });
    expect((await matching.recall!(recallRequest(scope, 'cliente paga'))).map(item => item.id)).toEqual(['l1']);

    const otherModel = memoryProviderFromPorts({ recall: store, embedder: letterEmbedder({ ...IDENTITY, model: 'otro' }) });
    await expect(otherModel.recall!(recallRequest(scope, 'cliente paga'))).rejects.toMatchObject({ code: 'EMBEDDING_MISMATCH' });
  });
});

describe('memoryProviderFromPorts over SqliteSystemMemory: capture', () => {
  it('stores one episode per turn that recall does not return until it is promoted', async () => {
    const provider = memoryProviderFromPorts({ recall: store, persistence: store, captureGate: 'store-promotes', now: fixedNow });

    await provider.capture!(captureRequest(scope));

    const [view] = await store.list({ scope });
    expect(view).toMatchObject({ state: 'episode', record: { scope, provenance: { source: 'agent-turn', sourceVersion: 'claude/claude-test' } } });
    expect(view!.record.text).toContain('¿Cuándo paga el cliente?');
    expect(view!.record.text).toContain('El cliente paga a treinta días.');
    expect(await provider.recall!(recallRequest(scope, 'cuándo paga el cliente'))).toEqual([]);

    // The application's promotion workflow: measure against both controls, then promote with that evidence.
    const report = await measureMemory({
      id: 'medicion-captura',
      tasks: [{ id: 'plazo', input: 'treinta días' }],
      candidateDigests: [view!.contentDigest],
      recall: () => [view!.record.text],
      history: () => [view!.record.text, 'todo lo demás'],
      run: (task, run) => ({ passed: run.context.some(item => item.includes(task.input as string)) }),
    });
    expect(report.verdict).toEqual({ passed: true });
    expect(await store.promote({ scope, id: view!.record.id, gate: report.gate, by: 'consolidacion' }))
      .toMatchObject({ promoted: true });

    const recalled = await provider.recall!(recallRequest(scope, 'cuándo paga el cliente'));
    expect(recalled).toEqual([{
      id: view!.record.id, text: view!.record.text, source: 'agent-turn', observedAt: CAPTURED_AT,
    }]);
  });

  it('captures the same turn twice without a conflict: same id, one episode', async () => {
    const provider = memoryProviderFromPorts({ persistence: store, now: fixedNow });

    await provider.capture!(captureRequest(scope));
    await provider.capture!(captureRequest(scope));
    await provider.capture!(captureRequest(scope, { turn: completedTurn({ id: 'turn-2' }) }));

    const views = await store.list({ scope });
    expect(views).toHaveLength(2);
    expect(new Set(views.map(view => view.record.id)).size).toBe(2);
  });

  it('stores the episode with the embedder\'s vector, which recall can then compare', async () => {
    const embedder = letterEmbedder();
    const provider = memoryProviderFromPorts({ recall: store, persistence: store, captureGate: 'store-promotes', embedder, now: fixedNow });

    await provider.capture!(captureRequest(scope));

    const [view] = await store.list({ scope });
    expect(view!.record.embedding?.identity).toEqual(IDENTITY);
    expect(view!.record.embedding?.values).toEqual((await embedder.embed([view!.record.text]))[0]);
    await store.promote({ scope, id: view!.record.id, gate: await gateFor(store, scope, view!.record.id), by: 'x' });
    expect(await provider.recall!(recallRequest(scope, 'cuándo paga el cliente'))).toHaveLength(1);
  });

  it('captures a retried request as the same episode even when the clock has moved on', async () => {
    let clock = Date.parse('2026-11-10T12:30:00.000Z');
    const provider = memoryProviderFromPorts({ persistence: store, now: () => new Date(clock) });
    const request = captureRequest(scope);
    await provider.capture!(request);
    clock += 60_000;
    // The SDK stamps completedAt once per turn; the store's content digest depends on it, not on the clock.
    await expect(provider.capture!(request)).resolves.toBeUndefined();
  });

  it('captures an exchange repeated in one session, on a turn without id, as its own episode (review R3b-2)', async () => {
    // Claude exec turns carry no turn id: the default id then comes from the exchange, and the
    // same exchange later in the session has another completedAt. It used to land on the same id
    // with other content, which SqliteSystemMemory refuses as CONFLICT, a capture failure.
    const provider = memoryProviderFromPorts({ persistence: store, now: fixedNow });
    const turn = completedTurn({ id: undefined as never });
    const first = captureRequest(scope, { input: 'continúa', turn, completedAt: '2026-11-15T12:00:00.000Z' });
    const later = captureRequest(scope, { input: 'continúa', turn, completedAt: '2026-11-15T12:00:05.000Z' });

    await provider.capture!(first);
    await expect(provider.capture!(later)).resolves.toBeUndefined();
    // A retried capture of the same request carries the same completedAt: still one episode for it.
    await provider.capture!(first);

    const views = await store.list({ scope });
    expect(views.map(view => view.record.provenance.observedAt).sort())
      .toEqual(['2026-11-15T12:00:00.000Z', '2026-11-15T12:00:05.000Z']);
    for (const view of views) expect(view.record.metadata).not.toHaveProperty('turnId');
  });

  it('lets the store refuse a capture outside the system\'s own tenant', async () => {
    const provider = memoryProviderFromPorts({ persistence: store, now: fixedNow });

    await expect(provider.capture!(captureRequest(scopeOf('marketing', 'support'))))
      .rejects.toMatchObject({ code: 'NOT_OWNER' });
  });
});
