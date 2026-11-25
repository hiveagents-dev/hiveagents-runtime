import { episodeContentJournalKey } from './curator-acceptance.js';
import { atLimit, promoteMeasured, promotionRoom, recordOutcome } from './curator-candidate.js';
import type { EpisodeJournal, PassState } from './curator-candidate.js';
import { measureStored, pooledEvidence, refusalOf } from './curator-decision.js';
import { candidateJournalKey, episodeJournalKey } from './curator-journal.js';
import type { CuratorJournalEntry } from './curator-journal.js';
import { addRejection, measurementRoom, pendingIds, removePending } from './curator-ledger.js';
import { screenCandidate } from './curator-screen.js';
import type { CuratorCandidate, CuratorCandidateOutcome, CuratorReport } from './curator-types.js';
import type { MemoryRecordView } from './store-types.js';

/**
 * The second stage of `confirm`: every pending candidate of the scope, oldest first, is measured
 * again with fresh runs before this pass measures anything new, and decided on the POOLED
 * discordant tasks of both measurements. A pending candidate past `confirmWithinMs` is refused
 * as CONFIRMATION_EXPIRED. Reads and writes the journal: may throw.
 */
export async function confirmPending(state: PassState, report: CuratorReport): Promise<void> {
  const { options, signal } = state;
  for (const id of await pendingIds(options)) {
    if (signal.aborted || report.failure) {
      report.candidates.push({ id, status: 'skipped' });
      continue;
    }
    const entry = await options.journal.get(candidateJournalKey(id));
    if (entry?.outcome !== 'pending') {
      // Decided elsewhere (another process, or a journal that lost the entry): nothing to confirm.
      await removePending(options, id);
      continue;
    }
    const view = state.views.find(listed => listed.record.id === id);
    const candidate = view && candidateOf(view);
    // Read up front: an expiry or a refusal cools these episodes down again, a promotion counts against them.
    for (const source of candidate?.sources ?? []) await episodeOf(source, state);
    const outcome = await confirmOne(id, entry, view, candidate, state);
    report.candidates.push(outcome);
    if (outcome.status === 'error' && outcome.stage === 'journal') {
      report.failure = { stage: 'journal', error: outcome.error };
      continue;
    }
    if (candidate) {
      await recordOutcome(candidate, outcome, state);
    } else if (outcome.status === 'refused') {
      // Expired and no longer listed: no text and no sources to cool down, only the decision and the sketch.
      await options.journal.set(candidateJournalKey(id), { outcome: 'refused', at: options.now().toISOString(), reason: outcome.reason });
      await removePending(options, id);
      if (entry.sketch) await addRejection(options, entry.sketch);
    }
  }
}

async function confirmOne(
  id: string, entry: CuratorJournalEntry, view: MemoryRecordView | undefined, candidate: CuratorCandidate | undefined,
  state: PassState,
): Promise<CuratorCandidateOutcome> {
  const { options } = state;
  // A pending entry without its first measurement or its deadline can never be confirmed: it expires.
  if (!entry.tally || !entry.pendingUntil || Date.parse(entry.pendingUntil) <= options.now().getTime()) {
    return { id, status: 'refused', reason: 'CONFIRMATION_EXPIRED' };
  }
  if (!view || !candidate) return { id, status: 'held', reason: 'NOT_LISTED' };
  if (view.state !== 'episode') {
    await removePending(options, id);
    return { id, status: 'existing', state: view.state };
  }
  // Two measurements of different content are not one body of evidence: it waits, then expires.
  if (view.contentDigest !== entry.tally.contentDigest) return { id, status: 'error', stage: 'measure', error: 'CONTENT_CHANGED' };
  // Pooled only over the same task count: the first measurement compared memory on another task
  // set, so its discordant tasks are not evidence about this one (and a task set changed between
  // two measurements is how a set picked after the fact would look). Refused, not re-measured.
  if (entry.tally.memory.total !== options.measure.tasks.length) return { id, status: 'refused', reason: 'TASKS_CHANGED' };
  if (candidate.sources.some(source => atLimit(state.episodes.get(source), options))) return { id, status: 'held', reason: 'EPISODE_LIMIT' };
  if (!await promotionRoom(state)) return { id, status: 'held', reason: 'PROMOTION_BUDGET' };
  if (!await measurementRoom(options)) return { id, status: 'held', reason: 'MEASUREMENT_BUDGET' };
  // The screen in force now decides, not the one (if any) the first stage met: a refusal is final,
  // a failing screen leaves it pending.
  const screened = await screenCandidate(candidate, state);
  if (screened) return screened;
  const measured = await measureStored(view, state);
  if ('status' in measured) return measured;
  const { gate, pooled, evidence } = pooledEvidence(entry.tally, measured);
  const reason = refusalOf(evidence, options, options.alpha);
  if (reason) return { id, status: 'refused', reason, measurement: measured.measurement, pooled };
  return promoteMeasured(candidate, gate, measured.measurement, state, pooled);
}

/** The candidate a stored curator record holds: its text and the episodes its metadata cites. */
function candidateOf(view: MemoryRecordView): CuratorCandidate {
  const metadata = view.record.metadata as { sources?: unknown } | undefined;
  const sources = Array.isArray(metadata?.sources) ? metadata.sources.filter((source): source is string => typeof source === 'string') : [];
  return { id: view.record.id, text: view.record.text, sources };
}

/** The journal entries of a cited episode, by id and, when it is still listed, by content; remembered for the pass. */
async function episodeOf(source: string, state: PassState): Promise<EpisodeJournal> {
  const known = state.episodes.get(source);
  if (known) return known;
  const { options } = state;
  const idKey = episodeJournalKey(options.scope, source);
  const listed = state.views.find(view => view.record.id === source);
  const contentKey = listed ? episodeContentJournalKey(options.scope, listed.record.text) : undefined;
  const episode: EpisodeJournal = {
    idKey, contentKey,
    byId: await options.journal.get(idKey),
    byContent: contentKey ? await options.journal.get(contentKey) : undefined,
  };
  state.episodes.set(source, episode);
  return episode;
}
