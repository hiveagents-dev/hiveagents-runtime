import { digest } from '../../shared/json.js';
import { promotionBudgetJournalKey } from './curator-acceptance.js';
import { MAX_REJECTED } from './curator-journal.js';
import type { CuratorJournal, CuratorJournalEntry } from './curator-journal.js';
import { sketchSimilarity } from './curator-similarity.js';
import type { CuratorPass } from './curator-types.js';
import type { MemoryScope } from './ports.js';

/**
 * The scope-wide entries of the curator journal: the rolling promotion and measurement budgets,
 * the index of pending candidates and the index of recent rejections. Each change is one
 * `update` when the journal has it (a file journal applies it under its lock), otherwise a read
 * then a set. Every function here reads or writes the journal: may throw.
 */

export const DAY_MS = 24 * 60 * 60_000;
/** Pending candidates a scope may hold at once. */
export const MAX_PENDING = 16;
/** Times a budget entry keeps: the daily budgets are at most this. */
export const MAX_BUDGET_TIMES = 64;

function scopeDigest(scope: MemoryScope): string {
  return digest([scope.tenant, scope.namespace, scope.subject ?? null]);
}

export { promotionBudgetJournalKey };
export const measurementBudgetJournalKey = (scope: MemoryScope) => `measurements:${scopeDigest(scope)}`;
export const pendingJournalKey = (scope: MemoryScope) => `pending:${scopeDigest(scope)}`;
export const rejectedJournalKey = (scope: MemoryScope) => `rejected:${scopeDigest(scope)}`;

/** Replaces an entry with `change(entry)`: atomically when the journal can, else read then set. */
export async function modify(
  journal: CuratorJournal, key: string, change: (entry: CuratorJournalEntry | undefined) => CuratorJournalEntry,
): Promise<void> {
  if (journal.update) {
    await journal.update(key, change);
    return;
  }
  await journal.set(key, change(await journal.get(key)));
}

/**
 * Times less than a day old. Times later than now count too (fail-closed): the clock was stepped
 * back, or a host whose clock runs ahead shares the journal.
 */
export function withinDay(times: readonly string[] | undefined, now: Date): string[] {
  const since = now.getTime() - DAY_MS;
  return (times ?? []).filter(time => Date.parse(time) > since);
}

/** Whether the scope's rolling day still has room for a measurement. */
export async function measurementRoom(options: CuratorPass): Promise<boolean> {
  const entry = await options.journal.get(measurementBudgetJournalKey(options.scope));
  return withinDay(entry?.measuredAt, options.now()).length < options.maxMeasurementsPerDay;
}

/** Counts a measurement against the scope's rolling day before it runs. */
export async function reserveMeasurement(options: CuratorPass): Promise<void> {
  const now = options.now();
  const at = now.toISOString();
  await modify(options.journal, measurementBudgetJournalKey(options.scope), entry => ({
    outcome: 'promoted', at, measuredAt: [...withinDay(entry?.measuredAt, now), at].slice(-MAX_BUDGET_TIMES),
  }));
}

/** Counts a promotion against the scope's rolling day before the store is asked. */
export async function reservePromotionSlot(options: CuratorPass): Promise<void> {
  const now = options.now();
  const at = now.toISOString();
  await modify(options.journal, promotionBudgetJournalKey(options.scope), entry => ({
    outcome: 'promoted', at, promotedAt: [...withinDay(entry?.promotedAt, now), at].slice(-MAX_BUDGET_TIMES),
  }));
}

export async function pendingIds(options: CuratorPass): Promise<string[]> {
  return (await options.journal.get(pendingJournalKey(options.scope)))?.pending ?? [];
}

function changePending(options: CuratorPass, change: (ids: string[]) => string[]): Promise<void> {
  const at = options.now().toISOString();
  return modify(options.journal, pendingJournalKey(options.scope), entry => ({
    outcome: 'pending', at, pending: change(entry?.pending ?? []),
  }));
}

/**
 * Adds `id` to the scope's pending list. Never drops another id to make room: false when the
 * list already holds MAX_PENDING others (decided on the entry as it is when written).
 */
export async function addPending(options: CuratorPass, id: string): Promise<boolean> {
  let added = false;
  await changePending(options, ids => {
    added = ids.includes(id) || ids.length < MAX_PENDING;
    return added && !ids.includes(id) ? [...ids, id] : ids;
  });
  return added;
}

export async function removePending(options: CuratorPass, id: string): Promise<void> {
  if ((await pendingIds(options)).includes(id)) await changePending(options, ids => ids.filter(other => other !== id));
}

/** When a rejection stops holding paraphrases back; undefined when the cooldown is off. */
function rejectionUntil(options: CuratorPass, now: Date): string | undefined {
  if (options.episodeCooldownMs === 0) return undefined;
  return new Date(now.getTime() + options.episodeCooldownMs).toISOString();
}

/** Adds a rejected candidate's sketch to the scope's index, dropping lapsed ones and the oldest past the bound. */
export async function addRejection(options: CuratorPass, sketch: string): Promise<void> {
  const now = options.now();
  const until = rejectionUntil(options, now);
  if (!until || !sketch) return;
  await modify(options.journal, rejectedJournalKey(options.scope), entry => ({
    outcome: 'refused', at: now.toISOString(),
    rejected: [...(entry?.rejected ?? []).filter(item => Date.parse(item.until) > now.getTime()), { until, sketch }].slice(-MAX_REJECTED),
  }));
}

/** Whether `sketch` is a near-duplicate of a rejection still within its cooldown. */
export async function paraphraseCooling(options: CuratorPass, sketch: string): Promise<boolean> {
  if (options.episodeCooldownMs === 0 || options.remeasureRefused || !sketch) return false;
  const entry = await options.journal.get(rejectedJournalKey(options.scope));
  const now = options.now().getTime();
  return (entry?.rejected ?? []).some(item => Date.parse(item.until) > now
    && sketchSimilarity(item.sketch, sketch) >= options.paraphraseSimilarity);
}
