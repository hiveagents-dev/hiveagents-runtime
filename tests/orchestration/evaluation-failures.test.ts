import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareEvaluations, runEvaluation, validateEvaluationReport } from '../../src/orchestration/evaluation/index.js';
import { hash } from '../../src/orchestration/evaluation/validation.js';
import { finishReport } from '../../src/orchestration/evaluation/report.js';
import type { EvaluationReport, RunEvaluationOptions } from '../../src/orchestration/evaluation/types.js';

const base = (): RunEvaluationOptions => ({
  id: 'run', suite: { id: 'suite', version: '1', cases: [{ id: 'one', input: 1, expected: 1 }, { id: 'two', input: 2, expected: 2 }] },
  profile: { id: 'local', version: '1', sourceDigest: 'a'.repeat(64) },
  execute: input => ({ output: input }), scorers: [{ id: 'exact', version: '1', score: (output, expected) => ({ value: Number(output === expected), passed: output === expected }) }],
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
afterEach(() => vi.useRealTimers());

describe('evaluation scheduling and failure boundaries', () => {
  it('performs no admission or execution when already cancelled', async () => {
    const acquire = vi.fn(), execute = vi.fn();
    const report = await runEvaluation({ ...base(), signal: AbortSignal.abort('SECRET-REASON'), budget: { acquire }, execute });
    expect(report.attempts).toHaveLength(0); expect(report.metrics.firstPassRate).toBe(0);
    expect(acquire).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('SECRET-REASON');
    expect(validateEvaluationReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
  it('records a budget denial once and never schedules the next case', async () => {
    const execute = vi.fn(), acquire = vi.fn(() => { throw new Error('BUDGET-RAW-SECRET'); });
    const report = await runEvaluation({ ...base(), budget: { acquire }, execute });
    expect(acquire).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    expect(report.attempts[0]).toMatchObject({ status: 'denied', admitted: false, failure: { phase: 'admission', code: 'BUDGET_DENIED' } });
    expect(report.metrics).toMatchObject({ total: 1, admissions: 0, denials: 1 });
    expect(JSON.stringify(report)).not.toContain('BUDGET-RAW-SECRET');
  });
  it('covers noncooperative admission with the same deadline and releases a late reservation', async () => {
    vi.useFakeTimers();
    const ready = deferred(), release = vi.fn(); let signal!: AbortSignal;
    const execute = vi.fn();
    const options = base(); options.suite.cases = options.suite.cases.slice(0, 1);
    const running = runEvaluation({ ...options, timeoutMs: 10, execute, budget: { acquire: async observed => { signal = observed; await ready.promise; return { release }; } } });
    await vi.advanceTimersByTimeAsync(11); expect(signal.aborted).toBe(true); expect(release).not.toHaveBeenCalled();
    ready.resolve(); const report = await running;
    expect(execute).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(report.attempts[0]).toMatchObject({ admitted: true, status: 'timed-out', failure: { phase: 'admission', code: 'DEADLINE_EXCEEDED' } });
  });
  it('aborts derived execution signals and retains budget until noncooperative work settles', async () => {
    vi.useFakeTimers();
    const finish = deferred(), started = deferred(), controller = new AbortController(), release = vi.fn();
    let calls = 0, signal!: AbortSignal;
    const running = runEvaluation({ ...base(), signal: controller.signal, budget: { acquire: () => ({ release }) }, execute: async (input, context) => {
      calls++; signal = context.signal; started.resolve(); await finish.promise; return { output: input };
    } });
    await started.promise; controller.abort('RAW-ABORT'); await vi.advanceTimersByTimeAsync(5);
    expect(signal).not.toBe(controller.signal); expect(signal.aborted).toBe(true); expect(calls).toBe(1); expect(release).not.toHaveBeenCalled();
    finish.resolve(); const report = await running;
    expect(release).toHaveBeenCalledOnce(); expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.status).toBe('cancelled'); expect(JSON.stringify(report)).not.toContain('RAW-ABORT');
  });
  it('drains timed-out verification before releasing budget or running the next case', async () => {
    vi.useFakeTimers();
    const finish = deferred(), verifying = deferred(), events: string[] = []; let signal!: AbortSignal;
    const running = runEvaluation({ ...base(), timeoutMs: 10, budget: { acquire() { events.push('acquire'); return { release() { events.push('release'); } }; } },
      execute: input => { events.push(`execute:${input}`); return { output: input }; },
      scorers: [{ id: 'exact', version: '1', async score(_output, _expected, context) {
        if (context.caseId === 'one') { signal = context.signal; verifying.resolve(); await finish.promise; }
        events.push(`score:${context.caseId}`); return { value: 1, passed: true };
      } }],
    });
    await verifying.promise; await vi.advanceTimersByTimeAsync(11);
    expect(signal.aborted).toBe(true); expect(events).toEqual(['acquire', 'execute:1']);
    finish.resolve(); const report = await running;
    expect(events).toEqual(['acquire', 'execute:1', 'score:one', 'release', 'acquire', 'execute:2', 'score:two', 'release']);
    expect(report.attempts.map(attempt => attempt.status)).toEqual(['timed-out', 'passed']);
    expect(report.attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('includes durable trace dispatch in deadline and does not execute after a late trace settles', async () => {
    vi.useFakeTimers(); const finish = deferred(), started = deferred(), execute = vi.fn();
    const options = base(); options.suite.cases = options.suite.cases.slice(0, 1);
    let calls = 0;
    const running = runEvaluation({ ...options, timeoutMs: 10, execute, trace: { async append() { if (++calls === 1) { started.resolve(); await finish.promise; } } } });
    await started.promise; await vi.advanceTimersByTimeAsync(11); finish.resolve();
    const report = await running; expect(execute).not.toHaveBeenCalled(); expect(report.attempts[0]?.status).toBe('timed-out');
  });
  it('treats even an ignored event sink rejection as fatal and stops later cases', async () => {
    const error = new Error('store unavailable'), release = vi.fn(); let calls = 0;
    await expect(runEvaluation({ ...base(), budget: { acquire: () => ({ release }) },
      trace: { async append() {}, async observe() { throw error; } },
      execute: (input, context) => { calls++; void context.recordEvent({ type: 'message.delta', text: 'RAW-TEXT' }); return { output: input }; },
    })).rejects.toBe(error);
    expect(calls).toBe(1); expect(release).toHaveBeenCalledOnce();
  });
  it('keeps reservations while an unawaited event sink is pending and propagates terminal sink errors', async () => {
    const gate = deferred(), observed = deferred(), release = vi.fn(); let calls = 0;
    const running = runEvaluation({ ...base(), budget: { acquire: () => ({ release }) },
      trace: { async append() {}, async observe() { observed.resolve(); await gate.promise; } },
      execute: (input, context) => { calls++; void context.recordEvent({ type: 'message.delta', text: 'RAW-TEXT' }); return { output: input }; },
    });
    await observed.promise; expect(calls).toBe(1); expect(release).not.toHaveBeenCalled(); gate.resolve(); await running;
    expect(release).toHaveBeenCalledTimes(2);
    const sinkError = new Error('failed writing final state'); calls = 0;
    await expect(runEvaluation({ ...base(), trace: { async append(event) { if (event.type === 'evaluation.attempt.completed') throw sinkError; } },
      execute: input => { calls++; return { output: input }; },
    })).rejects.toBe(sinkError); expect(calls).toBe(1);
  });
});

describe('evaluation validation and comparison', () => {
  it('rejects strict JSON violations, duplicates, malformed options and malformed scorer results', async () => {
    const violations = [undefined, Infinity, new Date(), new Array(1), { toJSON() { return {}; } }, { get secret() { return true; } }];
    for (const input of violations) {
      const options = base(); options.suite.cases[0]!.input = input as never;
      await expect(runEvaluation(options)).rejects.toThrow();
    }
    const options = base(); options.suite.cases = [options.suite.cases[0]!, options.suite.cases[0]!];
    await expect(runEvaluation(options)).rejects.toThrow();
    await expect(runEvaluation({ ...base(), unexpected: true } as never)).rejects.toThrow();
    await expect(runEvaluation({ ...base(), scorers: [] })).rejects.toThrow();
    const report = await runEvaluation({ ...base(), scorers: [{ id: 'oracle', version: '1', score: () => ({ value: NaN, passed: true }) }] });
    expect(report.attempts[0]?.failure).toEqual({ phase: 'verification', code: 'INVALID_SCORE' });
  });
  it('validates every scorer, snapshots immutable outputs and redacts free-form verifier codes', async () => {
    const checked: number[] = [];
    const options = base(); options.suite.cases = options.suite.cases.slice(0, 1);
    const report = await runEvaluation({ ...options, execute: () => ({ output: { selected: true } }), scorers: [
      { id: 'reject', version: '1', score(output, expected) { expect(Object.isFrozen(output)).toBe(true); expect(expected).toBe(1); checked.push(1); return { value: 0, passed: false, code: 'raw secret contains spaces' }; } },
      { id: 'accept', version: '1', score() { checked.push(2); return { value: 1, passed: true }; } },
    ] });
    expect(checked).toEqual([1, 2]); expect(report.attempts[0]?.status).toBe('failed');
    expect(report.attempts[0]?.scores[0]?.code).toBe('SCORER_CODE_REDACTED');
    expect(JSON.stringify(report)).not.toContain('raw secret');
  });
  it('hashes corpus, oracle and profile independently and rejects valid incompatible comparisons', async () => {
    const baseline = await runEvaluation(base());
    const changedCorpus = base(); changedCorpus.suite.cases[0]!.expected = 99;
    const changedOracle = base(); changedOracle.scorers[0]!.version = '2';
    for (const options of [changedCorpus, changedOracle, { ...base(), repetitions: 2 }]) {
      const candidate = await runEvaluation(options);
      expect(() => compareEvaluations(baseline, candidate)).toThrow(/Incompatible/);
    }
    expect((await runEvaluation(changedCorpus)).suiteDigest).not.toBe(baseline.suiteDigest);
    expect((await runEvaluation(changedOracle)).scorerDigest).not.toBe(baseline.scorerDigest);
    const changedProfile = await runEvaluation({ ...base(), profile: { ...base().profile, version: '2' } });
    expect(changedProfile.profileDigest).not.toBe(baseline.profileDigest);
    expect(compareEvaluations(baseline, changedProfile).comparable).toBe(true);
  });
  it('rejects corrupted persisted report aggregates, identities, unknown fields and reordered attempts even after rehash', async () => {
    const report = await runEvaluation(base());
    const rehash = (value: EvaluationReport) => { const { digest: _digest, ...body } = value; return { ...body, digest: hash(body) }; };
    for (const mutate of [
      (value: EvaluationReport) => { value.profile.sourceDigest = 'b'.repeat(64); },
      (value: EvaluationReport) => { value.metrics.passed = 100; },
      (value: EvaluationReport) => { value.attempts = [...value.attempts].reverse(); },
      (value: EvaluationReport) => { (value.attempts[0] as unknown as { prompt: string }).prompt = 'RAW'; },
      (value: EvaluationReport) => { value.attempts[0]!.scores = [{ scorerId: 'unknown', value: 1, passed: true }]; },
    ]) {
      const candidate = JSON.parse(JSON.stringify(report)) as EvaluationReport; mutate(candidate);
      expect(() => validateEvaluationReport(rehash(candidate))).toThrow();
    }
  });
  it('distinguishes reported zero from unavailable token/cost fields and rejects invalid usage', async () => {
    const options = base(); options.suite.cases = options.suite.cases.slice(0, 1);
    const report = await runEvaluation({ ...options, execute: () => ({ output: true, usage: { inputTokens: 0, costMeaning: 'unavailable' } }) });
    expect(report.usage.inputTokens).toEqual({ known: 1, total: 0 });
    expect(report.usage.reportedCostUsd).toEqual([{ costMeaning: 'unavailable', known: 0, total: null }]);
    const invalid = await runEvaluation({ ...options, execute: () => ({ output: true, usage: { outputTokens: -1, costMeaning: 'estimate', reportedCostUsd: 1 } }) });
    expect(invalid.attempts[0]?.failure?.code).toBe('INVALID_OUTPUT');
  });
  it('rejects JSON array accessors before executing them', async () => {
    let invoked = false;
    const options = base();
    Object.defineProperty(options.suite.cases, '0', { enumerable: true, get() { invoked = true; return { id: 'accessor', input: 1, expected: 1 }; } });
    await expect(runEvaluation(options)).rejects.toThrow();
    expect(invoked).toBe(false);
  });
  it('captures trusted port method identities before asynchronous scheduling', async () => {
    const gate = deferred(), entered = deferred();
    const options = base(); let observed = 0;
    options.trace = { async append() {}, async observe() { observed++; } };
    options.budget = { async acquire() { entered.resolve(); await gate.promise; return { release() {} }; } };
    options.execute = async (input, context) => { await context.recordEvent({ type: 'message.delta', text: 'private' }); return { output: input }; };
    const running = runEvaluation(options); await entered.promise;
    options.trace.observe = async () => { throw new Error('mutated sink'); };
    options.budget.acquire = () => { throw new Error('mutated admission'); };
    gate.resolve();
    await expect(running).resolves.toMatchObject({ metrics: { passed: 2 } });
    expect(observed).toBe(2);
  });
  it('rejects explicitly undefined scorer metadata rather than silently dropping it', async () => {
    const report = await runEvaluation({ ...base(), scorers: [{ id: 'exact', version: '1', score: () => ({ value: 1, passed: true, code: undefined } as never) }] });
    expect(report.attempts[0]?.failure?.code).toBe('INVALID_SCORE');
  });
  it('refuses token aggregation that exceeds exact integer coverage', async () => {
    await expect(runEvaluation({ ...base(), execute: input => ({ output: input, usage: { inputTokens: Number.MAX_SAFE_INTEGER, costMeaning: 'unavailable' } }) })).rejects.toThrow(/overflow/);
  });
  it('rejects impossible failure phases in persisted reports with valid checksums', async () => {
    const original = await runEvaluation(base());
    const { digest: _digest, metrics: _metrics, usage: _usage, ...body } = JSON.parse(JSON.stringify(original)) as EvaluationReport;
    const attempt = body.attempts[0]!;
    attempt.status = 'error'; attempt.passed = false; attempt.failure = { phase: 'admission', code: 'BUDGET_DENIED' };
    const candidate = finishReport(body);
    expect(() => validateEvaluationReport(candidate)).toThrow();
  });
  it('rejects sparse or accessor scorer lists before executing application work', async () => {
    for (const scorers of [new Array(1), Object.defineProperty([], '0', { get() { throw new Error('accessor invoked'); }, enumerable: true })]) {
      const execute = vi.fn(() => ({ output: true }));
      await expect(runEvaluation({ ...base(), execute, scorers })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('does not treat invalid null bounds as default repetitions or timeout', async () => {
    for (const field of ['repetitions', 'timeoutMs']) {
      const execute = vi.fn(() => ({ output: true }));
      await expect(runEvaluation({ ...base(), execute, [field]: null } as never)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    }
  });
});
