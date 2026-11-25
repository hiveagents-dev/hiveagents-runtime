import { isMemoryLabel, recallableMemory } from '../../public/memory-items.js';
import { digest, freeze } from '../../shared/json.js';
import {
  MAX_TIMER_MS, abortable, boundedInteger, deadline, errorLabel, optionalSignal, storeName,
} from './curation-support.js';
import { episodeContentJournalKey, signTestPValue } from './curator-acceptance.js';
import {
  LIST_LIMIT, MAX_BUDGET_TIMES, atLimit, cooldownUntil, curateOne, entryOf, episodeCooling, holdOf, recordOutcome,
} from './curator-candidate.js';
import type { EpisodeJournal, PassState } from './curator-candidate.js';
import { confirmPending } from './curator-confirm.js';
import {
  MAX_CONFIRM_WITHIN_MS, candidateJournalKey, checkedJournal, episodeJournalKey, processCuratorJournal,
} from './curator-journal.js';
import type { CuratorJournalEntry } from './curator-journal.js';
import { addRejection } from './curator-ledger.js';
import {
  CURATOR_DEFAULT_MAX_CANDIDATES, CURATOR_DEFAULT_MAX_TEXT, CURATOR_MAX_CANDIDATES_CEILING, CURATOR_MAX_TEXT_CEILING,
  CURATOR_SOURCE,
} from './curator-types.js';
import type {
  CurateMemoryOptions, CuratorAcceptance, CuratorCandidate, CuratorCandidateOutcome, CuratorEpisode, CuratorInvalidReason,
  CuratorPass, CuratorReport,
} from './curator-types.js';
import type { MemoryScope } from './ports.js';
import type { MemoryRecordView } from './store-types.js';

export {
  CURATOR_DEFAULT_MAX_CANDIDATES, CURATOR_DEFAULT_MAX_TEXT, CURATOR_MAX_CANDIDATES_CEILING, CURATOR_MAX_TEXT_CEILING,
  CURATOR_SOURCE,
} from './curator-types.js';
export type {
  CuratableStore, CurateMemoryOptions, CuratorAcceptance, CuratorCandidateOutcome, CuratorDistill, CuratorDistillContext,
  CuratorEpisode, CuratorHoldReason, CuratorInvalidReason, CuratorMeasurement, CuratorPooledEvidence, CuratorProposal,
  CuratorRefusal, CuratorReport, CuratorScreen, CuratorScreenCandidate, CuratorScreenReason, CuratorScreenVerdict,
} from './curator-types.js';
export { fileCuratorJournal, memoryCuratorJournal } from './curator-journal.js';
export { signTestPValue } from './curator-acceptance.js';
export type { CuratorJournal, CuratorJournalEntry, CuratorJournalOptions, CuratorPendingTally } from './curator-journal.js';

/**
 * The curator: one bounded pass that turns captured episodes into a few candidate lessons and
 * promotes only candidates whose isolated measurement clears the margin and the sign test. The gate
 * measures utility on the application's tasks, not safety: a lesson that helps the tasks and
 * also carries something harmful passes it. Review what the curator promotes.
 *
 * The SDK never calls a model by itself here: `distill` is the application's
 * (`agentDistiller` builds one from an Agent). The pass has no timer of its own
 * beyond its deadline; the application decides when to run one, for example
 * after every N captures, from a cron job, or when an operator asks.
 */

const DEFAULT_MAX_EPISODES = 32;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
const DEFAULT_MIN_TASKS = 5;
const DEFAULT_MIN_MARGIN = 2;
const DEFAULT_ALPHA = 0.01;
const MAX_ALPHA = 0.5;
const DEFAULT_PENDING_ALPHA = 0.25;
const DEFAULT_CONFIRM_WITHIN_MS = 3 * 24 * 60 * 60_000;
const DEFAULT_MEASUREMENTS_PER_DAY = 6;
const DEFAULT_PARAPHRASE_SIMILARITY = 0.8;
const DEFAULT_PROMOTIONS_PER_PASS = 1;
const DEFAULT_PROMOTIONS_PER_DAY = 3;
const DEFAULT_EPISODE_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
/** Ten years: anything longer is a typo, not a cooldown. */
const MAX_EPISODE_COOLDOWN_MS = 10 * 365 * 24 * 60 * 60_000;
const MAX_PROMOTIONS_PER_EPISODE = 16;
/** Proposals beyond this many are not even read: they count as OVER_LIMIT. */
const MAX_PROPOSALS_READ = 64;
const TITLE_MAX = 120;

function captureOptions(input: CurateMemoryOptions): CuratorPass {
  if (!input || typeof input !== 'object') throw new TypeError('curateMemory needs an options object');
  const { store, scope, distill, tasks, run, history, embedder, now, journal } = input;
  for (const method of ['list', 'put', 'promote'] as const) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`store must implement ${method}()`);
  }
  if (!scope || typeof scope !== 'object') throw new TypeError('scope is required');
  if (typeof distill !== 'function') throw new TypeError('distill must be a function');
  if (typeof run !== 'function' || typeof history !== 'function') throw new TypeError('run and history must be functions');
  if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError('tasks must hold at least one task');
  if (embedder !== undefined && typeof embedder?.embed !== 'function') throw new TypeError('embedder must implement embed()');
  if (now !== undefined && typeof now !== 'function') throw new TypeError('now must be a function');
  if (journal !== undefined && (typeof journal?.get !== 'function' || typeof journal?.set !== 'function'
    || (journal.update !== undefined && typeof journal.update !== 'function'))) {
    throw new TypeError('journal must implement get() and set(), and update() is a function when present');
  }
  if (Object.hasOwn(input, 'remeasureExisting')) {
    throw new TypeError('remeasureExisting was replaced: unfinished candidates are always measured again; see remeasureRefused');
  }
  if (input.confirm !== undefined && typeof input.confirm !== 'boolean') throw new TypeError('confirm must be a boolean');
  if (input.screen !== undefined && typeof input.screen !== 'function') throw new TypeError('screen must be a function');
  const alpha = significance(input.alpha, 'alpha', 0, DEFAULT_ALPHA);
  const captured: CuratorPass = {
    store,
    scope: { tenant: scope.tenant, namespace: scope.namespace, ...(scope.subject === undefined ? {} : { subject: scope.subject }) },
    distill,
    distillerId: storeName(input.distillerId, 'distillerId'),
    by: storeName(input.by ?? CURATOR_SOURCE, 'by'),
    measure: { tasks, run, history },
    maxCandidates: boundedInteger(input.maxCandidates, 'maxCandidates', 1, CURATOR_MAX_CANDIDATES_CEILING, CURATOR_DEFAULT_MAX_CANDIDATES),
    maxEpisodes: boundedInteger(input.maxEpisodes, 'maxEpisodes', 1, LIST_LIMIT, DEFAULT_MAX_EPISODES),
    maxTextChars: boundedInteger(input.maxTextChars, 'maxTextChars', 1, CURATOR_MAX_TEXT_CEILING, CURATOR_DEFAULT_MAX_TEXT),
    deadlineMs: boundedInteger(input.deadlineMs, 'deadlineMs', 1, MAX_TIMER_MS, DEFAULT_DEADLINE_MS),
    minTasks: boundedInteger(input.minTasks, 'minTasks', 1, 1024, DEFAULT_MIN_TASKS),
    minMargin: boundedInteger(input.minMargin, 'minMargin', 1, 1024, DEFAULT_MIN_MARGIN),
    alpha,
    confirm: input.confirm !== false,
    // At least alpha: a first measurement never needs more than the pooled decision does.
    pendingAlpha: significance(input.pendingAlpha, 'pendingAlpha', alpha, Math.max(DEFAULT_PENDING_ALPHA, alpha), true),
    confirmWithinMs: boundedInteger(input.confirmWithinMs, 'confirmWithinMs', 1, MAX_CONFIRM_WITHIN_MS, DEFAULT_CONFIRM_WITHIN_MS),
    maxMeasurementsPerDay: boundedInteger(
      input.maxMeasurementsPerDay, 'maxMeasurementsPerDay', 1, MAX_BUDGET_TIMES, DEFAULT_MEASUREMENTS_PER_DAY,
    ),
    paraphraseSimilarity: similarity(input.paraphraseSimilarity),
    maxPromotionsPerPass: boundedInteger(
      input.maxPromotionsPerPass, 'maxPromotionsPerPass', 1, CURATOR_MAX_CANDIDATES_CEILING, DEFAULT_PROMOTIONS_PER_PASS,
    ),
    maxPromotionsPerDay: boundedInteger(input.maxPromotionsPerDay, 'maxPromotionsPerDay', 1, MAX_BUDGET_TIMES, DEFAULT_PROMOTIONS_PER_DAY),
    journal: checkedJournal(journal ?? processCuratorJournal(store)),
    remeasureRefused: input.remeasureRefused === true,
    episodeCooldownMs: boundedInteger(
      input.episodeCooldownMs, 'episodeCooldownMs', 0, MAX_EPISODE_COOLDOWN_MS, DEFAULT_EPISODE_COOLDOWN_MS,
    ),
    maxPromotionsPerEpisode: boundedInteger(input.maxPromotionsPerEpisode, 'maxPromotionsPerEpisode', 1, MAX_PROMOTIONS_PER_EPISODE, 1),
    now: now ?? (() => new Date()),
  };
  const signal = optionalSignal(input.signal);
  if (signal) captured.signal = signal;
  if (embedder) captured.embedder = embedder;
  if (input.screen) captured.screen = input.screen;
  return captured;
}

/** A level in (`floor`, 0.5], or [`floor`, 0.5] when `inclusive`. */
function significance(value: unknown, name: string, floor: number, fallback: number, inclusive = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !((inclusive ? value >= floor : value > floor) && value <= MAX_ALPHA)) {
    throw new RangeError(`${name} must be a number ${inclusive ? 'from' : 'above'} ${floor} ${inclusive ? 'to' : 'and at most'} ${MAX_ALPHA}`);
  }
  return value;
}

function similarity(value: unknown): number {
  if (value === undefined) return DEFAULT_PARAPHRASE_SIMILARITY;
  if (typeof value !== 'number' || !(value >= 0.5 && value <= 1)) throw new RangeError('paraphraseSimilarity must be a number from 0.5 to 1');
  return value;
}

/** The fewest discordant tasks, all won, that pass the sign test at `level`. */
function minWins(level: number): number {
  let wins = 1;
  while (signTestPValue(wins, 0) > level) wins += 1;
  return wins;
}

/** The acceptance rule as the report shows it, and whether the task set can ever pass it. */
function acceptanceOf(options: CuratorPass): CuratorAcceptance {
  const tasks = options.measure.tasks.length;
  const wins = minWins(options.alpha);
  const measurements = options.confirm ? 2 : 1;
  const possible = tasks >= options.minTasks && tasks >= options.minMargin && tasks * measurements >= wins
    && (!options.confirm || tasks >= minWins(options.pendingAlpha));
  return {
    tasks, alpha: options.alpha, minMargin: options.minMargin, confirm: options.confirm,
    ...(options.confirm ? { pendingAlpha: options.pendingAlpha } : {}), minWins: wins, possible,
  };
}

/**
 * Runs one curation pass over one scope:
 *
 * 1. lists the scope's unpromoted episodes (newest first), leaving out the curator's own
 *    candidates and every episode the journal holds back: cooling down after it produced a
 *    refused or rolled-back candidate, or already cited by `maxPromotionsPerEpisode` promoted
 *    ones. The journal keys an episode by its id AND by its normalized text, so a fresh id that
 *    carries the same text (a persistent injection lands in every turn) is held back too; of
 *    several eligible episodes with one normalized text only the newest is offered
 *    (`episodesMerged` counts the rest). A promoted candidate missing from the listing was
 *    withdrawn (rolled back or revoked): its episodes start a cooldown and it is journaled as
 *    rolled back. At most `maxEpisodes`;
 * 2. asks `distill` for lessons and keeps at most `maxCandidates` valid ones: text within
 *    bounds that the agent would carry unchanged (no NUL, no invisible tag characters), an
 *    optional title that is a memory label (checked, never stored), and `sources` that all
 *    name episodes of this pass. Anything else is reported in `invalid`;
 * 3. first measures again, with `confirm`, the scope's pending candidates (oldest first), and
 *    decides each on the pooled evidence of both measurements (step 7); one pending longer than
 *    `confirmWithinMs` is refused as CONFIRMATION_EXPIRED;
 * 4. holds back (`held`) a candidate the journal records as refused (unless `remeasureRefused`),
 *    rolled back or pending, one citing an episode that a decision earlier in this pass held back,
 *    one whose text is a near-duplicate of a candidate refused or rolled back within the cooldown
 *    (`paraphraseSimilarity`), and every candidate once the pass promoted `maxPromotionsPerPass`,
 *    the scope's rolling 24 hours hold `maxPromotionsPerDay` promotions or `maxMeasurementsPerDay`
 *    measurements, or (with `confirm`) the scope holds 16 pending candidates;
 *    refuses every candidate as INSUFFICIENT_EVIDENCE when the task set cannot pass the test
 *    (`report.acceptance.possible`); asks `screen`, when given, and refuses as SCREENED, unstored
 *    and unmeasured, a candidate it refuses;
 * 5. stores each candidate as an EPISODE with provenance `source: 'curator'`, `sourceVersion:
 *    distillerId`, the newest `observedAt` of its sources, an `inputHash` over its text and
 *    sources, and metadata `{ sources }`. Its id is derived from the scope and the text, so a
 *    re-run proposing the same lesson finds it instead of storing it twice;
 * 6. measures each candidate ALONE with `measureMemory`: its text is the whole context of the
 *    `memory` condition, and the evidence names only its digest. A run that errored under
 *    no-memory or memory makes the candidate an `error`, never a refusal or a promotion;
 *    Each measurement is first reserved against `maxMeasurementsPerDay`;
 * 7. accepts it only when the store gate passes AND, over the paired tasks exactly one condition
 *    passed, memory wins at least `minMargin` more than it loses AND the one-sided exact sign test
 *    gives a p-value of at most `alpha`. Without `confirm` that one measurement promotes it. With
 *    `confirm` (the default) a first measurement that passes at `pendingAlpha` makes it `pending`,
 *    and only the pooled evidence of a second measurement in a later pass, at `alpha`, promotes
 *    it: a lesson with no effect is promoted at most `alpha` of the times it is measured either
 *    way, and the journal measures it once (twice when pending).
 *
 * The gate measures usefulness, not safety: a lesson that carries an injected instruction and
 * leaves the tasks unchanged is promoted exactly as often as any neutral one. Give a `screen`,
 * run passes at most daily unless measurements are budgeted tighter, and review what is promoted.
 *
 * Refusals and promotions are journaled; errors are not, so a candidate whose measurement never
 * finished is measured by a later pass. A promotion is reserved in the journal (the pass, the
 * scope's rolling day, the cited episodes) before the store is asked: a reservation that cannot be
 * written stops the pass at stage `journal` unpromoted, and one whose promotion the store then
 * refuses or fails is kept (fail-closed). A stored candidate that is a lesson, invalidated or
 * expired is reported `existing` and never measured again. Raw episodes are never promoted. The
 * pass stops at `deadlineMs` or when `signal` aborts and returns the report with `stopped` set;
 * candidates it did not reach are `skipped`. A pass never rejects for a store, distiller, journal
 * or runner failure; it throws only for invalid options.
 *
 * Run one pass per scope at a time.
 */
export async function curateMemory(input: CurateMemoryOptions): Promise<CuratorReport> {
  const options = captureOptions(input);
  const pass = deadline(options.signal, options.deadlineMs);
  const report: CuratorReport = {
    format: 1, scope: options.scope, distillerId: options.distillerId, episodes: 0, episodesHeld: 0, episodesMerged: 0,
    proposed: 0, candidates: [], invalid: [], promoted: 0, refused: 0, held: 0, errors: 0, pending: 0, measured: 0,
    acceptance: acceptanceOf(options),
  };
  try {
    await runPass(options, { signal: pass.signal, stopped: pass.stopped, measurements: 0 }, report);
  } finally {
    pass.dispose();
  }
  const stopped = pass.stopped();
  if (stopped) report.stopped = stopped;
  for (const outcome of report.candidates) {
    if (outcome.status === 'promoted') report.promoted += 1;
    else if (outcome.status === 'refused') report.refused += 1;
    else if (outcome.status === 'held') report.held += 1;
    else if (outcome.status === 'error') report.errors += 1;
    else if (outcome.status === 'pending') report.pending += 1;
  }
  return freeze(report);
}

async function runPass(
  options: CuratorPass, control: Pick<PassState, 'signal' | 'stopped' | 'measurements'>, report: CuratorReport,
): Promise<void> {
  const state = await listed(options, control, report);
  if (!state) return;
  try {
    await runCandidates(state, report);
  } finally {
    report.measured = state.measurements;
  }
}

/** Lists the scope, or records the failure. */
async function listed(
  options: CuratorPass, control: Pick<PassState, 'signal' | 'stopped' | 'measurements'>, report: CuratorReport,
): Promise<PassState | undefined> {
  const { signal } = control;
  if (signal.aborted) return undefined;
  let views: readonly MemoryRecordView[];
  try {
    views = await abortable(() => options.store.list({ scope: { ...options.scope }, limit: LIST_LIMIT }), signal);
  } catch (error) {
    if (!signal.aborted) report.failure = { stage: 'list', error: errorLabel(error) };
    return undefined;
  }
  return { options, ...control, views, episodes: new Map(), promotions: 0, promotedIds: new Set() };
}

async function runCandidates(state: PassState, report: CuratorReport): Promise<void> {
  const { options, signal, views } = state;
  let offered: MemoryRecordView[];
  try {
    offered = await eligibleEpisodes(state, report);
    // Pending candidates are measured again before anything new: they hold the earliest claim on the budgets.
    await confirmPending(state, report);
  } catch (error) {
    report.failure = { stage: 'journal', error: errorLabel(error) };
    return;
  }
  const episodes = offered.map(({ record }): CuratorEpisode => freeze({
    id: record.id, text: record.text, source: record.provenance.source, observedAt: record.provenance.observedAt,
  }));
  report.episodes = episodes.length;
  if (episodes.length === 0 || signal.aborted || report.failure) return;
  let proposals: unknown;
  try {
    // Shallow: a deep freeze would reach into the AbortSignal.
    const context = Object.freeze({ scope: freeze({ ...options.scope }), signal, maxCandidates: options.maxCandidates });
    proposals = await abortable(() => options.distill(freeze([...episodes]), context), signal);
  } catch (error) {
    if (!signal.aborted) report.failure = { stage: 'distill', error: errorLabel(error) };
    return;
  }
  if (!Array.isArray(proposals)) {
    report.failure = { stage: 'distill', error: 'INVALID_RESULT' };
    return;
  }
  report.proposed = proposals.length;
  const candidates = selectCandidates(proposals, episodes, options, report);
  const byId = new Map(views.map(view => [view.record.id, view]));
  for (const candidate of candidates) {
    if (signal.aborted || report.failure) {
      report.candidates.push({ id: candidate.id, status: 'skipped' });
      continue;
    }
    const existing = byId.get(candidate.id);
    if (existing && existing.state !== 'episode') {
      report.candidates.push({ id: candidate.id, status: 'existing', state: existing.state });
      continue;
    }
    // Confirmed earlier in this pass: a lesson now, though the pass's listing predates it.
    if (state.promotedIds.has(candidate.id)) {
      report.candidates.push({ id: candidate.id, status: 'existing', state: 'lesson' });
      continue;
    }
    let outcome: CuratorCandidateOutcome | undefined;
    try {
      const hold = await holdOf(candidate, state);
      const decided: { outcome: CuratorCandidateOutcome; pending?: CuratorJournalEntry } = hold
        ? { outcome: { id: candidate.id, status: 'held', reason: hold } }
        : !report.acceptance.possible
          ? { outcome: { id: candidate.id, status: 'refused', reason: 'INSUFFICIENT_EVIDENCE' } }
          : await curateOne(candidate, existing, state);
      outcome = decided.outcome;
      report.candidates.push(outcome);
      if (outcome.status === 'error' && outcome.stage === 'journal') report.failure = { stage: 'journal', error: outcome.error };
      await recordOutcome(candidate, outcome, state, decided.pending);
    } catch (error) {
      // Only the journal throws here: curateOne reports its own failures.
      if (!outcome) report.candidates.push({ id: candidate.id, status: 'skipped' });
      report.failure = { stage: 'journal', error: errorLabel(error) };
    }
  }
}

/**
 * The unpromoted episodes this pass may offer, newest first, at most `maxEpisodes`, one per
 * normalized text. Reconciles the journal with the listing on the way: a promoted candidate that
 * is no longer listed was withdrawn, so the episodes it cites start a cooldown. Reads and writes
 * the journal: may throw.
 */
async function eligibleEpisodes(state: PassState, report: CuratorReport): Promise<MemoryRecordView[]> {
  const { options, views } = state;
  const listed = new Set(views.map(view => view.record.id));
  const now = options.now();
  const offered: MemoryRecordView[] = [];
  const contents = new Set<string>();
  for (const view of views) {
    if (offered.length === options.maxEpisodes) break;
    if (view.state !== 'episode' || view.record.provenance?.source === CURATOR_SOURCE) continue;
    const contentKey = episodeContentJournalKey(options.scope, view.record.text);
    if (contents.has(contentKey)) {
      report.episodesMerged += 1;
      continue;
    }
    const idKey = episodeJournalKey(options.scope, view.record.id);
    const episode: EpisodeJournal = {
      idKey, contentKey,
      byId: await reconciled(state, idKey, listed, now),
      byContent: await reconciled(state, contentKey, listed, now),
    };
    if (episodeCooling(episode, now) || atLimit(episode, options)) {
      report.episodesHeld += 1;
      continue;
    }
    contents.add(contentKey);
    state.episodes.set(view.record.id, episode);
    offered.push(view);
  }
  return offered;
}

/** An episode journal entry, after journaling as rolled back the promoted candidates it cites that were withdrawn. */
async function reconciled(
  state: PassState, key: string, listed: ReadonlySet<string>, now: Date,
): Promise<CuratorJournalEntry | undefined> {
  const { options } = state;
  const entry = await options.journal.get(key);
  const withdrawn = (entry?.promoted ?? []).filter(id => !listed.has(id) && !entry!.rolledBack?.includes(id));
  if (!entry || withdrawn.length === 0) return entry;
  const at = now.toISOString();
  for (const id of withdrawn) {
    const key = candidateJournalKey(id);
    const prior = await options.journal.get(key);
    if (prior?.outcome === 'rolled-back') continue;
    await options.journal.set(key, entryOf({ outcome: 'rolled-back', at, sketch: prior?.sketch }));
    // A withdrawn lesson's paraphrases cool down like a refused one's.
    if (prior?.sketch) await addRejection(options, prior.sketch);
  }
  const next = entryOf({
    ...entry, outcome: 'rolled-back', at,
    rolledBack: [...(entry.rolledBack ?? []), ...withdrawn].slice(-16),
    cooldownUntil: cooldownUntil(options, now, entry),
  });
  await options.journal.set(key, next);
  return next;
}

function selectCandidates(
  proposals: readonly unknown[], episodes: readonly CuratorEpisode[], options: CuratorPass, report: CuratorReport,
): CuratorCandidate[] {
  const known = new Set(episodes.map(episode => episode.id));
  const candidates: CuratorCandidate[] = [];
  const texts = new Set<string>();
  proposals.forEach((proposal, index) => {
    if (candidates.length === options.maxCandidates || index >= MAX_PROPOSALS_READ) {
      report.invalid.push({ index, reason: 'OVER_LIMIT' });
      return;
    }
    const checked = checkProposal(proposal, known, options);
    if (typeof checked === 'string') {
      report.invalid.push({ index, reason: checked });
      return;
    }
    if (texts.has(checked.text)) {
      report.invalid.push({ index, reason: 'DUPLICATE' });
      return;
    }
    texts.add(checked.text);
    candidates.push({ ...checked, id: candidateId(options.scope, checked.text) });
  });
  return candidates;
}

function checkProposal(
  value: unknown, known: ReadonlySet<string>, options: CuratorPass,
): Omit<CuratorCandidate, 'id'> | CuratorInvalidReason {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'SHAPE';
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'text' && key !== 'title' && key !== 'sources')) return 'SHAPE';
  const { text: raw, title, sources } = value as Record<string, unknown>;
  if (typeof raw !== 'string') return 'TEXT';
  const text = raw.trim();
  if (!text || text.length > options.maxTextChars || text.includes('\0')) return 'TEXT';
  // The agent removes invisible tag characters from recalled text; a lesson must reach it unchanged.
  if (recallableMemory({ id: 'candidate', source: CURATOR_SOURCE, text })?.text !== text) return 'TEXT';
  // A title is checked as a sign of a well-formed reply, then dropped: it is never stored.
  if (title !== undefined && !isMemoryLabel(title, TITLE_MAX)) return 'TITLE';
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > known.size) return 'SOURCES';
  if (sources.some(source => typeof source !== 'string' || !known.has(source))) return 'SOURCES';
  return { text, sources: [...new Set(sources as string[])].sort() };
}

/** Derived from the scope and the text only, so the same lesson proposed again lands on the same id. */
export function candidateId(scope: MemoryScope, text: string): string {
  return `${CURATOR_SOURCE}-${digest([scope.tenant, scope.namespace, scope.subject ?? null, text])}`;
}
