import { isAbsolute } from 'node:path';
import { canonical, checksum } from '../../shared/json.js';
import { jsonClone } from '../workflow/checkpoint.js';
import type { HandoffTarget, TaskHandoff, TaskHandoffDraft } from './types.js';

const draftKeys = ['id', 'goal', 'requirements', 'context', 'source', 'destination', 'sourceSession', 'evidence', 'artifacts', 'pending', 'unresolvedEffects'];
const requiredKeys = draftKeys.filter(key => key !== 'sourceSession');
const fail = (field: string): never => { throw new Error(`Invalid handoff ${field}`); };

export function fields(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('object');
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) fail('object');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('property');
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(object, key))) return fail('fields');
  return object;
}
export function text(value: unknown, name: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(name);
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,255}$/u.test(value)) fail('identifier');
}
export function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('digest');
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Bound traversal before cloning, and never invoke getters, symbols or custom serialization. */
function snapshot<T>(value: T): T {
  let nodes = 0; const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 50_000 || depth > 64) fail('JSON bounds');
    if (item === null || typeof item !== 'object') return;
    if (ancestors.has(item)) fail('JSON cycle');
    const prototype = Object.getPrototypeOf(item);
    if ((Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(item).length) fail('JSON object');
    ancestors.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('JSON property');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const next = jsonClone(value);
  if (Buffer.byteLength(JSON.stringify(next)) > 1_048_576) fail('JSON size');
  return next;
}
function list(value: unknown, check: (item: unknown) => void): void {
  if (!Array.isArray(value) || value.length > 1000) return fail('list');
  for (const item of value) check(item);
}
function strings(value: unknown): void { list(value, item => text(item, 'list entry')); }
function validateTarget(value: unknown): void {
  const next = fields(value, ['id', 'version', 'provider', 'model'], ['id', 'version']);
  identifier(next.id); identifier(next.version);
  if (Object.hasOwn(next, 'provider')) identifier(next.provider);
  if (Object.hasOwn(next, 'model')) text(next.model, 'model', 256);
}
export function snapshotTarget(value: HandoffTarget): HandoffTarget {
  const next = snapshot(value); validateTarget(next); return freeze(next);
}
function session(value: unknown): void {
  const next = fields(value, ['schemaVersion', 'provider', 'id', 'model', 'cwd', 'transport', 'persistence', 'transportEpoch', 'cliVersion', 'createdAt', 'sessionId', 'forkedFromId', 'parentSessionId'],
    ['schemaVersion', 'provider', 'id', 'cwd', 'transport', 'persistence', 'createdAt']);
  if (next.schemaVersion !== 1 || typeof next.transport !== 'string' || !['exec', 'control'].includes(next.transport)
    || typeof next.persistence !== 'string' || !['provider', 'process'].includes(next.persistence)) fail('session provenance');
  identifier(next.provider); text(next.id, 'session id', 256); text(next.cwd, 'session cwd');
  if (!isAbsolute(next.cwd)) fail('session cwd');
  text(next.createdAt, 'session timestamp', 64);
  if (!Number.isFinite(Date.parse(next.createdAt))) fail('session timestamp');
  for (const key of ['model', 'transportEpoch', 'cliVersion', 'sessionId', 'forkedFromId', 'parentSessionId']) {
    if (Object.hasOwn(next, key)) text(next[key], `session ${key}`, 256);
  }
  if (Object.hasOwn(next, 'sessionId') && next.sessionId !== next.id) fail('session id alias');
}

/** Selected context and provenance are data only; no generated timestamp enters the identity. */
export function createTaskHandoff(draft: TaskHandoffDraft): TaskHandoff {
  const next = snapshot(draft), object = fields(next, draftKeys, requiredKeys);
  identifier(next.id); text(next.goal, 'goal', 16_384); strings(next.requirements);
  const source = fields(next.source, ['id', 'version', 'digest', 'episodeId'], ['id', 'version', 'digest']);
  identifier(source.id); identifier(source.version); digest(source.digest);
  if (Object.hasOwn(source, 'episodeId')) identifier(source.episodeId);
  validateTarget(next.destination);
  if (Object.hasOwn(object, 'sourceSession')) session(next.sourceSession);
  list(next.evidence, value => { const item = fields(value, ['id', 'digest']); identifier(item.id); digest(item.digest); });
  list(next.artifacts, value => { const item = fields(value, ['uri', 'digest']); text(item.uri, 'artifact URI');
    try { new URL(item.uri); } catch { fail('artifact URI'); } digest(item.digest); });
  strings(next.pending); strings(next.unresolvedEffects);
  const payload = { ...next, format: 1 as const };
  const bundle = { ...payload, digest: checksum(canonical(payload)) };
  if (Buffer.byteLength(JSON.stringify(bundle)) > 1_048_576) fail('JSON size');
  return freeze(bundle);
}

export function snapshotHandoff(value: unknown, id?: string): TaskHandoff {
  const next = fields(snapshot(value), [...draftKeys, 'format', 'digest'], [...requiredKeys, 'format', 'digest']);
  if (next.format !== 1 || (id !== undefined && next.id !== id)) fail('identity');
  digest(next.digest);
  const { format: _format, digest: supplied, ...draft } = next;
  const bundle = createTaskHandoff(draft as unknown as TaskHandoffDraft);
  if (bundle.digest !== supplied) fail('checksum');
  return bundle;
}
