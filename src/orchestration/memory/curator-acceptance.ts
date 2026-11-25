import { digest } from '../../shared/json.js';
import type { MemoryMeasurementReport } from './measurement.js';
import type { MemoryScope } from './ports.js';

/**
 * The curator's statistics and content identity, on their own so they can be checked directly.
 *
 * Acceptance is a paired, one-sided exact sign test over the discordant tasks of one
 * measurement: `memoryOnly` tasks passed with the candidate and failed without it, `noMemoryOnly`
 * the reverse. Under "the candidate has no effect" each discordant task is a fair coin, so
 * `P(X >= memoryOnly | n = memoryOnly + noMemoryOnly, p = 0.5)` is the chance of a result at least
 * this good from noise alone. Concordant tasks (both passed, both failed) say nothing about the
 * candidate and are left out.
 */

export interface CuratorDiscordance {
  /** Tasks the memory condition passed and the no-memory condition failed. */
  memoryOnly: number;
  /** Tasks the no-memory condition passed and the memory condition failed. */
  noMemoryOnly: number;
}

/** Counts the discordant task pairs of a measurement; an errored run counts as not passed. */
export function discordance(report: Pick<MemoryMeasurementReport, 'tasks'>): CuratorDiscordance {
  let memoryOnly = 0;
  let noMemoryOnly = 0;
  for (const { outcomes } of report.tasks) {
    const withMemory = outcomes.memory.passed === true && outcomes.memory.error !== true;
    const without = outcomes['no-memory'].passed === true && outcomes['no-memory'].error !== true;
    if (withMemory && !without) memoryOnly += 1;
    else if (without && !withMemory) noMemoryOnly += 1;
  }
  return { memoryOnly, noMemoryOnly };
}

/**
 * The most discordant tasks: a measurement takes at most 1024 tasks, and a confirmed candidate
 * pools two measurements.
 */
const MAX_DISCORDANT = 2048;

/** `numerator / 2^bits`, rounded once: 64 leading bits and a sticky bit, then power-of-two scaling. */
function dyadic(numerator: bigint, bits: number): number {
  const excess = Math.max(0, numerator.toString(2).length - 64);
  let top = numerator >> BigInt(excess);
  if (top << BigInt(excess) !== numerator) top |= 1n;
  // 2^-2048 is no double: scale in steps that stay normal, so only a result below the smallest
  // double rounds (to the nearest subnormal, or 0).
  let value = Number(top);
  let exponent = excess - bits;
  while (exponent < -960) {
    value *= 2 ** -960;
    exponent += 960;
  }
  return value * 2 ** exponent;
}

/**
 * One-sided exact sign test: `P(X >= memoryOnly)` for `X ~ Binomial(memoryOnly + noMemoryOnly, 1/2)`.
 * 1 when there is no discordant task. Computed exactly in integers, `sum of C(n, k) for k >= memoryOnly`
 * over `2^n`, and rounded once at the end, so a p-value that is exactly `alpha` compares equal to it.
 * At most 2048 discordant tasks: two pooled measurements of the most tasks a measurement takes.
 */
export function signTestPValue(memoryOnly: number, noMemoryOnly: number): number {
  if (!Number.isSafeInteger(memoryOnly) || !Number.isSafeInteger(noMemoryOnly) || memoryOnly < 0 || noMemoryOnly < 0
    || memoryOnly + noMemoryOnly > MAX_DISCORDANT) {
    throw new RangeError(`Discordant counts must be non-negative integers totalling at most ${MAX_DISCORDANT}`);
  }
  const n = memoryOnly + noMemoryOnly;
  if (memoryOnly === 0) return 1;
  let term = 1n; // C(n, n)
  let total = 0n;
  for (let k = n; k >= memoryOnly; k -= 1) {
    total += term;
    term = (term * BigInt(k)) / BigInt(n - k + 1); // C(n, k - 1), exact
  }
  return Math.min(1, dyadic(total, n));
}

/**
 * The text an episode is compared by: Unicode NFKC, invisible format characters removed,
 * whitespace runs collapsed to one space, trimmed and lower-cased. Two episodes with the same
 * normalized text are the same evidence, whatever their ids.
 */
export function normalizedEpisodeText(text: string): string {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Journal key of an episode's content within a scope: identical-content episodes share cooldowns and limits. */
export function episodeContentJournalKey(scope: MemoryScope, text: string): string {
  return `content:${digest([scope.tenant, scope.namespace, scope.subject ?? null, normalizedEpisodeText(text)])}`;
}

/** Journal key of a scope's rolling promotion budget. */
export function promotionBudgetJournalKey(scope: MemoryScope): string {
  return `promotions:${digest([scope.tenant, scope.namespace, scope.subject ?? null])}`;
}
