import type { PayloadReference } from './types.js';
export interface LogArtifactBinding { readonly sourceId: string; readonly systemId: string; readonly generation: number }
export interface LogArtifactOptions { readonly directory: string; readonly binding: LogArtifactBinding; readonly maxBytes?: number; readonly maxPending?: number }
export interface LogArtifactReadOptions { readonly signal?: AbortSignal }
export interface LogArtifactWriteOptions extends LogArtifactReadOptions { readonly mediaType: PayloadReference['mediaType'] }
/** Byte integrity/durability data only, never execution, recovery or release permission. */
export interface LogArtifactVerification { readonly kind: 'verified' | 'missing' | 'corrupt'; readonly reference: PayloadReference }
export type LogArtifactErrorCode = 'INVALID' | 'LIMIT' | 'BUSY' | 'ABORTED' | 'MISSING' | 'CORRUPT' | 'IO';
export class LogArtifactError extends Error {
  constructor(readonly code: LogArtifactErrorCode, cause?: unknown) {
    super('Execution log artifact operation failed', cause === undefined ? undefined : { cause }); this.name = 'LogArtifactError';
  }
}
export const LOG_ARTIFACT_LIMITS = Object.freeze({ chunkBytes: 65536, maxBytes: 128 * 1024 * 1024, maxPending: 2 });
