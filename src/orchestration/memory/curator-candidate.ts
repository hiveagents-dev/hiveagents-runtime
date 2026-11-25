import { digest } from '../../shared/json.js';
import { abortable, errorLabel } from './curation-support.js';
import { promotionBudgetJournalKey } from './curator-acceptance.js';
import { measureStored, refusalOf, stopLabel, tallyOf } from './curator-decision.js';
import type { MeasuredCandidate, PassControl } from './curator-decision.js';
import { candidateJournalKey } from './curator-journal.js';
import type { CuratorJournalEntry } from './curator-journal.js';
import {
  MAX_PENDING, addPending, addRejection, measurementRoom, paraphraseCooling, pendingIds, removePending, reservePromotionSlot,
  withinDay,
} from './curator-ledger.js';
import { screenCandidate } from './curator-screen.js';
import { textSketch } from './curator-similarity.js';
import { CURATOR_SOURCE } from './curator-types.js';
import type {
  CuratorCandidate, CuratorCandidateOutcome, CuratorHoldReason, CuratorMeasurement, CuratorPass, CuratorPooledEvidence,
} from './curator-types.js';
import type { MemoryGateEvidence } from './gate.js';
import type { ScopedMemoryRecord } from './ports.js';
import type { MemoryRecordView } from './store-types.js';

/** One candidate's way through a pass: holds, screen, storage, measurement, acceptance, promotion, journal. */

export { stopLabel } from './curator-decision.js';
export const LIST_LIMIT = 256;
const MAX_PROMOTED_IDS = 16;
export { MAX_BUDGET_TIMES } from './curator-ledger.js';

/**
 * What the journal says about one offered episode, under both of its keys: its id and its
 * normalized text. Identical-content episodes share the content entry, so a fresh id carrying
 * the same text inherits its cooldown and its promotion count.
 */
export interface EpisodeJournal {
  idKey: string;
  contentKey?: string | undefined;
  byId?: CuratorJournalEntry | undefined;
  byContent?: CuratorJournalEntry | undefined;
}

/** What a pass knows while it runs. `episodes` holds the journal entries of the episodes offered to `distill`. */
export interface PassState extends PassControl {
  views: readonly MemoryRecordView[];
  episodes: Map<string, EpisodeJournal>;
  /** Candidates this pass promoted (or reserved a promotion for) so far. */
  promotions: number;
  /** Ids this pass promoted: the listing taken at its start still shows them as episodes. */
  promotedIds: Set<string>;
}

export function cooling(entry: CuratorJournalEntry | undefined, now: Date): boolean {
  return entry?.cooldownUntil !== undefined && Date.parse(entry.cooldownUntil) > now.getTime();
}

export function episodeCooling(episode: EpisodeJournal | undefined, now: Date): boolean {
  return cooling(episode?.byId, now) || cooling(episode?.byContent, now);
}

export function atLimit(episode: EpisodeJournal | undefined, options: CuratorPass): boolean {
  const promoted = new Set([...(episode?.byId?.promoted ?? []), ...(episode?.byContent?.promoted ?? [])]);
  return promoted.size >= options.maxPromotionsPerEpisode;
}

export function cooldownUntil(options: CuratorPass, now: Date, entry?: CuratorJournalEntry): string | undefined {
  if (options.episodeCooldownMs === 0) return entry?.cooldownUntil;
  return new Date(now.getTime() + options.episodeCooldownMs).toISOString();
}

/** Drops absent optional fields, so an entry never carries `undefined`. */
export function entryOf(
  fields: Pick<CuratorJournalEntry, 'outcome' | 'at'> & { [K in keyof CuratorJournalEntry]?: CuratorJournalEntry[K] | undefined },
): CuratorJournalEntry {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as unknown as CuratorJournalEntry;
}

/** Room left for a promotion in this pass and in the scope's rolling day. Reads the journal: may throw. */
export async function promotionRoom(state: PassState): Promise<boolean> {
  const { options } = state;
  if (state.promotions >= options.maxPromotionsPerPass) return false;
  const budget = await options.journal.get(promotionBudgetJournalKey(options.scope));
  return withinDay(budget?.promotedAt, options.now()).length < options.maxPromotionsPerDay;
}

/** Why this new candidate is not measured in this pass, if it is not. Reads the journal: may throw. */
export async function holdOf(candidate: CuratorCandidate, state: PassState): Promise<CuratorHoldReason | undefined> {
  const { options } = state;
  const entry = await options.journal.get(candidateJournalKey(candidate.id));
  if (entry?.outcome === 'rolled-back') return 'ROLLED_BACK';
  if (entry?.outcome === 'refused' && !options.remeasureRefused) return 'REFUSED_EARLIER';
  if (entry?.outcome === 'pending') return orphanHold(candidate.id, entry, state);
  const now = options.now();
  for (const source of candidate.sources) {
    const episode = state.episodes.get(source);
    if (episodeCooling(episode, now)) return 'EPISODE_COOLDOWN';
    if (atLimit(episode, options)) return 'EPISODE_LIMIT';
  }
  if (await paraphraseCooling(options, textSketch(options.scope, candidate.text))) return 'PARAPHRASE_COOLDOWN';
  if (!await promotionRoom(state)) return 'PROMOTION_BUDGET';
  if (!await measurementRoom(options)) return 'MEASUREMENT_BUDGET';
  if (options.confirm && (await pendingIds(options)).length >= MAX_PENDING) return 'PENDING_LIMIT';
  return undefined;
}

/**
 * A pending entry proposed again. On the scope's list it waits for its confirmation. Off it (the
 * list entry was lost, e.g. evicted from a full journal) it is put back so the next pass confirms
 * or expires it; when it has already expired, or cannot be confirmed, it is refused as
 * CONFIRMATION_EXPIRED here; when the list is full it is held, and asked again next time.
 */
async function orphanHold(id: string, entry: CuratorJournalEntry, state: PassState): Promise<CuratorHoldReason> {
  const { options } = state;
  if ((await pendingIds(options)).includes(id)) return 'PENDING';
  const now = options.now();
  if (!entry.tally || !entry.pendingUntil || Date.parse(entry.pendingUntil) <= now.getTime()) {
    await options.journal.set(candidateJournalKey(id), { outcome: 'refused', at: now.toISOString(), reason: 'CONFIRMATION_EXPIRED' });
    if (entry.sketch) await addRejection(options, entry.sketch);
    return 'REFUSED_EARLIER';
  }
  return (await addPending(options, id)) ? 'PENDING' : 'PENDING_LIMIT';
}

type EpisodeChange = 'refused' | 'pending' | 'promoted';

function nextEpisodeEntry(
  entry: CuratorJournalEntry | undefined, change: EpisodeChange, candidateId: string, options: CuratorPass, now: Date,
): CuratorJournalEntry {
  const at = now.toISOString();
  return change === 'promoted'
    ? entryOf({
      ...entry, outcome: 'promoted', at,
      promoted: [...new Set([...(entry?.promoted ?? []), candidateId])].slice(-MAX_PROMOTED_IDS),
    })
    // A pending candidate's episodes cool down too: no variant of it is drawn from them while it waits.
    : entryOf({ ...entry, outcome: change, at, cooldownUntil: cooldownUntil(options, now, entry) });
}

/** Writes the next entry of every episode the candidate cites, by id and by content. */
async function journalEpisodes(candidate: CuratorCandidate, change: EpisodeChange, state: PassState, now: Date): Promise<void> {
  const { options } = state;
  for (const source of candidate.sources) {
    const episode = state.episodes.get(source);
    if (!episode) continue;
    const byId = nextEpisodeEntry(episode.byId, change, candidate.id, options, now);
    await options.journal.set(episode.idKey, byId);
    state.episodes.set(source, { ...episode, byId });
    if (!episode.contentKey) continue;
    const byContent = nextEpisodeEntry(episode.byContent, change, candidate.id, options, now);
    await options.journal.set(episode.contentKey, byContent);
    state.episodes.set(source, { ...episode, byId, byContent });
  }
}

/**
 * Reserves a promotion before the store is asked for it: the candidate counts against the pass,
 * the scope's rolling day and every episode it cites (by id and by content) first, so a journal
 * that cannot be written stops the promotion instead of losing its count. Fail-closed: the
 * reservation is kept when the store then refuses or fails, so its slot of the day and its
 * episodes' count stay used. Writes the journal: may throw.
 */
async function reservePromotion(candidate: CuratorCandidate, state: PassState): Promise<void> {
  const { options } = state;
  state.promotions += 1;
  await reservePromotionSlot(options);
  await journalEpisodes(candidate, 'promoted', state, options.now());
}

/** Reserves the promotion, asks the store, and checks that the record is a live lesson now. */
export async function promoteMeasured(
  candidate: CuratorCandidate, gate: MemoryGateEvidence, measurement: CuratorMeasurement, state: PassState,
  pooled?: CuratorPooledEvidence,
): Promise<CuratorCandidateOutcome> {
  const { options } = state;
  const { id } = candidate;
  const extra = pooled ? { pooled } : {};
  // Fail-closed: a pass told to stop does not promote, even on complete evidence.
  const stop = stopLabel(state);
  if (stop) return { id, status: 'error', stage: 'promote', error: stop };
  try {
    await reservePromotion(candidate, state);
  } catch (error) {
    return { id, status: 'error', stage: 'journal', error: errorLabel(error) };
  }
  try {
    const result = await options.store.promote({ scope: { ...options.scope }, id, gate, by: options.by });
    if (!result.promoted) return { id, status: 'refused', reason: result.reason, measurement, ...extra };
    // Promoted means recallable now: a store that answers with an earlier promotion of a record
    // that is no longer a live lesson did not promote this candidate.
    const listed = await options.store.list({ scope: { ...options.scope }, limit: LIST_LIMIT });
    const view = listed.find(entry => entry.record.id === id);
    if (view?.state !== 'lesson') return { id, status: 'error', stage: 'promote', error: 'NOT_LIVE' };
    state.promotedIds.add(id);
    return { id, status: 'promoted', promotedAt: result.promotedAt, measurement, ...extra };
  } catch (error) {
    return { id, status: 'error', stage: 'promote', error: errorLabel(error) };
  }
}

const MEASURED_REFUSALS = new Set([
  'NO_GAIN_OVER_NO_MEMORY', 'BELOW_MARGIN', 'NOT_SIGNIFICANT', 'SCREENED', 'CONFIRMATION_EXPIRED', 'TASKS_CHANGED',
]);

/**
 * Journals a decision. A refusal (measured, screened or expired) marks the candidate refused,
 * cools down every episode it cites, by id and by content, and adds its sketch to the scope's
 * rejections (the paraphrase cooldown). A pending first stage journals the candidate with its
 * counts, adds it to the scope's pending index and cools down its episodes. A promotion marks it
 * promoted with its sketch (its reservation already counted it against those episodes and the
 * scope's rolling day). Errors, holds and INSUFFICIENT_EVIDENCE are not decisions and are not journaled.
 */
export async function recordOutcome(
  candidate: CuratorCandidate, outcome: CuratorCandidateOutcome, state: PassState, pending?: CuratorJournalEntry,
): Promise<void> {
  const { options } = state;
  const now = options.now();
  const at = now.toISOString();
  const sketch = textSketch(options.scope, candidate.text);
  const key = candidateJournalKey(candidate.id);
  // A promotion is final: nothing later in the journal turns it back into a refusal or a pending candidate.
  if (outcome.status !== 'promoted' && (await options.journal.get(key))?.outcome === 'promoted') return;
  if (outcome.status === 'pending') {
    // The list first: a failure after it leaves an id the next pass drops (its entry is not pending),
    // never a pending entry that no pass would confirm or expire. A full list (only another process
    // can have filled it since the hold check) journals nothing: a later pass measures it afresh.
    if (!(await addPending(options, candidate.id))) return;
    await options.journal.set(key, pending!);
    await journalEpisodes(candidate, 'pending', state, now);
    return;
  }
  // A confirmation is decided by any refusal, the store's included: its entry must not stay pending.
  const refused = outcome.status === 'refused' && (MEASURED_REFUSALS.has(outcome.reason) || outcome.pooled !== undefined);
  const decided = refused || outcome.status === 'promoted';
  if (decided) {
    await options.journal.set(key, refused
      ? { outcome: 'refused', at, reason: (outcome as { reason: string }).reason }
      : { outcome: 'promoted', at, sketch });
  }
  if (decided) await removePending(options, candidate.id);
  if (!refused) return;
  await journalEpisodes(candidate, 'refused', state, now);
  await addRejection(options, sketch);
}

/** The pending entry of a candidate whose first measurement passed under `confirm`. */
function pendingEntry(measured: MeasuredCandidate, stored: MemoryRecordView, state: PassState): CuratorJournalEntry {
  const now = state.options.now();
  return {
    outcome: 'pending', at: now.toISOString(),
    pendingUntil: new Date(now.getTime() + state.options.confirmWithinMs).toISOString(),
    tally: tallyOf(measured, stored.contentDigest),
    sketch: textSketch(state.options.scope, stored.record.text),
  };
}

function hasTitle(record: ScopedMemoryRecord): boolean {
  const { metadata } = record;
  return !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Object.hasOwn(metadata, 'title');
}

/**
 * Screens a new candidate, stores it if it is new, measures it alone and decides: promotion on
 * one measurement, or without `confirm`; pending, under it. A record already stored that is not
 * an episode is `existing`. Returns the pending entry to journal along with a pending outcome.
 */
export async function curateOne(
  candidate: CuratorCandidate, existing: MemoryRecordView | undefined, state: PassState,
): Promise<{ outcome: CuratorCandidateOutcome; pending?: CuratorJournalEntry }> {
  const { options, signal } = state;
  const { id } = candidate;
  const screened = await screenCandidate(candidate, state);
  if (screened) return { outcome: screened };
  let stored = existing;
  if (!stored) {
    try {
      const record = await recordOf(candidate, state);
      await abortable(() => options.store.put(record, signal), signal);
      const listed = await abortable(() => options.store.list({ scope: { ...options.scope }, limit: LIST_LIMIT }), signal);
      stored = listed.find(entry => entry.record.id === id);
    } catch (error) {
      return { outcome: { id, status: 'error', stage: 'store', error: stopLabel(state) ?? errorLabel(error) } };
    }
    if (!stored) return { outcome: { id, status: 'error', stage: 'store', error: 'NOT_LISTED' } };
  }
  if (stored.state !== 'episode') return { outcome: { id, status: 'existing', state: stored.state } };
  // Recall renders a title; the gate measures the text alone. A record that carries one (an
  // older curator wrote it) is not measured, so nothing unmeasured can reach a turn.
  if (hasTitle(stored.record)) return { outcome: { id, status: 'error', stage: 'measure', error: 'UNMEASURED_TITLE' } };
  const measured = await measureStored(stored, state);
  if ('status' in measured) return { outcome: measured };
  const { measurement } = measured;
  const level = options.confirm ? options.pendingAlpha : options.alpha;
  const reason = refusalOf(measurement, options, level);
  if (reason) return { outcome: { id, status: 'refused', reason, measurement } };
  if (options.confirm) {
    const pending = pendingEntry(measured, stored, state);
    return { outcome: { id, status: 'pending', measurement, until: pending.pendingUntil! }, pending };
  }
  return { outcome: await promoteMeasured(candidate, measured.gate, measurement, state) };
}

/**
 * The record the curator stores: text, provenance and `metadata: { sources }`. No title: recall
 * renders every field it is given, and the gate measures the text alone.
 */
async function recordOf(candidate: CuratorCandidate, state: PassState): Promise<ScopedMemoryRecord> {
  const { options, signal } = state;
  const sources = state.views.filter(view => candidate.sources.includes(view.record.id));
  const times = sources.map(view => Date.parse(view.record.provenance.observedAt)).filter(time => !Number.isNaN(time));
  // The newest cited episode dates the lesson, so a re-run builds the very same record.
  const observedAt = times.length ? new Date(Math.max(...times)).toISOString() : options.now().toISOString();
  const record: ScopedMemoryRecord = {
    id: candidate.id,
    scope: { ...options.scope },
    text: candidate.text,
    provenance: {
      source: CURATOR_SOURCE,
      sourceVersion: options.distillerId,
      observedAt,
      inputHash: digest({ text: candidate.text, sources: sources.map(view => view.contentDigest).sort() }),
    },
    metadata: { sources: candidate.sources },
  };
  if (options.embedder) {
    const { identity } = options.embedder;
    const vectors = await abortable(() => options.embedder!.embed([candidate.text], signal), signal);
    const vector = Array.isArray(vectors) && vectors.length === 1 ? vectors[0] : undefined;
    if (!Array.isArray(vector) || vector.length !== identity.dimensions
      || vector.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw new RangeError(`The embedder must return one vector of ${identity.dimensions} finite numbers`);
    }
    record.embedding = {
      identity: { provider: identity.provider, model: identity.model, revision: identity.revision, dimensions: identity.dimensions },
      values: [...vector],
    };
  }
  return record;
}
