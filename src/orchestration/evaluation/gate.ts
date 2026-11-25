import type { Usage } from '../../public/types.js';
import type { ObservedTaskBudget } from '../tasks/index.js';
import { checksum } from '../workflow/checkpoint.js';
import type { JsonValue } from '../workflow/types.js';
import { checkPostcondition, declaredPostconditions, PostconditionRegistry } from './postconditions.js';
import type { PostconditionDeclaration, PostconditionResult, PostconditionVerifier } from './postconditions.js';
import { compareEvaluations, validateEvaluationReport } from './report.js';
import { runEvaluation } from './runner.js';
import type { EvaluationAttemptContext, EvaluationAttemptStatus, EvaluationComparison, EvaluationProfile,
  EvaluationReport, EvaluationScorer, EvaluationSuite, EvaluationTraceWriter } from './types.js';
import { digest, hash, identifier, integer, object, profile, snapshot, suite } from './validation.js';

export type PromotionChange = 'harness' | 'model' | 'prompt';

/** What one run hands back. `state` says where to look; `claim` is what the agent said. */
export interface PromotionRunResult {
  state: JsonValue;
  /** The agent's final message. Recorded as a digest and never shown to a verifier. */
  claim?: string;
  usage?: Usage;
}

/** One version of a system: its harness and model (the profile), its prompt, and how to run it. */
export interface PromotionSubject {
  profile: EvaluationProfile;
  /** SHA-256 of the prompt text this version runs with. */
  promptDigest: string;
  /**
   * Must stop its work and settle when `context.signal` aborts. The gate waits for it to settle
   * before it gives the attempt's admission slot back, because the run may still have a provider
   * process alive: a run that ignores the signal keeps the gate pending and its slot held.
   */
  run(input: JsonValue, context: EvaluationAttemptContext): PromotionRunResult | Promise<PromotionRunResult>;
}

/** The `candidate` of an earlier decision that was promoted, reused instead of running it again. */
export interface RecordedBaseline {
  report: EvaluationReport;
  promptDigest: string;
}

export interface PromotionGateOptions {
  id: string;
  /** The manifest's declared postconditions. Every one needs a registered verifier. */
  postconditions: readonly PostconditionDeclaration[];
  verifiers: PostconditionRegistry;
  suite: EvaluationSuite;
  baseline: PromotionSubject | RecordedBaseline;
  candidate: PromotionSubject;
  repetitions?: number;
  /**
   * Per attempt, and it includes the wait for admission: size it for a canary that queues. At the
   * deadline the attempt's signal aborts. A verifier is cut off right then; a `run` is waited for.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Admission for every attempt. Use `canaryBudget` so these runs yield to production. */
  budget?: ObservedTaskBudget;
  trace?: EvaluationTraceWriter;
}

export type PromotionBlock =
  | { code: 'NO_POSTCONDITIONS' }
  | { code: 'VERIFIER_MISSING'; postconditionId: string }
  | { code: 'BASELINE_INCOMPARABLE' }
  | { code: 'BASELINE_INCOMPLETE' | 'CANDIDATE_INCOMPLETE'; planned: number; completed: number }
  | { code: 'POSTCONDITION_FAILED'; postconditionId: string; failedAttempts: number; regression: boolean };

export type PostconditionStanding = 'verified' | 'failed' | 'not-verified' | 'unverifiable';

export interface PromotionAttemptEvidence {
  attemptId: string;
  caseId: string;
  repetition: number;
  status: EvaluationAttemptStatus;
  claimDigest?: string;
  postconditions: readonly PostconditionResult[];
}

export interface PromotionSide {
  profileDigest: string;
  promptDigest: string;
  report: EvaluationReport;
  /** Per-attempt evidence. Empty for a recorded baseline, whose evidence is in its own decision. */
  attempts: readonly PromotionAttemptEvidence[];
}

export interface PromotionDecision {
  format: 1;
  id: string;
  /** `unchanged`: harness, model and prompt are the same, so nothing was run. */
  decision: 'promote' | 'block' | 'unchanged';
  changed: readonly PromotionChange[];
  /** Every reason promotion is blocked. Empty unless `decision` is `block`. */
  blocks: readonly PromotionBlock[];
  postconditions: readonly {
    id: string;
    description: string;
    verifierVersion: string | null;
    baseline: PostconditionStanding;
    candidate: PostconditionStanding;
  }[];
  baseline?: PromotionSide;
  candidate?: PromotionSide;
  comparison?: EvaluationComparison;
  decidedAt: number;
  /** SHA-256 of everything above: detects a corrupted record, it does not authenticate one. */
  digest: string;
}

interface Version { profile: EvaluationProfile; promptDigest: string }
interface Declared { declaration: PostconditionDeclaration; verifier: PostconditionVerifier | undefined; scorerId: string }
type Captured = ReturnType<typeof capture>;

function isRecorded(value: PromotionSubject | RecordedBaseline): value is RecordedBaseline {
  return Object.hasOwn(value, 'report');
}

function capture(input: PromotionGateOptions) {
  const keys = ['id', 'postconditions', 'verifiers', 'suite', 'baseline', 'candidate', 'repetitions', 'timeoutMs', 'signal', 'budget', 'trace'];
  const options = object(input, keys, 'promotion gate options') as unknown as PromotionGateOptions;
  identifier(options.id);
  identifier(`${options.id}:candidate`);
  if (!(options.verifiers instanceof PostconditionRegistry)) throw new Error('Promotion gate verifiers must be a PostconditionRegistry');
  const repetitions = options.repetitions === undefined ? 1 : options.repetitions;
  integer(repetitions, 1, 100);

  const subject = (value: unknown, label: string): PromotionSubject => {
    const item = object(value, ['profile', 'promptDigest', 'run'], label);
    digest(item.promptDigest);
    if (typeof item.run !== 'function') throw new Error(`Invalid ${label}`);
    return { profile: profile(item.profile), promptDigest: item.promptDigest, run: item.run as PromotionSubject['run'] };
  };
  let baseline: PromotionSubject | RecordedBaseline;
  if (options.baseline !== null && typeof options.baseline === 'object' && isRecorded(options.baseline)) {
    const item = object(options.baseline, ['report', 'promptDigest'], 'recorded baseline');
    digest(item.promptDigest);
    baseline = { report: validateEvaluationReport(item.report), promptDigest: item.promptDigest };
  } else {
    baseline = subject(options.baseline, 'baseline subject');
  }

  const declared: Declared[] = declaredPostconditions(options.postconditions).map(declaration => ({
    declaration,
    verifier: options.verifiers.get(declaration.id),
    // Manifest ids are free text; the evaluation report needs a plain identifier.
    scorerId: `post-${checksum(declaration.id).slice(0, 40)}`,
  }));
  return { ...options, repetitions, suite: suite(options.suite), baseline, candidate: subject(options.candidate, 'candidate subject'), declared };
}

function changes(baseline: Version, candidate: Version): PromotionChange[] {
  const before = baseline.profile, after = candidate.profile;
  const changed: PromotionChange[] = [];
  if (before.sourceDigest !== after.sourceDigest || before.transport !== after.transport || before.optionsDigest !== after.optionsDigest) changed.push('harness');
  if (before.provider !== after.provider || before.model !== after.model) changed.push('model');
  if (baseline.promptDigest !== candidate.promptDigest) changed.push('prompt');
  return changed;
}

function runResult(value: unknown): PromotionRunResult {
  const item = object(value, ['state', 'claim', 'usage'], 'promotion run result');
  if (!Object.hasOwn(item, 'state')) throw new Error('A promotion run must report where its state is');
  if (item.claim !== undefined && typeof item.claim !== 'string') throw new Error('Invalid promotion run claim');
  return item as unknown as PromotionRunResult;
}

/** Runs one version through the suite with one scorer per declared postcondition. */
async function evaluate(options: Captured, side: 'baseline' | 'candidate', version: PromotionSubject): Promise<PromotionSide> {
  const inputs = new Map(options.suite.cases.map(entry => [entry.id, entry.input]));
  const claims = new Map<string, string>();
  const evidence = new Map<string, PostconditionResult[]>();

  const scorers = options.declared.map(({ verifier, scorerId }): EvaluationScorer => ({
    id: scorerId,
    version: verifier!.version,
    async score(state, expected, context) {
      const result = await checkPostcondition(verifier!, {
        state, expected, input: inputs.get(context.caseId) ?? null,
        caseId: context.caseId, attemptId: context.attemptId, repetition: context.repetition,
        signal: context.signal, deadline: context.deadline,
      }, claims.get(context.attemptId));
      evidence.set(context.attemptId, [...(evidence.get(context.attemptId) ?? []), result]);
      const verified = result.status === 'verified';
      return { value: verified ? 1 : 0, passed: verified, ...(result.code === undefined ? {} : { code: result.code }) };
    },
  }));

  const report = await runEvaluation({
    id: `${options.id}:${side}`,
    suite: options.suite,
    profile: version.profile,
    repetitions: options.repetitions,
    scorers,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    async execute(input, context) {
      const result = runResult(await version.run(input, context));
      // Only the state goes on to the verifiers. The claim stays here, outside their reach.
      if (result.claim !== undefined) claims.set(context.attemptId, result.claim);
      return { output: result.state, ...(result.usage === undefined ? {} : { usage: result.usage }) };
    },
  });

  const attempts = report.attempts.map((attempt): PromotionAttemptEvidence => {
    const claim = claims.get(attempt.id);
    return {
      attemptId: attempt.id, caseId: attempt.caseId, repetition: attempt.repetition, status: attempt.status,
      ...(claim === undefined ? {} : { claimDigest: checksum(claim) }),
      postconditions: evidence.get(attempt.id) ?? [],
    };
  });
  return { profileDigest: report.profileDigest, promptDigest: version.promptDigest, report, attempts };
}

function planned(report: EvaluationReport): number {
  return report.suite.caseIds.length * report.repetitions;
}

/** Attempts whose every postcondition got an answer, verified or failed. */
function completed(report: EvaluationReport): number {
  return report.attempts.filter(attempt => attempt.status === 'passed' || attempt.status === 'failed').length;
}

function failures(report: EvaluationReport, scorerId: string): number {
  return report.attempts.filter(attempt => attempt.scores.some(score => score.scorerId === scorerId && !score.passed)).length;
}

function standing(report: EvaluationReport | undefined, scorerId: string): PostconditionStanding {
  if (report === undefined) return 'not-verified';
  if (failures(report, scorerId) > 0) return 'failed';
  const answered = report.attempts.filter(attempt => attempt.scores.some(score => score.scorerId === scorerId)).length;
  return answered === planned(report) ? 'verified' : 'not-verified';
}

/**
 * Decides whether a changed harness, model or prompt may replace the baseline.
 *
 * "Done" is a verified postcondition: each declared postcondition is checked by its registered
 * verifier against the state every run left behind, for every case and repetition. Promotion is
 * blocked when one fails, when one has no verifier, when the system declares none, or when the
 * evaluation could not be completed or compared. The agent's final message decides nothing.
 *
 * A run is spent only when it can change the answer: an unchanged candidate, a missing verifier
 * and an incomparable recorded baseline are decided without running anything, and the candidate is
 * not run when the baseline could not be completed. Malformed input throws. The returned decision
 * is frozen JSON the caller can record as is.
 */
export async function runPromotionGate(input: PromotionGateOptions): Promise<PromotionDecision> {
  const options = capture(input);
  const recorded = isRecorded(options.baseline) ? options.baseline : undefined;
  const changed = changes(recorded ? { profile: recorded.report.profile, promptDigest: recorded.promptDigest } : options.baseline as PromotionSubject, options.candidate);
  const blocks: PromotionBlock[] = [];
  let baseline: PromotionSide | undefined;
  let candidate: PromotionSide | undefined;
  let comparison: EvaluationComparison | undefined;

  if (changed.length > 0) {
    if (options.declared.length === 0) blocks.push({ code: 'NO_POSTCONDITIONS' });
    for (const { declaration, verifier } of options.declared) {
      if (verifier === undefined) blocks.push({ code: 'VERIFIER_MISSING', postconditionId: declaration.id });
    }
  }
  if (changed.length > 0 && blocks.length === 0) {
    if (recorded) {
      const report = recorded.report;
      const scorers = options.declared.map(({ scorerId, verifier }) => ({ id: scorerId, version: verifier!.version }));
      baseline = { profileDigest: report.profileDigest, promptDigest: recorded.promptDigest, report, attempts: [] };
      if (report.suiteDigest !== hash(options.suite) || report.scorerDigest !== hash(scorers) || report.repetitions !== options.repetitions) {
        blocks.push({ code: 'BASELINE_INCOMPARABLE' });
      }
    } else {
      baseline = await evaluate(options, 'baseline', options.baseline as PromotionSubject);
    }
    if (blocks.length === 0 && completed(baseline.report) < planned(baseline.report)) {
      blocks.push({ code: 'BASELINE_INCOMPLETE', planned: planned(baseline.report), completed: completed(baseline.report) });
    }
  }
  if (changed.length > 0 && blocks.length === 0 && baseline !== undefined) {
    candidate = await evaluate(options, 'candidate', options.candidate);
    const report = candidate.report;
    if (completed(report) < planned(report)) blocks.push({ code: 'CANDIDATE_INCOMPLETE', planned: planned(report), completed: completed(report) });
    for (const { declaration, scorerId } of options.declared) {
      const failedAttempts = failures(report, scorerId);
      if (failedAttempts === 0) continue;
      const regression = standing(baseline.report, scorerId) === 'verified';
      blocks.push({ code: 'POSTCONDITION_FAILED', postconditionId: declaration.id, failedAttempts, regression });
    }
    try {
      comparison = compareEvaluations(baseline.report, report);
    } catch {
      blocks.push({ code: 'BASELINE_INCOMPARABLE' });
    }
  }

  const postconditions = options.declared.map(({ declaration, verifier, scorerId }) => ({
    id: declaration.id,
    description: declaration.description,
    verifierVersion: verifier?.version ?? null,
    baseline: verifier === undefined ? 'unverifiable' as const : standing(baseline?.report, scorerId),
    candidate: verifier === undefined ? 'unverifiable' as const : standing(candidate?.report, scorerId),
  }));
  const body = {
    format: 1 as const,
    id: options.id,
    decision: changed.length === 0 ? 'unchanged' as const : blocks.length === 0 ? 'promote' as const : 'block' as const,
    changed,
    blocks,
    postconditions,
    ...(baseline === undefined ? {} : { baseline }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(comparison === undefined ? {} : { comparison }),
    decidedAt: Date.now(),
  };
  return snapshot({ ...body, digest: hash(body) });
}
