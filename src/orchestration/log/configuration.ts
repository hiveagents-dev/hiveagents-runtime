import { canonical, identifier, method, object, ownObject } from '../../shared/json.js';
import { types } from 'node:util';
import { validPath } from './sqlite-storage.js';
import { logError } from './store-types.js';
import type { LogPayloadVerifier, LogStoreOptions } from './store-types.js';
import type { LogCommit, PayloadReference } from './types.js';
import { capture } from './encoding.js';
import type { LogSourceDescriptor } from './store-types.js';

export interface Configuration {
  readonly databasePath: string; readonly systemId: string; readonly busyTimeoutMs: number;
  readonly maxPending: number; readonly schemas: ReadonlySet<string>;
  readonly verify: LogPayloadVerifier['verify'] | undefined;
}
export function configuration(input: LogStoreOptions): Configuration {
  try {
    input = ownObject(input, ['databasePath', 'systemId', 'busyTimeoutMs', 'maxPending', 'supportedSchemas', 'payloadVerifier']);
    validPath(input.databasePath); identifier(input.systemId);
    const busyTimeoutMs = input.busyTimeoutMs ?? 5000, maxPending = input.maxPending ?? 2;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) logError('INVALID_INPUT');
    const schemas = new Set<string>(), supported = input.supportedSchemas ?? [];
    if (types.isProxy(supported) || !Array.isArray(supported) || Object.getPrototypeOf(supported) !== Array.prototype
      || supported.length > 256 || Object.getOwnPropertySymbols(supported).length
      || Object.keys(supported).length !== supported.length) logError('INVALID_INPUT');
    for (let index = 0; index < supported.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(supported, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) logError('INVALID_INPUT');
      const schema = ownObject(descriptor.value, ['id', 'version']); object(schema); identifier(schema.id);
      if (Object.keys(schema).length !== 2 || !Number.isSafeInteger(schema.version) || Number(schema.version) < 1) logError('INVALID_INPUT');
      schemas.add(canonical(schema));
    }
    const verify = input.payloadVerifier === undefined ? undefined : method<LogPayloadVerifier['verify']>(input.payloadVerifier, 'verify');
    return Object.freeze({ databasePath: input.databasePath, systemId: input.systemId, busyTimeoutMs, maxPending, schemas, verify });
  } catch { return logError('INVALID_INPUT'); }
}
export async function verifyReference(verify: Configuration['verify'], ref: PayloadReference, source: LogSourceDescriptor, signal?: AbortSignal): Promise<'verified' | 'missing' | 'corrupt' | 'unverified'> {
  if (!verify) return 'unverified';
  try {
    const result = await verify(ref, signal ? { signal } : {}); object(result, ['kind', 'reference']);
    if (Object.keys(result).length !== 2 || !['verified', 'missing', 'corrupt'].includes(result.kind as string)) return 'corrupt';
    const checked = capture({ requestId: 'verify', records: [{ identity: { systemId: ref.systemId, generation: ref.generation, runId: 'verify', agentId: 'verify', harness: { id: 'verify', version: '1', digest: '0'.repeat(64) } }, schema: { id: 'verify', version: 1 }, type: 'verify', causal: [], payload: { artifact: result.reference } }] }, source);
    if (canonical(checked.records[0]!.payload) !== canonical({ artifact: ref })) return 'corrupt';
    return result.kind as 'verified' | 'missing' | 'corrupt';
  } catch { return 'unverified'; }
}
export async function verifyCommit(commit: LogCommit, config: Configuration, source: LogSourceDescriptor, signal?: AbortSignal): Promise<void> {
  for (const record of commit.records) if ('artifact' in record.payload) {
    if (await verifyReference(config.verify, record.payload.artifact, source, signal) !== 'verified') logError('PAYLOAD_UNAVAILABLE');
  }
}
