import { performance } from 'node:perf_hooks';
import { isExecutionHalted } from '../../public/execution-halt.js';
import type { AgentEvent } from '../../public/types.js';
import type { ObservedTaskBudget } from '../tasks/index.js';
import type { EvaluationAttempt, EvaluationAttemptContext, EvaluationFailurePhase, EvaluationReport, RunEvaluationOptions } from './types.js';
import { attemptId, finishReport } from './report.js';
import { capture, hash, output, score } from './validation.js';

type Captured = ReturnType<typeof capture>;
type MutableAttempt = Omit<EvaluationAttempt, 'scores'> & { scores: Array<EvaluationAttempt['scores'][number]> };

async function runAttempt(options: Captured, caseIndex: number, repetition: number, first: boolean, last: boolean): Promise<EvaluationAttempt> {
  const entry = options.suite.cases[caseIndex]!;
  const id = attemptId(options.id, entry.id, repetition);
  const started = performance.now(), deadline = Date.now() + options.timeoutMs;
  const controller = new AbortController();
  let phase: EvaluationFailurePhase = 'admission', timedOut = false, active = true;
  let fatal: { error: unknown } | undefined;
  let reservation: Awaited<ReturnType<ObservedTaskBudget['acquire']>> | undefined;
  const pending = new Set<Promise<void>>();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  // Keep the deadline referenced: a standalone Node process may otherwise exit
  // while a cooperative callback waits solely for this signal's abort event.
  const timeout = () => { if (!controller.signal.aborted) { timedOut = true; controller.abort(); } };
  const timer = setTimeout(timeout, options.timeoutMs);
  const attempt: MutableAttempt = { id, caseId: entry.id, repetition, status: 'error', passed: false, admitted: false, durationMs: 0, scores: [] };
  const markFatal = (error: unknown) => { fatal ??= { error }; controller.abort(); };
  const expire = () => { if (Date.now() >= deadline) timeout(); };
  const boundary = () => {
    expire();
    if (fatal !== undefined) throw fatal.error;
    if (controller.signal.aborted) throw new Error('Evaluation attempt stopped');
  };
  const append = async (event: Parameters<NonNullable<RunEvaluationOptions['trace']>['append']>[0]) => {
    if (options.trace === undefined) return;
    try { await options.trace.append(event); } catch (error) { markFatal(error); throw error; }
  };
  const recordEvent = (event: AgentEvent): Promise<void> => {
    if (!active) {
      const closed = Promise.reject(new Error('Evaluation attempt is closed'));
      void closed.catch(() => {});
      return closed;
    }
    const work = (async () => {
      boundary();
      if (options.trace?.observe !== undefined) {
        try { await options.trace.observe(event); } catch (error) { markFatal(error); throw error; }
      }
    })();
    pending.add(work);
    // Attach an internal rejection observer even if application code forgets to await it.
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const drain = async () => { while (pending.size > 0) await Promise.allSettled([...pending]); };
  const context: EvaluationAttemptContext = Object.freeze({ attemptId: id, caseId: entry.id, repetition, signal: controller.signal, deadline, recordEvent });
  const interrupted = () => {
    attempt.status = timedOut ? 'timed-out' : 'cancelled'; attempt.passed = false;
    attempt.failure = { phase, code: timedOut ? 'DEADLINE_EXCEEDED' : 'CANCELLED' };
  };
  try {
    try {
      boundary();
      if (first) { await append({ type: 'evaluation.started', phaseId: id }); boundary(); }
      await append({ type: 'evaluation.attempt.started', phaseId: id }); boundary();
      if (options.budget !== undefined) reservation = await options.budget.acquire(controller.signal);
      attempt.admitted = true;
      boundary(); phase = 'execution';
      const raw = await options.execute(entry.input, context);
      await drain(); boundary();
      let result: ReturnType<typeof output>;
      try { result = output(raw); }
      catch { attempt.failure = { phase, code: 'INVALID_OUTPUT' }; throw new Error('Invalid evaluation result'); }
      attempt.outputDigest = hash(result.output);
      if (result.usage !== undefined) attempt.usage = result.usage;
      phase = 'verification';
      for (const scorer of options.scorers) {
        boundary();
        const rawScore = await scorer.score(result.output, entry.expected, context);
        await drain(); boundary();
        try { attempt.scores.push({ scorerId: scorer.id, ...score(rawScore) }); }
        catch { attempt.failure = { phase, code: 'INVALID_SCORE' }; throw new Error('Invalid evaluation score'); }
      }
      attempt.passed = attempt.scores.every(result => result.passed);
      attempt.status = attempt.passed ? 'passed' : 'failed';
    } catch (error) {
      // An execution halt is a failed infrastructure boundary, not a model or scorer result:
      // it ends the whole evaluation instead of being recorded as one failed attempt.
      if (isExecutionHalted(error)) markFatal(error);
      // Every callback, including unawaited event writers, must settle before finalization.
      await drain();
      if (fatal !== undefined) throw fatal.error;
      expire();
      if (controller.signal.aborted) interrupted();
      else if (phase === 'admission') {
        attempt.budgetDenied = true;
        attempt.status = 'denied'; attempt.failure = { phase, code: 'BUDGET_DENIED' };
      } else {
        attempt.status = 'error';
        attempt.failure ??= { phase, code: phase === 'execution' ? 'EXECUTION_ERROR' : 'SCORER_ERROR' };
      }
    }
    // Callback dispatch has ended. Drain already submitted writes and reject
    // detached submissions before committing terminal metadata.
    active = false; await drain();
    if (fatal !== undefined) throw fatal.error;
    expire();
    if (controller.signal.aborted) interrupted();
    const recordedStatus = attempt.status;
    await append({ type: 'evaluation.attempt.completed', phaseId: id, status: attempt.status, count: attempt.scores.length });
    if (last || options.signal?.aborted || attempt.budgetDenied) await append({ type: 'evaluation.completed', phaseId: id });
    expire();
    if (controller.signal.aborted) interrupted();
    // A sink can durably record a status and settle after the deadline or parent
    // cancellation. Persist an explicit correction and await it before releasing
    // ownership. The first abort cause is stable, so this correction cannot drift.
    if (attempt.status !== recordedStatus) await append({ type: 'evaluation.attempt.corrected', phaseId: id,
      status: attempt.status, code: attempt.failure!.code, count: attempt.scores.length });
    return attempt;
  } finally {
    active = false;
    await drain();
    try { await reservation?.release(); }
    finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
      attempt.durationMs = Math.max(0, performance.now() - started);
    }
  }
}

/** Sequential, explicitly repeated evaluations. No implicit retries or provider launches. */
export async function runEvaluation(input: RunEvaluationOptions): Promise<EvaluationReport> {
  const options = capture(input);
  const startedAt = Date.now(), attempts: EvaluationAttempt[] = [];
  const planned = options.suite.cases.length * options.repetitions;
  outer: for (let index = 0; index < options.suite.cases.length; index++) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      if (options.signal?.aborted) break outer;
      const attempt = await runAttempt(options, index, repetition, attempts.length === 0, attempts.length === planned - 1);
      attempts.push(attempt);
      if (attempt.budgetDenied) break outer;
    }
  }
  const scorers = options.scorers.map(({ id, version }) => ({ id, version }));
  return finishReport({ format: 1, id: options.id,
    suite: { id: options.suite.id, version: options.suite.version, caseIds: options.suite.cases.map(entry => entry.id) },
    suiteDigest: hash(options.suite), scorers, scorerDigest: hash(scorers),
    profile: options.profile, profileDigest: hash(options.profile), repetitions: options.repetitions, timeoutMs: options.timeoutMs,
    startedAt, completedAt: Math.max(startedAt, Date.now()), attempts });
}
