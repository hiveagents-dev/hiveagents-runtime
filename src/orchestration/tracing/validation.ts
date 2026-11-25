import { canonical, checksum } from '../../shared/json.js';
import type { Usage } from '../../public/types.js';
import type { TraceEntry, TraceEpisode, TraceEventInput, TraceIdentity } from './types.js';

export const MAX_TRACE_ENTRIES = 10_000;
export const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const inputKeys = ['type', 'phaseId', 'parentId', 'sessionId', 'turnId', 'status', 'code', 'count', 'toolId', 'subagentId', 'interactionId', 'usage'];
const usageKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reportedCostUsd'];

export function record(value: unknown, keys: readonly string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
    throw new Error(`Invalid trace ${field}`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`Invalid trace ${field} field`);
  }
}
export function identifier(value: unknown, field: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)) {
    throw new Error(`Invalid trace ${field}`);
  }
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid trace digest');
}
function integer(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid trace ${field}`);
}
// The shared serializer is the same algorithm this module used to define (see canonical-json tests).
export { canonical };
export function snapshot<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function validateIdentity(value: unknown): TraceIdentity {
  record(value, ['episodeId', 'task', 'source', 'profile', 'provider', 'model', 'transport', 'cliVersion'], 'identity');
  identifier(value.episodeId, 'episodeId');
  for (const key of ['task', 'source', 'profile'] as const) {
    const part = value[key], digestKey = key === 'task' ? 'inputDigest' : 'digest';
    record(part, ['id', 'version', digestKey], key);
    identifier(part.id, `${key} id`); identifier(part.version, `${key} version`, 128); hash(part[digestKey]);
  }
  for (const key of ['provider', 'model', 'transport', 'cliVersion']) if (Object.hasOwn(value, key)) identifier(value[key], key);
  return freeze(snapshot(value)) as unknown as TraceIdentity;
}
export function validateUsage(value: unknown): Usage {
  record(value, [...usageKeys, 'costMeaning', 'perModel'], 'usage');
  if (!['provider-reported', 'api-equivalent', 'estimate', 'unavailable'].includes(value.costMeaning as string)) throw new Error('Invalid trace usage costMeaning');
  const quantities = (part: Record<string, unknown>) => {
    for (const key of usageKeys) if (Object.hasOwn(part, key)) {
      if (key === 'reportedCostUsd') {
        if (typeof part[key] !== 'number' || !Number.isFinite(part[key]) || part[key] < 0) throw new Error('Invalid trace usage cost');
      } else integer(part[key], 'usage tokens');
    }
  };
  quantities(value);
  if (Object.hasOwn(value, 'perModel')) {
    const models = value.perModel;
    if (typeof models !== 'object' || models === null || Array.isArray(models)) throw new Error('Invalid trace usage models');
    const names = Object.keys(models);
    if (names.length > 32) throw new Error('Trace usage model limit exceeded');
    record(models, names, 'usage models');
    for (const name of names) { identifier(name, 'usage model'); const part = models[name]; record(part, usageKeys, 'model usage'); quantities(part); }
  }
  return snapshot(value) as unknown as Usage;
}
export function validateEvent(value: unknown, entry = false): TraceEventInput {
  record(value, entry ? [...inputKeys, 'sequence', 'timestamp'] : inputKeys, 'event');
  identifier(value.type, 'event type', 128);
  for (const key of inputKeys) {
    if (!Object.hasOwn(value, key) || key === 'type') continue;
    if (key === 'count') integer(value[key], 'event count');
    else if (key === 'usage') validateUsage(value[key]);
    else identifier(value[key], `event ${key}`);
  }
  if (entry) { integer(value.sequence, 'event sequence'); integer(value.timestamp, 'event timestamp'); }
  if (Buffer.byteLength(canonical(value)) > 16 * 1024) throw new Error('Trace event size limit exceeded');
  return snapshot(value) as unknown as TraceEventInput;
}
export function sealEpisode(value: Omit<TraceEpisode, 'digest'>): TraceEpisode {
  return freeze({ ...value, digest: checksum(canonical(value)) });
}
export function validateEpisode(value: unknown, episodeId: string): TraceEpisode {
  record(value, ['format', 'identity', 'status', 'startedAt', 'updatedAt', 'finishedAt', 'entries', 'digest'], 'episode');
  if (value.format !== 1) throw new Error('Invalid trace format');
  const identity = validateIdentity(value.identity);
  if (identity.episodeId !== episodeId) throw new Error('Trace store identity mismatch');
  if (!['running', 'completed', 'failed', 'cancelled'].includes(value.status as string)) throw new Error('Invalid trace status');
  integer(value.startedAt, 'startedAt'); integer(value.updatedAt, 'updatedAt');
  if (value.updatedAt < value.startedAt) throw new Error('Invalid trace timestamp order');
  if (value.status === 'running') {
    if (Object.hasOwn(value, 'finishedAt')) throw new Error('Invalid trace finished timestamp');
  } else {
    integer(value.finishedAt, 'finishedAt');
    if (value.finishedAt !== value.updatedAt) throw new Error('Invalid trace finished timestamp');
  }
  if (!Array.isArray(value.entries) || Object.getPrototypeOf(value.entries) !== Array.prototype || value.entries.length > MAX_TRACE_ENTRIES
    || Object.keys(value.entries).length !== value.entries.length || Object.getOwnPropertySymbols(value.entries).length) throw new Error('Invalid trace entries');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value.entries))) {
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.entries.length
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid trace entries field');
  }
  let previousTime = value.startedAt;
  for (let index = 0; index < value.entries.length; index++) {
    const entry = validateEvent(value.entries[index], true) as TraceEntry;
    if (entry.sequence !== index + 1) throw new Error('Invalid trace sequence');
    if (entry.timestamp < previousTime || entry.timestamp > value.updatedAt) throw new Error('Invalid trace event timestamp');
    previousTime = entry.timestamp;
  }
  hash(value.digest);
  const { digest, ...body } = value;
  const serialized = canonical(body);
  if (Buffer.byteLength(serialized) > MAX_TRACE_BYTES) throw new Error('Trace episode size limit exceeded');
  if (checksum(serialized) !== digest) throw new Error('Corrupt trace digest');
  return freeze(snapshot(value)) as unknown as TraceEpisode;
}
export function validateReplacement(previous: TraceEpisode, next: TraceEpisode): void {
  if (previous.status !== 'running') throw new Error('Trace episode is finished');
  if (canonical(previous.identity) !== canonical(next.identity) || previous.startedAt !== next.startedAt) throw new Error('Trace identity changed');
  if (next.updatedAt < previous.updatedAt || next.entries.length < previous.entries.length
    || canonical(next.entries.slice(0, previous.entries.length)) !== canonical(previous.entries)) throw new Error('Trace history cannot be replaced');
}
