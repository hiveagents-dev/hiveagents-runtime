/**
 * The version grammar of the compatibility manifest. Deliberately small and closed:
 *
 * - a version is `MAJOR.MINOR.PATCH`, decimal, without leading zeros, prerelease or build metadata;
 * - a `cliRange` is either one exact version (`2.1.228`) or one half-open interval `>=LOW <HIGH` with LOW < HIGH.
 *
 * Anything else is malformed. A malformed range throws (it is a programming error in the manifest); a malformed or
 * prerelease installed version matches nothing, so the caller degrades to its help probe as for any unknown version.
 */

export type CliVersion = readonly [major: number, minor: number, patch: number];

/** A parsed `cliRange`: the closed lower bound and the open upper bound (`exact` ranges cover only `low`). */
export interface CliVersionRange {
  readonly source: string;
  readonly kind: 'exact' | 'interval';
  readonly low: CliVersion;
  /** Exclusive. For an exact range this is the version itself and `includes` compares for equality. */
  readonly high: CliVersion;
}

const PART = '(0|[1-9]\\d{0,8})';
const VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}$`);
const INTERVAL = /^>=(\S+) <(\S+)$/;

/** `undefined` for anything but a plain `MAJOR.MINOR.PATCH` release version. */
export function parseCliVersion(text: string): CliVersion | undefined {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareCliVersions(a: CliVersion, b: CliVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function requireVersion(text: string, range: string): CliVersion {
  const version = parseCliVersion(text);
  if (!version) throw new TypeError(`Malformed compatibility range ${JSON.stringify(range)}: ${JSON.stringify(text)} is not MAJOR.MINOR.PATCH`);
  return version;
}

/** Throws a TypeError for anything outside the grammar above, including empty intervals. */
export function parseCliVersionRange(range: string): CliVersionRange {
  if (typeof range !== 'string') throw new TypeError('A compatibility range must be a string');
  const interval = INTERVAL.exec(range);
  if (!interval) {
    const exact = requireVersion(range, range);
    return { source: range, kind: 'exact', low: exact, high: exact };
  }
  const low = requireVersion(interval[1]!, range);
  const high = requireVersion(interval[2]!, range);
  if (compareCliVersions(low, high) >= 0) {
    throw new TypeError(`Malformed compatibility range ${JSON.stringify(range)}: the lower bound must be below the upper bound`);
  }
  return { source: range, kind: 'interval', low, high };
}

export function rangeIncludes(range: CliVersionRange, version: CliVersion): boolean {
  if (range.kind === 'exact') return compareCliVersions(range.low, version) === 0;
  return compareCliVersions(range.low, version) <= 0 && compareCliVersions(version, range.high) < 0;
}

/**
 * Two intervals overlap when some version lies in both. An exact version inside an interval is not an overlap:
 * it is the more specific statement and wins. Two intervals, or two equal exact versions, may not overlap.
 */
export function rangesConflict(a: CliVersionRange, b: CliVersionRange): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'exact') return compareCliVersions(a.low, b.low) === 0;
  return compareCliVersions(a.low, b.high) < 0 && compareCliVersions(b.low, a.high) < 0;
}
