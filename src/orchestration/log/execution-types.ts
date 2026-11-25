import { ExecutionHaltedError, rethrowExecutionHalt } from '../../public/execution-halt.js';
import type { RunIdentity } from './types.js';
import type { createLogArtifactStore } from './artifacts.js';
export type ExecutionArtifactStore = Pick<Awaited<ReturnType<typeof createLogArtifactStore>>, 'write' | 'read' | 'verify'>;
export interface LogExecutionDatabaseOptions {
  readonly databasePath: string; readonly systemId: string; readonly busyTimeoutMs?: number;
  readonly artifactStore?: ExecutionArtifactStore; readonly maxRecordBytes?: number;
}
export interface ManagedEffectAssociation {
  readonly identity: RunIdentity; readonly stepId: string; readonly effectKey: string;
  readonly operation: Readonly<{ id: string; version: string; targetDigest: string; contentDigest: string; provider?: string; model?: string }>;
  readonly parentEffectKey?: string;
}
export interface CapturedEffectAssociation extends ManagedEffectAssociation { readonly sourceId: string }
export interface ExecutionOwnership {
  readonly format: 1; readonly sourceId: string; readonly kind: 'decision' | 'workflow'; readonly runKey: string;
  readonly identity: RunIdentity; readonly ownerId: string;
}
export interface StandaloneStoppedAcknowledgement { readonly ownerStopped: true }
export type LogExecutionFailure = 'INVALID_STATE' | 'STORAGE_UNCERTAIN' | 'INTEGRITY' | 'RUN_OWNED'
  | 'EFFECT_BINDING_CONFLICT' | 'OUTCOME_UNKNOWN' | 'CLOSED' | 'PAYLOAD_CODEC_REQUIRED' | 'PAYLOAD_UNAVAILABLE' | 'CODEC_LIMIT' | 'CODEC_BUSY';
const failures: readonly string[] = ['INVALID_STATE', 'STORAGE_UNCERTAIN', 'INTEGRITY', 'RUN_OWNED', 'EFFECT_BINDING_CONFLICT', 'OUTCOME_UNKNOWN', 'CLOSED', 'PAYLOAD_CODEC_REQUIRED', 'PAYLOAD_UNAVAILABLE', 'CODEC_LIMIT', 'CODEC_BUSY'];
const genuine = new WeakSet<object>();
/** Nominal SDK halt: infrastructure/effect uncertainty is not negative model-quality evidence. */
export class LogExecutionError extends ExecutionHaltedError {
  readonly reason: LogExecutionFailure;
  constructor(reason: LogExecutionFailure) {
    const safe = failures.includes(reason) ? reason : 'INVALID_STATE';
    super({ sanitizedDiagnostics: Object.freeze({ reason: safe }) }); this.reason = safe; genuine.add(this); Object.freeze(this);
  }
}
export function executionFailure(reason: LogExecutionFailure): never { throw new LogExecutionError(reason); }
export function safeExecutionFailure(error: unknown): never {
  rethrowExecutionHalt(error);
  if (error && typeof error === 'object' && genuine.has(error)) throw error;
  return executionFailure('STORAGE_UNCERTAIN');
}
