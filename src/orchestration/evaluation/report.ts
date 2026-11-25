import type { EvaluationAttempt, EvaluationComparison, EvaluationMetrics, EvaluationReport, EvaluationUsage } from './types.js';
import { costMeanings, digest, finite, hash, identifier, integer, object, profile, score, snapshot, usage } from './validation.js';

function quantile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)] ?? 0;
}
export function metrics(attempts: readonly EvaluationAttempt[], caseIds: readonly string[], repetitions: number): EvaluationMetrics {
  const passed = attempts.filter(attempt => attempt.passed).length;
  const groups = caseIds.map(id => attempts.filter(attempt => attempt.caseId === id));
  return {
    total: attempts.length, passed,
    firstPassRate: attempts.filter(attempt => attempt.repetition === 1 && attempt.passed).length / caseIds.length,
    repetitionPassRates: Array.from({ length: repetitions }, (_, index) => attempts.filter(attempt => attempt.repetition === index + 1 && attempt.passed).length / caseIds.length),
    consistencyRate: groups.filter(group => group.length === repetitions && group.every(attempt => attempt.outputDigest !== undefined)
      && new Set(group.map(attempt => attempt.outputDigest)).size === 1).length / caseIds.length,
    durationMs: { p50: quantile(attempts.map(attempt => attempt.durationMs), .5), p95: quantile(attempts.map(attempt => attempt.durationMs), .95) },
    admissions: attempts.filter(attempt => attempt.admitted).length,
    denials: attempts.filter(attempt => attempt.budgetDenied === true || attempt.status === 'denied').length,
  };
}
export function aggregateUsage(attempts: readonly EvaluationAttempt[]): EvaluationUsage {
  const coverage = (values: readonly (number | undefined)[], exactInteger = true) => {
    const known = values.filter((value): value is number => value !== undefined);
    const total = known.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || (exactInteger && !Number.isSafeInteger(total))) throw new Error('Evaluation usage aggregate overflow');
    return { known: known.length, total: known.length === 0 ? null : total };
  };
  return {
    attempts: attempts.length,
    inputTokens: coverage(attempts.map(attempt => attempt.usage?.inputTokens)),
    outputTokens: coverage(attempts.map(attempt => attempt.usage?.outputTokens)),
    cachedInputTokens: coverage(attempts.map(attempt => attempt.usage?.cachedInputTokens)),
    cacheCreationTokens: coverage(attempts.map(attempt => attempt.usage?.cacheCreationTokens)),
    reportedCostUsd: costMeanings.filter(meaning => attempts.some(attempt => attempt.usage?.costMeaning === meaning)).map(costMeaning => ({
      costMeaning, ...coverage(attempts.filter(attempt => attempt.usage?.costMeaning === costMeaning).map(attempt => attempt.usage?.reportedCostUsd), false),
    })),
  };
}
export function finishReport(report: Omit<EvaluationReport, 'digest' | 'metrics' | 'usage'>): EvaluationReport {
  const body = { ...report, metrics: metrics(report.attempts, report.suite.caseIds, report.repetitions), usage: aggregateUsage(report.attempts) };
  return snapshot({ ...body, digest: hash(body) });
}

/** Validate a serialized report before using any measurements in a comparison. */
export function validateEvaluationReport(value: unknown): EvaluationReport {
  // Snapshot first rejects accessors, symbols, cycles, non-JSON and class instances throughout.
  const candidate = snapshot(value);
  const item = object(candidate, ['format', 'id', 'suite', 'suiteDigest', 'scorers', 'scorerDigest', 'profile', 'profileDigest',
    'repetitions', 'timeoutMs', 'startedAt', 'completedAt', 'attempts', 'metrics', 'usage', 'digest'], 'evaluation report');
  if (item.format !== 1) throw new Error('Invalid evaluation report format');
  identifier(item.id); digest(item.suiteDigest); digest(item.scorerDigest); digest(item.profileDigest); digest(item.digest);
  integer(item.repetitions, 1, 100); integer(item.timeoutMs, 1, 2 ** 31 - 1);
  integer(item.startedAt, 0, Number.MAX_SAFE_INTEGER); integer(item.completedAt, item.startedAt, Number.MAX_SAFE_INTEGER);
  const suite = object(item.suite, ['id', 'version', 'caseIds'], 'evaluation report suite');
  identifier(suite.id); identifier(suite.version);
  if (!Array.isArray(suite.caseIds)) throw new Error('Invalid report cases');
  integer(suite.caseIds.length, 1, 1000);
  for (const id of suite.caseIds) identifier(id);
  if (new Set(suite.caseIds).size !== suite.caseIds.length) throw new Error('Duplicate report case');
  integer(suite.caseIds.length * item.repetitions, 1, 10000);
  profile(item.profile);
  if (hash(item.profile) !== item.profileDigest) throw new Error('Evaluation profile digest mismatch');
  if (!Array.isArray(item.scorers)) throw new Error('Invalid report scorers');
  integer(item.scorers.length, 1, 100);
  for (const scorer of item.scorers) { const entry = object(scorer, ['id', 'version']); identifier(entry.id); identifier(entry.version); }
  const scorerIds = item.scorers.map(scorer => (scorer as { id: string }).id);
  if (new Set(scorerIds).size !== scorerIds.length || hash(item.scorers) !== item.scorerDigest) throw new Error('Evaluation scorer digest mismatch');
  if (!Array.isArray(item.attempts)) throw new Error('Invalid report attempts');
  integer(item.attempts.length, 0, suite.caseIds.length * item.repetitions);
  const combinations = new Set<string>();
  const statuses = ['passed', 'failed', 'error', 'denied', 'cancelled', 'timed-out'];
  for (const [index, value] of item.attempts.entries()) {
    const attempt = object(value, ['id', 'caseId', 'repetition', 'status', 'passed', 'admitted', 'durationMs', 'outputDigest', 'budgetDenied', 'scores', 'failure', 'usage'], 'evaluation attempt');
    identifier(attempt.id); identifier(attempt.caseId); integer(attempt.repetition, 1, item.repetitions); finite(attempt.durationMs);
    const expectedCase = suite.caseIds[Math.floor(index / item.repetitions)];
    const expectedRepetition = index % item.repetitions + 1;
    if (attempt.caseId !== expectedCase || attempt.repetition !== expectedRepetition) throw new Error('Invalid evaluation attempt order');
    if (attempt.id !== attemptId(item.id, attempt.caseId, attempt.repetition)) throw new Error('Invalid evaluation attempt id');
    const combination = `${attempt.caseId}:${attempt.repetition}`;
    if (combinations.has(combination)) throw new Error('Duplicate evaluation attempt'); combinations.add(combination);
    if (!statuses.includes(attempt.status as string) || typeof attempt.passed !== 'boolean' || typeof attempt.admitted !== 'boolean'
      || attempt.passed !== (attempt.status === 'passed')) throw new Error('Invalid evaluation attempt status');
    if ((attempt.status === 'denied' && attempt.admitted) || (['passed', 'failed'].includes(attempt.status as string) && !attempt.admitted)) throw new Error('Invalid evaluation admission');
    if (Object.hasOwn(attempt, 'outputDigest')) digest(attempt.outputDigest);
    if (Object.hasOwn(attempt, 'usage') && hash(usage(attempt.usage)) !== hash(attempt.usage)) throw new Error('Invalid report usage');
    if (!Array.isArray(attempt.scores) || attempt.scores.length > scorerIds.length) throw new Error('Invalid report scores');
    for (const [scoreIndex, result] of attempt.scores.entries()) {
      const entry = object(result, ['scorerId', 'value', 'passed', 'code'], 'evaluation attempt score');
      if (entry.scorerId !== scorerIds[scoreIndex]) throw new Error('Invalid report scorer identity');
      const { scorerId: _id, ...scoreValue } = entry;
      if (hash(score(scoreValue)) !== hash(scoreValue)) throw new Error('Invalid report score');
    }
    if (['passed', 'failed'].includes(attempt.status as string)) {
      if (attempt.scores.length !== scorerIds.length || attempt.outputDigest === undefined || attempt.failure !== undefined
        || attempt.passed !== attempt.scores.every(result => result.passed)) throw new Error('Unverified evaluation outcome');
    } else {
      const failure = object(attempt.failure, ['phase', 'code'], 'evaluation failure');
      if (!['admission', 'execution', 'verification'].includes(failure.phase as string)
        || typeof failure.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)) throw new Error('Invalid evaluation failure');
      if (attempt.status === 'denied' && (failure.phase !== 'admission' || failure.code !== 'BUDGET_DENIED')) throw new Error('Invalid evaluation denial');
      if (attempt.status === 'cancelled' && failure.code !== 'CANCELLED') throw new Error('Invalid evaluation cancellation');
      if (attempt.status === 'timed-out' && failure.code !== 'DEADLINE_EXCEEDED') throw new Error('Invalid evaluation deadline');
      if (attempt.status === 'error' && (!attempt.admitted || failure.phase === 'admission'
        || (failure.phase === 'execution' && !['EXECUTION_ERROR', 'INVALID_OUTPUT'].includes(failure.code))
        || (failure.phase === 'verification' && !['SCORER_ERROR', 'INVALID_SCORE'].includes(failure.code)))) throw new Error('Invalid evaluation error');
      if (failure.phase !== 'verification' && (attempt.scores.length > 0 || attempt.outputDigest !== undefined || attempt.usage !== undefined)) throw new Error('Invalid evaluation failure artifacts');
      if (failure.phase === 'verification' && attempt.outputDigest === undefined) throw new Error('Missing evaluation verification digest');
    }
    if (Object.hasOwn(attempt, 'budgetDenied') && (attempt.budgetDenied !== true || attempt.admitted
      || !['denied', 'cancelled', 'timed-out'].includes(attempt.status as string)
      || (attempt.failure as { phase: unknown }).phase !== 'admission')) throw new Error('Invalid evaluation budget rejection');
  }
  const report = item as unknown as EvaluationReport;
  if (hash(report.metrics) !== hash(metrics(report.attempts, report.suite.caseIds, report.repetitions))
    || hash(report.usage) !== hash(aggregateUsage(report.attempts))) throw new Error('Evaluation report aggregate mismatch');
  const { digest: _digest, ...body } = report;
  if (hash(body) !== report.digest) throw new Error('Evaluation report digest mismatch');
  return report;
}
export function attemptId(id: string, caseId: string, repetition: number): string { return `eval-${hash({ id, caseId, repetition })}`; }
export function compareEvaluations(baseline: EvaluationReport, candidate: EvaluationReport): EvaluationComparison {
  const left = validateEvaluationReport(baseline), right = validateEvaluationReport(candidate);
  if (left.suiteDigest !== right.suiteDigest || hash(left.suite) !== hash(right.suite)
    || left.scorerDigest !== right.scorerDigest || left.repetitions !== right.repetitions) throw new Error('Incompatible evaluation corpus, scorers or repetitions');
  const rate = (report: EvaluationReport) => report.metrics.passed / (report.suite.caseIds.length * report.repetitions);
  return snapshot({
    comparable: true, baselineId: left.id, candidateId: right.id,
    baselineProfileDigest: left.profileDigest, candidateProfileDigest: right.profileDigest,
    baselineSourceDigest: left.profile.sourceDigest, candidateSourceDigest: right.profile.sourceDigest,
    deltas: { passRate: rate(right) - rate(left), firstPassRate: right.metrics.firstPassRate - left.metrics.firstPassRate,
      consistencyRate: right.metrics.consistencyRate - left.metrics.consistencyRate,
      durationP50Ms: right.metrics.durationMs.p50 - left.metrics.durationMs.p50, durationP95Ms: right.metrics.durationMs.p95 - left.metrics.durationMs.p95 },
  });
}
