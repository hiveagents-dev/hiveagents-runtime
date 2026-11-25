import type { AgentEvent, Usage } from '../../public/types.js';
import type { ObservedTaskBudget } from '../tasks/index.js';
import type { JsonValue } from '../workflow/types.js';

export interface EvaluationCase { id: string; input: JsonValue; expected: JsonValue }
export interface EvaluationSuite { id: string; version: string; cases: readonly EvaluationCase[] }
export interface EvaluationProfile {
  id: string; version: string; sourceDigest: string;
  provider?: string; model?: string; transport?: string; optionsDigest?: string;
}
/** Compatible with the tracing module's minimal TraceWriter port. */
export interface EvaluationTraceWriter {
  append(event: { type: string; phaseId?: string; status?: string; code?: string; count?: number }): Promise<void>;
  observe?(event: AgentEvent): Promise<void>;
}
export interface EvaluationAttemptContext {
  attemptId: string; caseId: string; repetition: number;
  signal: AbortSignal;
  /** Epoch milliseconds; includes admission, tracing, execution and verification. */
  deadline: number;
  recordEvent(event: AgentEvent): Promise<void>;
}
export interface EvaluationScore { value: number; passed: boolean; code?: string }
export interface EvaluationScorer {
  id: string; version: string;
  score(output: JsonValue, expected: JsonValue, context: EvaluationAttemptContext): EvaluationScore | Promise<EvaluationScore>;
}
export interface RunEvaluationOptions {
  id: string; suite: EvaluationSuite; profile: EvaluationProfile;
  repetitions?: number; timeoutMs?: number; signal?: AbortSignal;
  budget?: ObservedTaskBudget; trace?: EvaluationTraceWriter;
  execute(input: JsonValue, context: EvaluationAttemptContext): { output: JsonValue; usage?: Usage }
    | Promise<{ output: JsonValue; usage?: Usage }>;
  scorers: readonly EvaluationScorer[];
}
export type EvaluationAttemptStatus = 'passed' | 'failed' | 'error' | 'denied' | 'cancelled' | 'timed-out';
export type EvaluationFailurePhase = 'admission' | 'execution' | 'verification';
export interface EvaluationAttempt {
  id: string; caseId: string; repetition: number; status: EvaluationAttemptStatus;
  passed: boolean; admitted: boolean; durationMs: number; outputDigest?: string;
  /** Preserves an observed budget rejection if terminal tracing later times out or is cancelled. */
  budgetDenied?: true;
  scores: readonly (EvaluationScore & { scorerId: string })[];
  failure?: { phase: EvaluationFailurePhase; code: string };
  usage?: Usage;
}
export interface EvaluationCoverage { known: number; total: number | null }
export interface EvaluationUsage {
  attempts: number;
  inputTokens: EvaluationCoverage; outputTokens: EvaluationCoverage;
  cachedInputTokens: EvaluationCoverage; cacheCreationTokens: EvaluationCoverage;
  reportedCostUsd: readonly (EvaluationCoverage & { costMeaning: Usage['costMeaning'] })[];
}
export interface EvaluationMetrics {
  total: number; passed: number; firstPassRate: number;
  /** One entry per deliberate repetition, each measured over the entire corpus. */
  repetitionPassRates: readonly number[];
  /** Fraction of cases with all repetitions observed and exactly one output digest. */
  consistencyRate: number;
  durationMs: { p50: number; p95: number };
  /** Counts evaluation admission, not native provider launches. */
  admissions: number; denials: number;
}
export interface EvaluationReport {
  format: 1; id: string; suite: { id: string; version: string; caseIds: readonly string[] }; suiteDigest: string;
  scorers: readonly { id: string; version: string }[]; scorerDigest: string;
  profile: EvaluationProfile; profileDigest: string; repetitions: number; timeoutMs: number;
  startedAt: number; completedAt: number; attempts: readonly EvaluationAttempt[];
  metrics: EvaluationMetrics; usage: EvaluationUsage; digest: string;
}
export interface EvaluationComparison {
  comparable: true; baselineId: string; candidateId: string;
  baselineProfileDigest: string; candidateProfileDigest: string;
  baselineSourceDigest: string; candidateSourceDigest: string;
  deltas: { passRate: number; firstPassRate: number; consistencyRate: number; durationP50Ms: number; durationP95Ms: number };
}
