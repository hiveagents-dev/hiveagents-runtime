import type { LogCommit, LogDraft, LogPosition, PayloadReference, RunIdentity } from './types.js';

export interface LogSourceDescriptor { readonly format: 1; readonly sourceId: string; readonly systemId: string }
export interface LogEntry extends LogPosition {
  readonly format: 1; readonly requestId: string; readonly ordinal: number;
  readonly previousDigest: string; readonly record: LogDraft;
}
/** Trusted content verification only. This port grants no execution or retention authority. */
export interface LogPayloadVerifier {
  verify(reference: PayloadReference, options?: { signal?: AbortSignal }): Promise<{
    readonly kind: 'verified' | 'missing' | 'corrupt'; readonly reference: PayloadReference;
  }>;
}
export interface LogStoreOptions {
  readonly databasePath: string; readonly systemId: string; readonly busyTimeoutMs?: number;
  readonly maxPending?: number; readonly supportedSchemas?: readonly Readonly<{ id: string; version: number }>[];
  readonly payloadVerifier?: LogPayloadVerifier;
}
/** A cursor is private DATA, neither a capability nor an independent whole-history proof. */
export interface LogCursor {
  readonly format: 1; readonly filterDigest: string; readonly after: LogPosition; readonly through: LogPosition;
}
export interface LogQuery {
  readonly generation?: number; readonly runId?: string; readonly agentId?: string;
  readonly limit?: number; readonly cursor?: LogCursor;
}
export interface LogPage {
  readonly source: LogSourceDescriptor; readonly through: LogPosition;
  readonly items: readonly LogEntry[]; readonly scanned: number; readonly nextCursor?: LogCursor;
}
export type ReconstructionIssue = 'RUN_NOT_FOUND' | 'UNKNOWN_SCHEMA' | 'UNRESOLVED_CAUSAL_REFERENCE'
  | 'PAYLOAD_UNVERIFIED' | 'PAYLOAD_MISSING' | 'PAYLOAD_CORRUPT' | 'LOG_CORRUPT';
/** Completeness refers ONLY to captured history at `through`, never operational resume or success. */
export interface RunReconstruction {
  readonly scope: 'captured-history'; readonly kind: 'complete' | 'incomplete' | 'corrupt';
  readonly identity: RunIdentity; readonly through?: LogPosition; readonly eventCount: number;
  readonly issues: readonly ReconstructionIssue[];
}
declare const prepared: unique symbol;
/** Opaque preverified DATA. Reusable only with its original binding after rollback/ACK loss. */
export interface PreparedLogCommit { readonly [prepared]: true }
export type LogStoreErrorCode = 'INVALID_INPUT' | 'INTEGRITY' | 'STORAGE' | 'CLOSED' | 'BUSY'
  | 'REQUEST_CONFLICT' | 'PAYLOAD_UNAVAILABLE' | 'TRANSACTION_REQUIRED' | 'UNSUPPORTED_RUNTIME';
const errors = new WeakSet<object>();
export class LogStoreError extends Error {
  readonly code: LogStoreErrorCode;
  constructor(code: LogStoreErrorCode) {
    const safe = ['INVALID_INPUT', 'INTEGRITY', 'STORAGE', 'CLOSED', 'BUSY', 'REQUEST_CONFLICT', 'PAYLOAD_UNAVAILABLE', 'TRANSACTION_REQUIRED', 'UNSUPPORTED_RUNTIME'].includes(code) ? code : 'INVALID_INPUT';
    super(`Invalid execution log: ${safe}`); this.code = safe; this.name = 'LogStoreError'; errors.add(this); Object.freeze(this);
  }
}
export function isLogStoreError(value: unknown): value is LogStoreError { return !!value && typeof value === 'object' && errors.has(value); }
export function logError(code: LogStoreErrorCode): never { throw new LogStoreError(code); }
export function safeFailure(error: unknown): never {
  if (isLogStoreError(error)) throw error;
  return logError('STORAGE');
}
export type CapturedCommit = LogCommit;
