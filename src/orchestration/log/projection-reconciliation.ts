import { canonical, freeze, hash, object } from '../../shared/json.js';
import { boundedDataArray, boundedInteger } from './capture-codec.js';
import { digest } from './encoding.js';
import type { LogEntry } from './store-types.js';
import type { ProjectionItem } from './projection-types.js';
const digests = ['decisionIdDigest', 'intentIdDigest', 'associationDigest', 'inputHash', 'authorityHash', 'inputVersionDigest', 'authorityVersionDigest', 'resultHash'];
const fields = ['kind', 'status', ...digests, 'evidenceDigests', 'original', 'verified'];
function reference(input: unknown) {
  object(input, ['sourceIdDigest', 'sequence', 'digest']); if (Object.keys(input).length !== 3) throw Error();
  hash(input.sourceIdDigest); hash(input.digest); boundedInteger(input.sequence, 1, Number.MAX_SAFE_INTEGER);
  return { sourceIdDigest: input.sourceIdDigest, sequence: input.sequence as number, digest: input.digest };
}
/** Closed finite metadata only. Neither reconciliation status nor these hashes grant effects/release. */
export function capturePublicReconciliation(input: unknown): Readonly<Record<string, unknown>> {
  object(input, fields); if (Object.keys(input).length !== fields.length || input.kind !== 'decision-reconciliation' || input.status !== 'verified') throw Error();
  for (const key of digests) hash(input[key]); const evidenceDigests = boundedDataArray(input.evidenceDigests, 64); for (const value of evidenceDigests) hash(value);
  const original = reference(input.original), verified = reference(input.verified);
  if (original.sequence >= verified.sequence) throw Error();
  return freeze({ ...input, evidenceDigests: [...evidenceDigests], original, verified });
}
export function projectReconciliation(entry: LogEntry, input: unknown): Readonly<Record<string, unknown>> {
  object(input, fields); if (entry.record.type !== 'decision.reconciled') throw Error();
  const transform = (raw: unknown) => {
    object(raw, ['sourceId', 'sequence', 'digest']); if (raw.sourceId !== entry.sourceId || Object.keys(raw).length !== 3) throw Error();
    hash(raw.digest); boundedInteger(raw.sequence, 1, entry.sequence - 1);
    return { sourceIdDigest: digest(entry.sourceId), sequence: raw.sequence, digest: raw.digest };
  };
  if (canonical(entry.record.causal) !== canonical([input.original, input.verified])) throw Error();
  return capturePublicReconciliation({ ...input, original: transform(input.original), verified: transform(input.verified) });
}
export function coherentReconciliation(item: ProjectionItem, items: ReadonlyMap<number, ProjectionItem>, sourceId: string): boolean {
  const m = item.metadata! as Record<string, unknown>, original = reference(m.original), verified = reference(m.verified);
  if (original.sourceIdDigest !== digest(sourceId) || verified.sourceIdDigest !== digest(sourceId) || verified.sequence >= item.position.sequence
    || canonical(item.causal) !== canonical([original, verified])) return false;
  const before = items.get(original.sequence), after = items.get(verified.sequence);
  if (before?.position.digest !== original.digest || after?.position.digest !== verified.digest || before.category !== 'decision' || after.category !== 'decision') return false;
  const b = before.metadata as Record<string, unknown>, a = after.metadata as Record<string, unknown>;
  return ['intent', 'dispatched', 'needs-owner'].includes(b.status as string) && a.status === 'verified' && a.resultHash === m.resultHash
    && ['decisionIdDigest', 'intentIdDigest', 'inputHash', 'authorityHash', 'inputVersionDigest', 'authorityVersionDigest'].every(key => b[key] === m[key] && a[key] === m[key]);
}
