import type { StopReason } from './curation-support.js';
import type { CuratorJournal } from './curator-journal.js';
import type { MemoryConditionTally, MemoryGateRefusal } from './gate.js';
import type { MeasureMemoryOptions } from './measurement.js';
import type { MemoryEmbedder, MemoryScope, ScopedMemoryRecord } from './ports.js';
import type { MemoryListQuery, MemoryPromotion, MemoryPromotionResult, MemoryRecordView } from './store-types.js';

/** Provenance `source` of every candidate the curator stores. */
export const CURATOR_SOURCE = 'curator';
export const CURATOR_DEFAULT_MAX_CANDIDATES = 3;
export const CURATOR_MAX_CANDIDATES_CEILING = 8;
export const CURATOR_DEFAULT_MAX_TEXT = 1000;
/** Half of `MEMORY_DEFAULT_MAX_BYTES`: a lesson fits the default recall budget with room for its header. */
export const CURATOR_MAX_TEXT_CEILING = 4096;

/**
 * What the curator needs from a store, structurally: `SqliteSystemMemory` and the
 * vector stores of `hiveagents-runtime-agentdb-memory` both have it. `list` must
 * report each record's `contentDigest` as the store's `promote` checks it, newest first,
 * and leave out withdrawn (revoked, rolled back) records.
 */
export interface CuratableStore {
  list(query: MemoryListQuery): Promise<readonly MemoryRecordView[]>;
  put(record: ScopedMemoryRecord, signal?: AbortSignal): Promise<void>;
  promote(promotion: MemoryPromotion): Promise<MemoryPromotionResult>;
}

/** One unpromoted episode as `distill` sees it. Its text is untrusted data. */
export interface CuratorEpisode {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly observedAt: string;
}

/**
 * A lesson `distill` proposes; `sources` are ids of the episodes it was drawn from.
 * A `title` is checked (a memory label) but never stored: recall would render it, and the
 * gate measures the text alone.
 */
export interface CuratorProposal {
  readonly text: string;
  readonly title?: string;
  readonly sources: readonly string[];
}

export interface CuratorDistillContext {
  readonly scope: MemoryScope;
  /** Aborts on the caller's signal or the pass deadline; the pass stops waiting either way. */
  readonly signal: AbortSignal;
  /** At most this many proposals are considered. */
  readonly maxCandidates: number;
}

export type CuratorDistill = (
  episodes: readonly CuratorEpisode[], context: CuratorDistillContext,
) => Promise<readonly CuratorProposal[]>;

export interface CurateMemoryOptions {
  store: CuratableStore;
  scope: MemoryScope;
  distill: CuratorDistill;
  /** Recorded as `provenance.sourceVersion` of each candidate: which distiller (model, prompt revision) wrote it. */
  distillerId: string;
  /** Exactly what `measureMemory` takes; each candidate is the only memory of the `memory` condition. */
  tasks: MeasureMemoryOptions['tasks'];
  run: MeasureMemoryOptions['run'];
  history: MeasureMemoryOptions['history'];
  /** Recorded as the promoter. Default: `curator`. */
  by?: string;
  /** Needed by a store that refuses records without a vector, such as the agentdb-memory stores. */
  embedder?: MemoryEmbedder;
  /** Candidates measured per pass: default 3, at most 8. */
  maxCandidates?: number;
  /** Newest eligible episodes handed to `distill`: default 32, at most 256. */
  maxEpisodes?: number;
  /** Longest candidate text, in characters: default 1000, at most 4096. */
  maxTextChars?: number;
  /** Whole-pass deadline in milliseconds. Default: 30 minutes. */
  deadlineMs?: number;
  /**
   * Fewer tasks than this: every candidate is refused as INSUFFICIENT_EVIDENCE, unmeasured. Default 5, at most 1024.
   * Candidates are also refused so, unmeasured, when even a clean sweep of every task (twice with `confirm`) could
   * not pass the sign test at `alpha`: 7 tasks at 0.01 without `confirm`, 5 at 0.05 (`report.acceptance.minWins`).
   */
  minTasks?: number;
  /**
   * Discordant tasks the candidate must win beyond those it loses (`memoryOnly - noMemoryOnly`; BELOW_MARGIN
   * otherwise). Default 2, at least 1.
   */
  minMargin?: number;
  /**
   * Significance level of the one-sided exact sign test over the discordant tasks (NOT_SIGNIFICANT above it):
   * the most a lesson with no effect may be promoted per measured candidate. Default 0.01, from above 0 to 0.5.
   * With `confirm` it applies to the pooled evidence of both measurements.
   */
  alpha?: number;
  /**
   * Two-stage confirmation. Default true. A candidate whose first measurement passes the store gate, the margin
   * and the sign test at `pendingAlpha` is not promoted: it is journaled `pending` with its counts and measured
   * again, with fresh runs, by a later pass (pending candidates go before new ones). It is promoted only when the
   * POOLED discordant tasks of both measurements pass the store gate, the margin and the sign test at `alpha`, so
   * a lesson with no effect is still promoted at most `alpha` of the times it is measured. False: one measurement
   * at `alpha` decides, as before.
   */
  confirm?: boolean;
  /**
   * With `confirm`: the sign-test level a first measurement must reach to become pending (NOT_SIGNIFICANT above
   * it). Default 0.25 (or `alpha`, when higher), from `alpha` to 0.5. It only decides which candidates earn a
   * second measurement; the promotion itself rests on the pooled test at `alpha`.
   */
  pendingAlpha?: number;
  /**
   * With `confirm`: how long a pending candidate waits for its confirming measurement; past it, it is refused as
   * CONFIRMATION_EXPIRED. Default 3 days, from 1 ms to 30 days.
   */
  confirmWithinMs?: number;
  /**
   * Measurements (first or confirming) in this scope over any rolling 24 hours, reserved in the journal before
   * each one runs; past it candidates are held (MEASUREMENT_BUDGET), unmeasured. Default 6, at most 64. It bounds
   * how often the scope draws on the sign test's `alpha`, however often passes run.
   */
  maxMeasurementsPerDay?: number;
  /**
   * Token-set similarity (Jaccard over the normalized words of the text) at or above which a candidate is a
   * paraphrase of one refused, screened out or rolled back within `episodeCooldownMs`: it is held
   * (PARAPHRASE_COOLDOWN), unmeasured. Default 0.8, from 0.5 to 1. `episodeCooldownMs: 0` disables it, as does
   * `remeasureRefused`.
   */
  paraphraseSimilarity?: number;
  /**
   * The application's safety screen, asked about each new candidate before it is stored or measured. The gate
   * measures usefulness, not safety: a lesson with no effect on the tasks (and some with an effect) that carries
   * an injected instruction passes it as often as any other. A refused candidate is journaled as SCREENED (its
   * episodes cool down) and never stored, measured or promoted; a screen that throws or answers anything but
   * `{ allow: boolean }` is an `error` at stage `screen`: the candidate is not measured and a later pass asks again.
   */
  screen?: CuratorScreen;
  /** Candidates promoted in one pass; the rest are held (PROMOTION_BUDGET), unmeasured. Default 1, at most 8. */
  maxPromotionsPerPass?: number;
  /**
   * Candidates promoted in this scope over any rolling 24 hours, counted in the journal; past it candidates are
   * held (PROMOTION_BUDGET), unmeasured. Default 3, at most 64.
   */
  maxPromotionsPerDay?: number;
  /**
   * Where refusals, promotions and episode cooldowns are kept between passes. Default: an
   * in-memory journal per store object, which lasts only as long as this process: without a
   * persistent journal (`fileCuratorJournal`), every retry protection is per process.
   */
  journal?: CuratorJournal;
  /** Measure again a candidate the journal records as refused. Default false. */
  remeasureRefused?: boolean;
  /**
   * How long an episode that produced a refused, rolled-back or pending candidate is not offered to
   * `distill`, nor any episode with the same normalized text; also how long a refused, screened-out or
   * rolled-back candidate holds its paraphrases back. Default 7 days; 0 disables both cooldowns.
   */
  episodeCooldownMs?: number;
  /** Promoted candidates that may cite one episode, or episodes of one normalized text, ever: default 1, at most 16. */
  maxPromotionsPerEpisode?: number;
  signal?: AbortSignal;
  /** Clock of cooldowns, and of `observedAt` when no cited episode has a usable one. Default: the system clock. */
  now?: () => Date;
}

export type CuratorInvalidReason = 'SHAPE' | 'TEXT' | 'TITLE' | 'SOURCES' | 'DUPLICATE' | 'OVER_LIMIT';

/** Why the application's screen refused a candidate. Anything else it answers is recorded as POLICY. */
export type CuratorScreenReason = 'INSTRUCTION_OVERRIDE' | 'EXFILTRATION' | 'SECRET' | 'PERSONAL_DATA' | 'HARMFUL' | 'POLICY';

export interface CuratorScreenVerdict {
  allow: boolean;
  reason?: CuratorScreenReason;
}

/** What the screen sees: the candidate's text (untrusted model output) and the episodes it cites. */
export interface CuratorScreenCandidate {
  readonly id: string;
  readonly text: string;
  readonly sources: readonly string[];
}

export type CuratorScreen = (
  candidate: CuratorScreenCandidate, context: { readonly scope: MemoryScope; readonly signal: AbortSignal },
) => Promise<CuratorScreenVerdict>;

/**
 * Why a candidate was not promoted: the store gate's reason, BELOW_MARGIN (it won fewer than
 * `minMargin` discordant tasks beyond those it lost), NOT_SIGNIFICANT (the sign test's p-value is
 * above `alpha`, or above `pendingAlpha` on a first measurement under `confirm`),
 * INSUFFICIENT_EVIDENCE (fewer than `minTasks` tasks, or too few for the sign test to ever pass:
 * not measured, not stored, not journaled), SCREENED (the application's screen refused it:
 * never stored or measured), CONFIRMATION_EXPIRED (pending longer than `confirmWithinMs`) or
 * TASKS_CHANGED (pending, and the task set no longer has the first measurement's task count: the
 * two are not pooled).
 * Under `confirm`, a refusal that carries `pooled` was decided on both measurements.
 */
export type CuratorRefusal =
  | MemoryGateRefusal | 'BELOW_MARGIN' | 'NOT_SIGNIFICANT' | 'INSUFFICIENT_EVIDENCE' | 'SCREENED' | 'CONFIRMATION_EXPIRED'
  | 'TASKS_CHANGED';

/**
 * Why a candidate was not measured: the journal records it as refused (`REFUSED_EARLIER`) or
 * rolled back (`ROLLED_BACK`), it cites an episode that is cooling down after a refusal
 * (`EPISODE_COOLDOWN`) or that already backs `maxPromotionsPerEpisode` promotions (`EPISODE_LIMIT`),
 * the pass or the scope's rolling day already promoted its budget (`PROMOTION_BUDGET`), the
 * scope's rolling day already ran `maxMeasurementsPerDay` measurements (`MEASUREMENT_BUDGET`), its
 * text is a near-duplicate of a candidate refused or rolled back within the cooldown
 * (`PARAPHRASE_COOLDOWN`), it is already pending confirmation (`PENDING`), the scope already
 * holds the most pending candidates it may (`PENDING_LIMIT`), or a pending candidate is not in the
 * store listing (`NOT_LISTED`). A held candidate is not journaled: a later pass may measure it.
 */
export type CuratorHoldReason =
  | 'REFUSED_EARLIER' | 'ROLLED_BACK' | 'EPISODE_COOLDOWN' | 'EPISODE_LIMIT' | 'PROMOTION_BUDGET'
  | 'MEASUREMENT_BUDGET' | 'PARAPHRASE_COOLDOWN' | 'PENDING' | 'PENDING_LIMIT' | 'NOT_LISTED';

/** The evidence of both measurements of a confirmed candidate, pooled: counts only. */
export interface CuratorPooledEvidence {
  /** Measurements pooled: 2. */
  measurements: number;
  /** Tasks run under each condition, over both measurements. */
  tasks: number;
  discordant: { memoryOnly: number; noMemoryOnly: number };
  pValue: number;
  /** Digests of the two measurement reports, first one first. */
  digests: [string, string];
}

/** The acceptance rule a pass applied, so the application can see what its task set can detect. */
export interface CuratorAcceptance {
  /** Tasks in one measurement. */
  tasks: number;
  alpha: number;
  minMargin: number;
  confirm: boolean;
  /** With `confirm`: the level a first measurement must reach to become pending. */
  pendingAlpha?: number;
  /**
   * The fewest discordant tasks, all won by the candidate, with which the sign test can pass at
   * `alpha` (5 at 0.05, 7 at 0.01). A measurement rarely makes more than a third to a half of its
   * tasks discordant, so a task set much smaller than a few times this detects only large effects.
   */
  minWins: number;
  /** False when `tasks` (twice, with `confirm`) is below `minTasks` or `minWins`: every candidate is INSUFFICIENT_EVIDENCE. */
  possible: boolean;
}

/** The measured comparison behind a decision: counts only, no text. */
export interface CuratorMeasurement {
  id: string;
  digest: string;
  noMemory: MemoryConditionTally;
  memory: MemoryConditionTally;
  fullHistory: MemoryConditionTally;
  /** The paired tasks the decision rests on: those exactly one of memory and no memory passed. */
  discordant: { memoryOnly: number; noMemoryOnly: number };
  /** One-sided exact sign test over `discordant`: the chance of a result this good from a lesson with no effect. */
  pValue: number;
}

export type CuratorCandidateOutcome =
  /** `pooled` is present when `confirm` promoted it on two measurements; `measurement` is then the second. */
  | { id: string; status: 'promoted'; promotedAt: string; measurement: CuratorMeasurement; pooled?: CuratorPooledEvidence }
  /**
   * `measurement` is absent for INSUFFICIENT_EVIDENCE, SCREENED and CONFIRMATION_EXPIRED; `pooled` is present for a
   * refusal decided on two measurements; `screen` is the screen's reason for SCREENED.
   */
  | {
    id: string; status: 'refused'; reason: CuratorRefusal; measurement?: CuratorMeasurement; pooled?: CuratorPooledEvidence;
    screen?: CuratorScreenReason;
  }
  /** First measurement passed under `confirm`: journaled, measured again by a later pass before `until`. */
  | { id: string; status: 'pending'; measurement: CuratorMeasurement; until: string }
  | { id: string; status: 'held'; reason: CuratorHoldReason }
  /** Stored by an earlier pass and no longer an episode: never measured or promoted again. */
  | { id: string; status: 'existing'; state: 'lesson' | 'invalidated' | 'expired' }
  /**
   * Fail-closed: the candidate was not promoted, and no decision about it was journaled, so a
   * later pass may measure it. `journal`: its promotion could not be reserved, so the store was
   * not asked and the pass stops (`failure`). `promote`: the store refused or failed after the
   * reservation, which is kept: the slot of the day and the count of its episodes stay used.
   * `error` is a code or class name, never a message.
   */
  | { id: string; status: 'error'; stage: 'screen' | 'store' | 'measure' | 'journal' | 'promote'; error: string }
  /** The pass stopped before this candidate. */
  | { id: string; status: 'skipped' };

/** JSON-serializable; holds ids, counts and codes, never episode or candidate text. */
export interface CuratorReport {
  format: 1;
  scope: MemoryScope;
  distillerId: string;
  /** Episodes handed to `distill`. */
  episodes: number;
  /** Unpromoted episodes left out because they are cooling down or at their promotion limit. */
  episodesHeld: number;
  /** Unpromoted episodes left out because a newer one with the same normalized text was offered instead. */
  episodesMerged: number;
  /** Entries `distill` returned. */
  proposed: number;
  /** Pending candidates' confirmations first, then this pass's candidates in proposal order. */
  candidates: CuratorCandidateOutcome[];
  invalid: { index: number; reason: CuratorInvalidReason }[];
  promoted: number;
  refused: number;
  held: number;
  errors: number;
  /** Candidates that became pending in this pass. */
  pending: number;
  /** Measurements this pass reserved against `maxMeasurementsPerDay` (first and confirming). */
  measured: number;
  acceptance: CuratorAcceptance;
  /**
   * `list` or `distill`: the pass could not list the scope or `distill` failed, and nothing was
   * stored. `journal`: the journal could not be read or written; the pass stopped there and the
   * candidates after it are `skipped`.
   */
  failure?: { stage: 'list' | 'distill' | 'journal'; error: string };
  stopped?: StopReason;
}

/** One candidate the pass will consider: validated, with its derived id. */
export interface CuratorCandidate { id: string; text: string; sources: string[] }

/** The options of one pass after validation. Internal. */
export interface CuratorPass {
  store: CuratableStore;
  scope: MemoryScope;
  distill: CuratorDistill;
  distillerId: string;
  by: string;
  measure: Pick<MeasureMemoryOptions, 'tasks' | 'run' | 'history'>;
  embedder?: MemoryEmbedder;
  maxCandidates: number;
  maxEpisodes: number;
  maxTextChars: number;
  deadlineMs: number;
  minTasks: number;
  minMargin: number;
  alpha: number;
  confirm: boolean;
  pendingAlpha: number;
  confirmWithinMs: number;
  maxMeasurementsPerDay: number;
  paraphraseSimilarity: number;
  screen?: CuratorScreen;
  maxPromotionsPerPass: number;
  maxPromotionsPerDay: number;
  journal: CuratorJournal;
  remeasureRefused: boolean;
  episodeCooldownMs: number;
  maxPromotionsPerEpisode: number;
  signal?: AbortSignal;
  now: () => Date;
}
