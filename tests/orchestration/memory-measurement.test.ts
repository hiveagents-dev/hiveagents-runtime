import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureMemory } from '../../src/orchestration/memory/system.js';
import type { MeasureMemoryOptions, MemoryCondition, MemoryMeasurementTask } from '../../src/orchestration/memory/index.js';
import { episode, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

/**
 * Plan acceptance: "toda memoria se mide contra controles sin memoria y con
 * historia completa". Deterministic fakes only: no model turn is ever made.
 */
const LESSON = 'el cliente paga a treinta días';
/** Stands for the content digest of the record under test. */
const CANDIDATE = 'c'.repeat(64);
const HISTORY = ['saludo inicial', LESSON, 'el cliente prefiere correo', 'cierre de la reunión'];
const tasks: MemoryMeasurementTask[] = [
  { id: 'plazo', input: { needs: 'treinta días' } },
  { id: 'canal', input: { needs: 'prefiere correo' } },
  { id: 'saludo', input: { needs: null } },
];
/** A task passes when the fact it needs is somewhere in the context it was given. */
function fakeRunner(calls: { task: string; condition: MemoryCondition; context: readonly string[] }[] = []) {
  return (task: MemoryMeasurementTask, run: { condition: MemoryCondition; context: readonly string[] }) => {
    calls.push({ task: task.id, condition: run.condition, context: run.context });
    const needs = (task.input as { needs: string | null }).needs;
    return { passed: needs === null || run.context.some(item => item.includes(needs)) };
  };
}
function options(overrides: Partial<MeasureMemoryOptions> = {}): MeasureMemoryOptions {
  return {
    id: 'medicion-1',
    tasks,
    candidateDigests: [CANDIDATE],
    recall: () => [LESSON],
    history: () => HISTORY,
    run: fakeRunner(),
    ...overrides,
  };
}

describe('memory measurement against both controls', () => {
  it('runs the same task set under no memory, memory and full history', async () => {
    const calls: { task: string; condition: MemoryCondition; context: readonly string[] }[] = [];

    await measureMemory(options({ run: fakeRunner(calls) }));

    expect(calls.map(call => `${call.task}:${call.condition}`)).toEqual([
      'plazo:no-memory', 'plazo:memory', 'plazo:full-history',
      'canal:no-memory', 'canal:memory', 'canal:full-history',
      'saludo:no-memory', 'saludo:memory', 'saludo:full-history',
    ]);
    expect(calls.filter(call => call.condition === 'no-memory').every(call => call.context.length === 0)).toBe(true);
    expect(calls.filter(call => call.condition === 'memory').every(call => call.context.join() === LESSON)).toBe(true);
    expect(calls.filter(call => call.condition === 'full-history').every(call => call.context.length === 4)).toBe(true);
  });

  it('reports the three outcomes side by side, per condition and per task', async () => {
    const report = await measureMemory(options());

    expect(report.conditions['no-memory']).toMatchObject({ passed: 1, total: 3, errors: 0, contextItems: 0, contextChars: 0 });
    expect(report.conditions.memory).toMatchObject({ passed: 2, total: 3, errors: 0, contextItems: 3, contextChars: 3 * LESSON.length });
    expect(report.conditions['full-history']).toMatchObject({ passed: 3, total: 3, errors: 0, contextItems: 12 });
    expect(report.conditions.memory.passRate).toBeCloseTo(2 / 3, 12);
    expect(report.tasks.map(task => task.id)).toEqual(['plazo', 'canal', 'saludo']);
    expect(report.tasks[0]!.outcomes).toMatchObject({
      'no-memory': { passed: false }, memory: { passed: true }, 'full-history': { passed: true },
    });
    expect(report.tasks[1]!.outcomes).toMatchObject({
      'no-memory': { passed: false }, memory: { passed: false }, 'full-history': { passed: true },
    });
    expect(report.deltas.memoryVsNoMemory).toBeCloseTo(1 / 3, 12);
    expect(report.deltas.memoryVsFullHistory).toBeCloseTo(-1 / 3, 12);
    expect(report.verdict).toEqual({ passed: true });
    expect(report.gate).toEqual({
      measurementId: 'medicion-1', digest: report.digest, candidateDigests: [CANDIDATE],
      noMemory: { passed: 1, total: 3 }, memory: { passed: 2, total: 3 }, fullHistory: { passed: 3, total: 3 },
    });
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('says so when memory does not beat the no-memory control', async () => {
    const report = await measureMemory(options({ recall: () => ['una lección que no ayuda'] }));

    expect(report.conditions.memory.passed).toBe(report.conditions['no-memory'].passed);
    expect(report.deltas.memoryVsNoMemory).toBe(0);
    expect(report.verdict).toEqual({ passed: false, reason: 'NO_GAIN_OVER_NO_MEMORY' });
  });

  it('counts a runner or context failure as a failed task without losing the comparison', async () => {
    const run = fakeRunner();
    const report = await measureMemory(options({
      recall: task => { if (task.id === 'canal') throw new Error('recall caído'); return [LESSON]; },
      run: (task, context) => {
        if (task.id === 'saludo' && context.condition === 'full-history') throw new Error('runner caído');
        if (task.id === 'saludo' && context.condition === 'no-memory') return { passed: 'sí' } as never;
        return run(task, context);
      },
    }));

    expect(report.conditions['no-memory']).toMatchObject({ passed: 0, total: 3, errors: 1 });
    expect(report.conditions.memory).toMatchObject({ passed: 2, total: 3, errors: 1 });
    expect(report.conditions['full-history']).toMatchObject({ passed: 2, total: 3, errors: 1 });
    expect(report.tasks[1]!.outcomes.memory).toEqual({ passed: false, error: true, contextItems: 0, contextChars: 0 });
    expect(report.tasks[2]!.outcomes['full-history']).toMatchObject({ passed: false, error: true });
  });

  it('produces the same digest for the same outcomes and a different one when an outcome changes', async () => {
    const first = await measureMemory(options());
    const second = await measureMemory(options());
    const different = await measureMemory(options({ recall: () => [] }));

    expect(second.digest).toBe(first.digest);
    expect(different.digest).not.toBe(first.digest);
  });

  it('refuses a measurement that could not compare the three conditions', async () => {
    const { history: _h, ...withoutHistory } = options();
    const { recall: _r, ...withoutRecall } = options();
    await expect(measureMemory(withoutHistory as never)).rejects.toThrow(TypeError);
    await expect(measureMemory(withoutRecall as never)).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ tasks: [] }))).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ tasks: [tasks[0]!, tasks[0]!] }))).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ candidateDigests: [] }))).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ candidateDigests: ['e1'] }))).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ candidateDigests: [CANDIDATE, CANDIDATE] }))).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ id: '' }))).rejects.toThrow(TypeError);
    await expect(measureMemory(options({ recall: () => [7] as never }))).resolves.toMatchObject({
      conditions: { memory: { errors: 3 } },
    });
  });

  it('stops when the caller aborts instead of reporting a partial comparison', async () => {
    const abort = new AbortController();
    const run = fakeRunner();
    const measuring = measureMemory(options({
      signal: abort.signal,
      run: (task, context) => { if (task.id === 'canal') abort.abort(); return run(task, context); },
    }));
    await expect(measuring).rejects.toThrow();
  });
});

describe('a measurement is what opens the promotion gate', () => {
  let workspace: ReturnType<typeof memoryWorkspace>;
  beforeEach(() => { workspace = memoryWorkspace(); });
  afterEach(() => { workspace.cleanup(); });
  const scope = scopeOf('grow');

  /** A stored episode and its content digest: what a measurement names as its candidate. */
  async function candidate() {
    const memory = workspace.open('grow');
    await memory.enable({ by: 'operator' });
    await memory.put(episode('grow', 'e1', LESSON));
    const [view] = await memory.list({ scope });
    return { memory, candidateDigests: [view!.contentDigest] };
  }

  it('promotes a candidate with the evidence of a measurement in which it helped', async () => {
    const { memory, candidateDigests } = await candidate();
    const report = await measureMemory(options({
      candidateDigests,
      // The candidate is not recallable yet: the memory condition reads it as the owner's episode.
      recall: async () => (await memory.list({ scope })).map(view => view.record.text),
    }));

    expect(await memory.promote({ scope, id: 'e1', gate: report.gate, by: 'consolidacion' })).toMatchObject({ promoted: true });
    expect((await memory.query({ scope, text: 'treinta', limit: 3 })).map(record => record.id)).toEqual(['e1']);
    expect((await memory.list({ scope }))[0]!.promotion!.gate).toEqual(report.gate);
  });

  it('keeps the candidate out of recall when the measurement shows no gain', async () => {
    const { memory, candidateDigests } = await candidate();
    const report = await measureMemory(options({ candidateDigests, tasks: [tasks[2]!] }));

    expect(report.verdict.passed).toBe(false);
    expect(await memory.promote({ scope, id: 'e1', gate: report.gate, by: 'consolidacion' })).toEqual({
      promoted: false, reason: 'NO_GAIN_OVER_NO_MEMORY',
    });
    expect(await memory.query({ scope, text: 'treinta', limit: 3 })).toEqual([]);
  });

  it('does not let a measurement of one record promote another', async () => {
    const { memory, candidateDigests } = await candidate();
    await memory.put(episode('grow', 'e2', 'una nota que nadie midió'));
    const report = await measureMemory(options({ candidateDigests }));

    expect(report.verdict.passed).toBe(true);
    expect(await memory.promote({ scope, id: 'e2', gate: report.gate, by: 'consolidacion' })).toEqual({
      promoted: false, reason: 'CANDIDATE_NOT_MEASURED',
    });
  });
});
