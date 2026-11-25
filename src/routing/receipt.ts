import { canonical, digest, freeze, hash, identifier, jsonClone, method, object } from '../shared/json.js';
import type { RoutingCandidate, RoutingReceipt, RoutingReceiptStore } from './types.js';
const codes = ['READY', 'NOT_NEEDED', 'NOT_IN_RULE', 'PROVIDER_NOT_ALLOWED', 'MODEL_UNAVAILABLE', 'MODEL_UNVERIFIED', 'CLI_MISSING', 'AUTH_REQUIRED', 'AUTH_UNKNOWN', 'SUBSCRIPTION_REQUIRED', 'CLI_UNSUPPORTED', 'POLICY_UNSUPPORTED', 'PROBE_FAILED', 'ABORTED', 'TIMEOUT'];
const reasons = ['FIXED', 'PRIORITY', 'RULE', 'FALLBACK', 'NO_CANDIDATES', 'NO_ELIGIBLE_CANDIDATE', 'NO_MATCHING_RULE', 'ABORTED', 'TIMEOUT'];
function member(value: unknown, values: readonly unknown[]): void { if (!values.includes(value)) throw new TypeError('Invalid receipt enum'); }
function model(value: Record<string, unknown>): void {
  if (typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.provider)
    || ['constructor', 'prototype', '__proto__'].includes(value.provider)
    || typeof value.modelId !== 'string' || !value.modelId.trim() || value.model !== `${value.provider}/${value.modelId}`
    || (value.model as string).length > 512) throw new TypeError('Invalid receipt model');
}
/** Strict clone, semantic validation and canonical checksum; returned proposals are deeply immutable. */
export function validateRoutingReceipt(value: unknown): RoutingReceipt {
  const copy: unknown = jsonClone(value);
  if (Buffer.byteLength(canonical(copy)) > 1048576) throw new TypeError('Receipt exceeds 1MiB');
  object(copy, ['format', 'purpose', 'id', 'createdAt', 'configDigest', 'taskDigest', 'sourceDigest', 'policy', 'decision', 'reason', 'candidates', 'nativeDispatches', 'selected', 'digest']);
  if (copy.format !== 1 || copy.purpose !== 'selection-proposal' || copy.nativeDispatches !== 0
    || !Number.isSafeInteger(copy.createdAt) || (copy.createdAt as number) < 0) throw new TypeError('Invalid receipt format');
  identifier(copy.id); hash(copy.configDigest); hash(copy.taskDigest); hash(copy.digest);
  if ('sourceDigest' in copy) hash(copy.sourceDigest);
  object(copy.policy, ['mode', 'version', 'ruleId']); member(copy.policy.mode, ['fixed', 'auto']);
  if (copy.policy.version !== 'priority-v1') throw new TypeError('Invalid policy version');
  if ('ruleId' in copy.policy) { identifier(copy.policy.ruleId); if (copy.policy.mode !== 'auto') throw new TypeError('Fixed rule'); }
  member(copy.decision, ['selected', 'abstained']); member(copy.reason, reasons);
  if (!Array.isArray(copy.candidates) || copy.candidates.length > 64) throw new TypeError('Invalid candidates');
  const seen = new Set<string>();
  for (const candidate of copy.candidates) {
    object(candidate, ['model', 'provider', 'modelId', 'status', 'code', 'transport', 'fingerprintDigest', 'authState', 'authSource']); model(candidate);
    if (seen.has(candidate.model as string)) throw new TypeError('Duplicate receipt candidate'); seen.add(candidate.model as string);
    member(candidate.status, ['eligible', 'excluded', 'not-evaluated']); member(candidate.code, codes);
    if ('transport' in candidate) member(candidate.transport, ['exec', 'control']);
    if ('fingerprintDigest' in candidate) hash(candidate.fingerprintDigest);
    if ('authState' in candidate) member(candidate.authState, ['authenticated', 'not-authenticated', 'unknown']);
    if ('authSource' in candidate) member(candidate.authSource, ['subscription', 'api-key', 'cloud-provider', 'oauth', 'oss', 'unknown']);
    if (candidate.status === 'eligible' && candidate.authState === 'not-authenticated') throw new TypeError('Eligible authentication is negative');
    if (candidate.status === 'eligible' ? candidate.code !== 'READY' || !candidate.transport || !candidate.fingerprintDigest
      : candidate.status === 'not-evaluated' ? !['NOT_NEEDED', 'NOT_IN_RULE'].includes(candidate.code as string)
      : ['READY', 'NOT_NEEDED', 'NOT_IN_RULE'].includes(candidate.code as string)) throw new TypeError('Inconsistent candidate status');
  }
  if ((copy.decision === 'selected') !== ('selected' in copy)) throw new TypeError('Inconsistent selection');
  const eligible = (copy.candidates as RoutingCandidate[]).filter(entry => entry.status === 'eligible');
  if (copy.decision === 'selected') {
    object(copy.selected, ['model', 'provider', 'modelId', 'transport', 'fingerprintDigest']); model(copy.selected);
    member(copy.selected.transport, ['exec', 'control']); hash(copy.selected.fingerprintDigest);
    if (eligible.length !== 1 || Object.keys(copy.selected).length !== 5
      || Object.entries(copy.selected).some(([key, entry]) => entry !== (eligible[0] as unknown as Record<string, unknown>)[key])) throw new TypeError('Selected candidate mismatch');
    if (!['FIXED', 'PRIORITY', 'RULE', 'FALLBACK'].includes(copy.reason as string)) throw new TypeError('Inconsistent selected reason');
    if (copy.policy.mode === 'fixed' ? copy.reason !== 'FIXED' || copy.candidates.length !== 1 : copy.reason === 'FIXED') throw new TypeError('Inconsistent policy reason');
    if (copy.reason === 'RULE' && !copy.policy.ruleId) throw new TypeError('Missing matching rule');
    if (copy.reason === 'PRIORITY' && copy.policy.ruleId) throw new TypeError('Matched rules require RULE or FALLBACK');
  } else if (eligible.length || ['FIXED', 'PRIORITY', 'RULE', 'FALLBACK'].includes(copy.reason as string)) throw new TypeError('Inconsistent abstention');
  if (copy.policy.mode === 'fixed' && (copy.candidates.length !== 1 || ['NO_CANDIDATES', 'NO_MATCHING_RULE'].includes(copy.reason as string))) throw new TypeError('Invalid fixed abstention');
  if (copy.reason === 'NO_MATCHING_RULE' && (copy.policy.mode !== 'auto' || copy.policy.ruleId || copy.candidates.length === 0)) throw new TypeError('Invalid no-rule abstention');
  if (copy.candidates.length === 0 && (copy.policy.ruleId || !['NO_CANDIDATES', 'ABORTED', 'TIMEOUT'].includes(copy.reason as string))) throw new TypeError('Invalid empty universe reason');
  if (['NO_ELIGIBLE_CANDIDATE', 'NO_MATCHING_RULE'].includes(copy.reason as string) && (copy.candidates as RoutingCandidate[]).some(candidate => candidate.code === 'NOT_NEEDED')) throw new TypeError('Unfinished candidate evaluation');
  if (copy.reason === 'NO_MATCHING_RULE' && (copy.candidates as RoutingCandidate[]).some(candidate => !['NOT_IN_RULE', 'PROVIDER_NOT_ALLOWED', 'MODEL_UNAVAILABLE', 'MODEL_UNVERIFIED'].includes(candidate.code))) throw new TypeError('Unmatched rules cannot probe candidates');
  if (copy.policy.mode === 'fixed' && (copy.candidates as RoutingCandidate[]).some(candidate => ['NOT_IN_RULE', 'PROVIDER_NOT_ALLOWED', 'MODEL_UNVERIFIED', 'AUTH_UNKNOWN'].includes(candidate.code))) throw new TypeError('Fixed candidate has an automatic-only exclusion');
  if (copy.reason === 'NO_CANDIDATES' && copy.candidates.length !== 0) throw new TypeError('Inconsistent empty universe');
  const { digest: expected, ...body } = copy;
  if (digest(body) !== expected) throw new TypeError('Receipt digest mismatch');
  return freeze(copy as unknown as RoutingReceipt);
}
export function sealReceipt(value: Omit<RoutingReceipt, 'digest'>): RoutingReceipt { return validateRoutingReceipt({ ...value, digest: digest(value) }); }
export async function readRoutingReceipt(store: RoutingReceiptStore, id: string): Promise<RoutingReceipt | undefined> {
  identifier(id); const load = method<RoutingReceiptStore['load']>(store, 'load'); const result = await load(id);
  if (result === undefined) return undefined;
  const receipt = validateRoutingReceipt(result);
  if (receipt.id !== id) throw new TypeError('Receipt ID mismatch'); return receipt;
}
