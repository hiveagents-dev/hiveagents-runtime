import { canonical, freeze, hash, identifier, object } from '../../shared/json.js';
import { captureLogCommit } from './validation.js';
import { captureIdentity } from './reconstruction.js';
import { digest } from './encoding.js';
import { executionFailure } from './execution-types.js';
import type { CapturedEffectAssociation, ManagedEffectAssociation } from './execution-types.js';
import type { LogJsonValue, RunIdentity } from './types.js';
const neutral: RunIdentity = { systemId: 'validation', generation: 1, runId: 'validation', agentId: 'validation', harness: { id: 'sdk', version: '1', digest: '0'.repeat(64) } };
/** Bounded private data capture; preserves object insertion order for legacy decision hashes. */
export function captureExecutionValue(input: unknown): LogJsonValue {
  try { return (captureLogCommit({ requestId: 'capture', records: [{ identity: neutral, schema: { id: 'capture', version: 1 }, type: 'capture', causal: [], payload: { inline: input } }] }).records[0]!.payload as { inline: LogJsonValue }).inline; }
  catch { return executionFailure('PAYLOAD_CODEC_REQUIRED'); }
}
export function runKey(sourceId: string, identity: RunIdentity): string { return digest(canonical({ sourceId, identity })); }
export function effectId(association: CapturedEffectAssociation): string {
  return digest(canonical({ sourceId: association.sourceId, systemId: association.identity.systemId, generation: association.identity.generation, effectKey: association.effectKey }));
}
export function captureAssociation(input: ManagedEffectAssociation, sourceId: string, systemId: string): CapturedEffectAssociation {
  try {
    const next = captureExecutionValue(input); object(next, ['identity', 'stepId', 'effectKey', 'operation', 'parentEffectKey']);
    const identity = captureIdentity(next.identity as unknown as RunIdentity); if (identity.systemId !== systemId) executionFailure('INVALID_STATE');
    identifier(next.stepId); identifier(next.effectKey); if (next.parentEffectKey !== undefined) identifier(next.parentEffectKey);
    const operation = next.operation; object(operation, ['id', 'version', 'targetDigest', 'contentDigest', 'provider', 'model']);
    identifier(operation.id); identifier(operation.version); hash(operation.targetDigest); hash(operation.contentDigest);
    if (operation.provider !== undefined) identifier(operation.provider); if (operation.model !== undefined) identifier(operation.model);
    if (Object.keys(next).length < 4 || Object.keys(operation).length < 4 || next.parentEffectKey === next.effectKey) executionFailure('INVALID_STATE');
    return freeze({ ...next, sourceId, identity }) as unknown as CapturedEffectAssociation;
  } catch { return executionFailure('INVALID_STATE'); }
}
export function encodeExecutionValue(input: unknown): string {
  const encoded = JSON.stringify(captureExecutionValue(input));
  if (Buffer.byteLength(encoded) > 60000) executionFailure('PAYLOAD_CODEC_REQUIRED');
  return encoded;
}
export function decodeExecutionValue(text: unknown, expectedDigest: unknown): LogJsonValue {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 60000 || digest(text) !== expectedDigest) executionFailure('INTEGRITY');
    const value = captureExecutionValue(JSON.parse(text)); if (JSON.stringify(value) !== text) executionFailure('INTEGRITY'); return value;
  } catch { return executionFailure('INTEGRITY'); }
}
