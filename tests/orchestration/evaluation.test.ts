import { describe, expect, it, vi, afterEach } from 'vitest';
import { compareEvaluations, runEvaluation } from '../../src/orchestration/evaluation/index.js';
import type { RunEvaluationOptions } from '../../src/orchestration/evaluation/types.js';

const source = 'a'.repeat(64);
const base = (): RunEvaluationOptions => ({
  id: 'run', suite: { id: 'corpus', version: '1', cases: [{ id: 'a', input: { secret: 'CANARY-INPUT' }, expected: true }] },
  profile: { id: 'local', version: '1', sourceDigest: source },
  execute: () => ({ output: true }), scorers: [{ id: 'exact', version: '1', score: (output, expected) => ({ value: Number(output === expected), passed: output === expected }) }],
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
afterEach(() => vi.useRealTimers());

describe('evaluation reports', () => {
  it('uses independent verification and deliberate repetitions without retaining raw JSON', async () => {
    let count = 0;
    const report = await runEvaluation({ ...base(), repetitions: 3, execute: () => ({ output: ++count !== 2 }) });
    expect(report.metrics).toMatchObject({ total: 3, passed: 2, firstPassRate: 1, consistencyRate: 0, admissions: 3, denials: 0 });
    expect(report.metrics.repetitionPassRates).toEqual([1, 0, 1]);
    expect(report.attempts.map(a => a.status)).toEqual(['passed', 'failed', 'passed']);
    expect(report.attempts.every(a => a.scores[0]?.scorerId === 'exact')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('CANARY-INPUT');
    expect(report.suiteDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.scorerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.profileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(report.attempts[0])).toBe(true);
  });
  it('snapshots input and callback identities before asynchronous work and canonicalizes object keys', async () => {
    const gate = deferred(), options = base();
    options.budget = { acquire: async () => { await gate.promise; return { release() {} }; } };
    const running = runEvaluation(options);
    options.suite.cases[0]!.input = 'changed'; options.profile.sourceDigest = 'b'.repeat(64); options.scorers[0]!.version = 'changed';
    gate.resolve(); const report = await running;
    const equivalent = base(); equivalent.suite.cases[0]!.input = { secret: 'CANARY-INPUT' };
    const second = await runEvaluation(equivalent);
    expect(report.suiteDigest).toBe(second.suiteDigest); expect(report.profile.sourceDigest).toBe(source);
    expect(report.scorerDigest).toBe(second.scorerDigest);
  });
  it('preserves unknown usage and keeps reported cost meanings separate', async () => {
    let count = 0;
    const report = await runEvaluation({ ...base(), repetitions: 3, execute: () => ({ output: true,
      ...(++count === 3 ? {} : { usage: { inputTokens: 10, reportedCostUsd: 2, costMeaning: count === 1 ? 'provider-reported' as const : 'api-equivalent' as const } }),
    }) });
    expect(report.usage.inputTokens).toEqual({ known: 2, total: 20 });
    expect(report.usage.outputTokens).toEqual({ known: 0, total: null });
    expect(report.usage.reportedCostUsd).toEqual([
      { costMeaning: 'api-equivalent', known: 1, total: 2 }, { costMeaning: 'provider-reported', known: 1, total: 2 },
    ]);
  });
  it('classifies execution, invalid output and verifier failures without raw error text', async () => {
    const error = await runEvaluation({ ...base(), execute() { throw new Error('RAW-ERROR-SECRET'); } });
    expect(error.attempts[0]).toMatchObject({ status: 'error', failure: { phase: 'execution', code: 'EXECUTION_ERROR' } });
    const invalid = await runEvaluation({ ...base(), execute: () => ({ output: undefined as never }) });
    expect(invalid.attempts[0]?.failure?.code).toBe('INVALID_OUTPUT');
    const verifier = await runEvaluation({ ...base(), scorers: [{ id: 'oracle', version: '1', score() { throw new Error('RAW-ERROR-SECRET'); } }] });
    expect(verifier.attempts[0]).toMatchObject({ status: 'error', failure: { phase: 'verification', code: 'SCORER_ERROR' } });
    expect(JSON.stringify([error, invalid, verifier])).not.toContain('RAW-ERROR-SECRET');
  });
  it('compares matched corpus/oracles/repetitions and explicit source/profile digests', async () => {
    const baseline = await runEvaluation(base());
    const candidate = await runEvaluation({ ...base(), id: 'candidate', profile: { id: 'new', version: '2', sourceDigest: 'b'.repeat(64) }, execute: () => ({ output: false }) });
    expect(compareEvaluations(baseline, candidate)).toMatchObject({ comparable: true, baselineSourceDigest: source, candidateSourceDigest: 'b'.repeat(64), deltas: { passRate: -1, firstPassRate: -1 } });
    const changed = base(); changed.suite.cases[0]!.expected = false;
    expect(() => compareEvaluations(baseline, { ...candidate, suiteDigest: 'c'.repeat(64) })).toThrow();
    expect(() => compareEvaluations(baseline, { ...candidate, metrics: { ...candidate.metrics, passed: 900 } })).toThrow();
    expect(() => compareEvaluations(baseline, { ...candidate, unexpected: 'raw' } as never)).toThrow();
    await expect(runEvaluation({ ...base(), repetitions: 101 })).rejects.toThrow();
    await expect(runEvaluation({ ...base(), timeoutMs: 0 })).rejects.toThrow();
  });
});
