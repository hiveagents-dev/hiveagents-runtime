import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { evaluateMemoryGate } from '../../src/orchestration/memory/index.js';
import { HASH, episode, gateFor, memoryWorkspace, passingGate, scopeOf } from './memory-store-fixture.js';

let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

const scope = scopeOf('grow');
async function withEpisode(id = 'e1', text = 'ofrecer factura en pesos') {
  const memory = workspace.open('grow');
  await memory.enable({ by: 'operator' });
  await memory.put(episode('grow', id, text));
  return memory;
}
const recall = (memory: Awaited<ReturnType<typeof withEpisode>>, limit = 5) =>
  memory.query({ scope, text: 'factura', limit });

describe('promotion with a gate', () => {
  it('keeps an observation as an episode that recall does not return', async () => {
    const memory = await withEpisode();

    expect(await recall(memory)).toEqual([]);
    const [view] = await memory.list({ scope });
    expect(view).toMatchObject({ state: 'episode', record: { id: 'e1' } });
    expect(view!.promotion).toBeUndefined();
  });

  it('turns an episode into a recallable lesson only through a gate that passed', async () => {
    const memory = await withEpisode();
    const gate = await gateFor(memory, scope, 'e1');

    const result = await memory.promote({ scope, id: 'e1', gate, by: 'consolidacion' });

    expect(result.promoted).toBe(true);
    expect((await recall(memory)).map(record => record.id)).toEqual(['e1']);
    const [view] = await memory.list({ scope });
    expect(view).toMatchObject({ state: 'lesson', promotion: { promotedBy: 'consolidacion', gate } });
    expect(Date.parse(view!.promotion!.promotedAt)).not.toBeNaN();
    // A retry is idempotent and keeps the first promotion.
    const again = await memory.promote({ scope, id: 'e1', gate, by: 'otro' });
    expect(again).toEqual(result);
    expect((await memory.list({ scope }))[0]!.promotion!.promotedBy).toBe('consolidacion');
  });

  it('refuses a comparison in which memory does not beat the no-memory control', async () => {
    const memory = await withEpisode();
    const measured = await gateFor(memory, scope, 'e1');
    const tie = { ...measured, memory: { passed: 1, total: 4 } };
    const worse = { ...measured, memory: { passed: 0, total: 4 } };

    expect(await memory.promote({ scope, id: 'e1', gate: tie, by: 'x' })).toEqual({ promoted: false, reason: 'NO_GAIN_OVER_NO_MEMORY' });
    expect(await memory.promote({ scope, id: 'e1', gate: worse, by: 'x' })).toEqual({ promoted: false, reason: 'NO_GAIN_OVER_NO_MEMORY' });
    expect(await recall(memory)).toEqual([]);
    expect((await memory.list({ scope }))[0]!.state).toBe('episode');
  });

  it('refuses a measurement that did not test this record', async () => {
    const memory = await withEpisode();

    expect(await memory.promote({ scope, id: 'e1', gate: passingGate(HASH), by: 'x' })).toEqual({ promoted: false, reason: 'CANDIDATE_NOT_MEASURED' });
    expect(await recall(memory)).toEqual([]);
  });

  it('rejects evidence that lacks either control or compares different task sets', async () => {
    const memory = await withEpisode();
    const gate = await gateFor(memory, scope, 'e1');
    const { fullHistory: _f, ...withoutFullHistory } = gate;
    const { noMemory: _n, ...withoutNoMemory } = gate;
    const invalid = [
      withoutFullHistory,
      withoutNoMemory,
      { ...gate, fullHistory: { passed: 3, total: 5 } },
      { ...gate, noMemory: { passed: 0, total: 0 }, memory: { passed: 0, total: 0 }, fullHistory: { passed: 0, total: 0 } },
      { ...gate, memory: { passed: 5, total: 4 } },
      { ...gate, digest: 'not-a-hash' },
      { ...gate, candidateDigests: [] },
      { ...gate, candidateDigests: ['e1'] },
      { ...gate, measurementId: 'medición\n1' },
    ];
    for (const evidence of invalid) {
      await expect(memory.promote({ scope, id: 'e1', gate: evidence as never, by: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(() => evaluateMemoryGate(evidence as never)).toThrow();
    }
    await expect(memory.promote({ scope, id: 'e1', by: 'x' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.promote({ scope, id: 'ausente', gate, by: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await recall(memory)).toEqual([]);
  });

  it('binds the evidence to the record that was measured: scope, id and content, not a bare id', async () => {
    const memory = await withEpisode();
    const elsewhere = scopeOf('grow', 'otro');
    await memory.put(episode('grow', 'e1', 'otra factura con el mismo id', { scope: elsewhere }));
    const [measured] = await memory.list({ scope });
    const [unmeasured] = await memory.list({ scope: elsewhere });
    expect(measured!.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(unmeasured!.contentDigest).not.toBe(measured!.contentDigest);
    const gate = passingGate(measured!.contentDigest);

    expect(await memory.promote({ scope: elsewhere, id: 'e1', gate, by: 'x' })).toEqual({ promoted: false, reason: 'CANDIDATE_NOT_MEASURED' });
    expect(await memory.promote({ scope, id: 'e1', gate, by: 'x' })).toMatchObject({ promoted: true });
    expect(await memory.query({ scope: elsewhere, text: 'factura', limit: 5 })).toEqual([]);
    expect((await recall(memory)).map(record => record.id)).toEqual(['e1']);
    // A bare record id is not evidence of anything.
    await expect(memory.promote({ scope: elsewhere, id: 'e1', gate: { ...gate, candidateDigests: ['e1'] }, by: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('exposes the same gate rule the store applies', () => {
    expect(evaluateMemoryGate(passingGate(HASH))).toEqual({ passed: true });
    expect(evaluateMemoryGate({ ...passingGate(HASH), memory: { passed: 1, total: 4 } })).toEqual({ passed: false, reason: 'NO_GAIN_OVER_NO_MEMORY' });
  });
});

describe('rollback of a promoted lesson', () => {
  it('withdraws the lesson from every read and records who rolled it back and why', async () => {
    const memory = await withEpisode();
    await memory.promote({ scope, id: 'e1', gate: await gateFor(memory, scope, 'e1'), by: 'consolidacion' });
    expect(await recall(memory)).toHaveLength(1);

    await memory.rollback({ scope, id: 'e1', by: 'sebastian', reason: 'regresión en respuestas' });

    expect(await recall(memory)).toEqual([]);
    expect(await memory.list({ scope })).toEqual([]);
    const raw = new DatabaseSync(workspace.databasePath);
    try {
      const row = raw.prepare('SELECT rolled_back_by, rollback_reason, rolled_back_at FROM memory_records').get()!;
      expect(row).toMatchObject({ rolled_back_by: 'sebastian', rollback_reason: 'regresión en respuestas' });
      expect(Date.parse(String(row.rolled_back_at))).not.toBeNaN();
    } finally { raw.close(); }
  });

  it('is final: a rolled back lesson cannot be promoted or stored again', async () => {
    const memory = await withEpisode();
    const gate = await gateFor(memory, scope, 'e1');
    await memory.promote({ scope, id: 'e1', gate, by: 'x' });
    await memory.rollback({ scope, id: 'e1', by: 'x', reason: 'regresión' });
    await memory.rollback({ scope, id: 'e1', by: 'x', reason: 'segunda vez' });

    await expect(memory.promote({ scope, id: 'e1', gate, by: 'x' })).rejects.toMatchObject({ code: 'WITHDRAWN' });
    await expect(memory.put(episode('grow', 'e1', 'ofrecer factura en pesos'))).rejects.toMatchObject({ code: 'WITHDRAWN' });
    expect(await recall(memory)).toEqual([]);
  });

  it('works while memory is switched off, and only for something that was promoted', async () => {
    const memory = await withEpisode();
    await memory.put(episode('grow', 'e2', 'episodio sin promover'));
    await memory.promote({ scope, id: 'e1', gate: await gateFor(memory, scope, 'e1'), by: 'x' });
    await memory.disable({ by: 'operator' });

    await memory.rollback({ scope, id: 'e1', by: 'x', reason: 'regresión' });
    await expect(memory.rollback({ scope, id: 'e2', by: 'x', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_PROMOTED' });
    await expect(memory.rollback({ scope, id: 'ausente', by: 'x', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await memory.enable({ by: 'operator' });
    expect(await recall(memory)).toEqual([]);
    expect((await memory.list({ scope })).map(view => view.record.id)).toEqual(['e2']);
  });
});

describe('bounded recall', () => {
  async function sixLessons(maxLessonsPerRecall?: number) {
    const memory = workspace.open('grow', maxLessonsPerRecall === undefined ? {} : { maxLessonsPerRecall });
    await memory.enable({ by: 'operator' });
    for (let index = 0; index < 6; index++) {
      const id = `e${index}`;
      await memory.put(episode('grow', id, `factura caso ${index}`));
      await memory.promote({ scope, id, gate: await gateFor(memory, scope, id), by: 'x' });
    }
    return memory;
  }

  it('delivers at most three lessons per recall however many match or are asked for', async () => {
    const memory = await sixLessons();

    expect(await recall(memory, 50)).toHaveLength(3);
    expect(await recall(memory, 2)).toHaveLength(2);
    expect(await recall(memory, 0)).toEqual([]);
    expect(await memory.list({ scope })).toHaveLength(6);
  });

  it('lets the host choose a different small bound, within a hard ceiling', async () => {
    const memory = await sixLessons(1);
    expect(await recall(memory, 50)).toHaveLength(1);
    expect(() => workspace.open('grow', { maxLessonsPerRecall: 9 })).toThrow(/INVALID_INPUT/);
  });
});
