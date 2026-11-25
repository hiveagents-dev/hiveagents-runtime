import { types } from 'node:util';
import { canonical, freeze, hash, object } from '../../shared/json.js';
import type { AgentEvent, Usage } from '../../public/types.js';
import type { TraceEventInput } from '../tracing/types.js';
import { projectAgentEvent } from '../tracing/projector.js';
import { validateEvent, validateUsage } from '../tracing/validation.js';
import { captureLogCommit } from './validation.js';
import { digest } from './encoding.js';
import type { LogReceipt, RunIdentity } from './types.js';

export const AGENT_METADATA_SCHEMA = 'oar.sdk.agent-event-metadata';
export const CAPTURE_OPERATION_SCHEMA = 'oar.sdk.capture-operation';
const eventTypes = ['session.started', 'turn.started', 'message.delta', 'message.completed', 'tool.started', 'tool.updated', 'tool.completed',
  'subagent.started', 'subagent.completed', 'interaction.requested', 'context.compacted', 'turn.completed', 'provider.event'];
const usageKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'reportedCostUsd'];
const eventKeys = ['type', 'sessionId', 'turnId', 'status', 'count', 'toolId', 'subagentId', 'interactionId', 'usage'];
export interface CaptureActual { readonly providerDigest: string; readonly modelDigest?: string; readonly attemptDigest: string; readonly transport?: 'exec' | 'control'; readonly phase?: 'startup' | 'turn'; readonly sessionIdDigest?: string; readonly transportEpochDigest?: string }
export interface CapturedAgentMetadata {
  readonly mode: 'metadata-only'; readonly invocationDigest: string; readonly actual: CaptureActual; readonly event: TraceEventInput;
  readonly sessionBinding?: Readonly<{ bindingDigest: string; sessionIdDigest: string; transportEpochDigest: string; providerDigest: string; modelDigest?: string; transport: 'exec' | 'control'; persistence: 'provider' | 'process' }>;
}
export interface CapturedOperationMetadata {
  readonly mode: 'metadata-only'; readonly invocationDigest: string; readonly actual: CaptureActual;
  readonly stage: 'started' | 'settled' | 'interrupted'; readonly outcome?: 'returned' | 'failed' | 'halted'; readonly usage?: Usage;
}
export function invalidCapture(): never { throw new TypeError('Invalid required log capture'); }
/** Only selected own data descriptors are read. Ignored native fields are never traversed. */
export function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalidCapture();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return invalidCapture(); return descriptor.value;
}
export function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalidCapture(); return value as number;
}
export function boundedDataArray(input: unknown, max: number): readonly unknown[] {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max || Object.getOwnPropertySymbols(input).length) invalidCapture();
  const descriptors = Object.getOwnPropertyDescriptors(input); if (Object.keys(descriptors).length !== input.length + 1) invalidCapture();
  for (let i = 0; i < input.length; i++) { const d = descriptors[String(i)]; if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) invalidCapture(); }
  return input;
}
export function idDigest(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || Buffer.from(value).toString('utf8') !== value) invalidCapture(); return digest(value);
}
export function captureIdentity(input: RunIdentity): RunIdentity {
  return captureLogCommit({ requestId: 'capture-validation', records: [{ identity: input, schema: { id: CAPTURE_OPERATION_SCHEMA, version: 1 }, type: 'capture.started', causal: [], payload: { inline: null } }] }).records[0]!.identity;
}
/** A receipt is trusted store DATA; its shape cannot supply an execution or closure capability. */
export function captureReceipt(input: unknown, sourceId?: string): LogReceipt {
  object(input, ['first', 'head', 'count']); if (input.count !== 1) invalidCapture();
  for (const value of [input.first, input.head]) {
    object(value, ['sourceId', 'sequence', 'digest']);
    if (typeof value.sourceId !== 'string' || !value.sourceId || value.sourceId.length > 128 || sourceId !== undefined && value.sourceId !== sourceId) invalidCapture();
    boundedInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER); hash(value.digest);
  }
  if (canonical(input.first) !== canonical(input.head)) invalidCapture();
  return freeze({ first: { ...input.first as LogReceipt['first'] }, head: { ...input.head as LogReceipt['head'] }, count: 1 });
}
export function captureActual(input: unknown): CaptureActual {
  object(input, ['provider', 'model', 'attemptId', 'transport', 'phase', 'sessionId', 'transportEpoch']);
  if (input.transport !== undefined && !['exec', 'control'].includes(input.transport as string) || input.phase !== undefined && !['startup', 'turn'].includes(input.phase as string)) invalidCapture();
  return freeze({ providerDigest: idDigest(input.provider), ...(input.model === undefined ? {} : { modelDigest: idDigest(input.model) }), attemptDigest: idDigest(input.attemptId), ...(input.transport === undefined ? {} : { transport: input.transport as 'exec' | 'control' }), ...(input.phase === undefined ? {} : { phase: input.phase as 'startup' | 'turn' }), ...(input.sessionId === undefined ? {} : { sessionIdDigest: idDigest(input.sessionId) }), ...(input.transportEpoch === undefined ? {} : { transportEpochDigest: idDigest(input.transportEpoch) }) });
}
export function safeUsage(input: unknown): Usage {
  object(input, [...usageKeys, 'costMeaning', 'perModel']); const copy: Record<string, unknown> = {};
  for (const key of [...usageKeys, 'costMeaning']) if (Object.hasOwn(input, key)) copy[key] = input[key];
  if (Object.hasOwn(input, 'perModel')) {
    object(input.perModel); const names = Object.keys(input.perModel); if (names.length > 32) invalidCapture();
    const models: Record<string, unknown> = Object.create(null);
    for (const name of names) { object(input.perModel[name], usageKeys); models[idDigest(name)] = { ...input.perModel[name] }; }
    copy.perModel = models;
  }
  return freeze(validateUsage(copy));
}
function optionalId(input: unknown, key: string) { const value = field(input, key); return value === undefined ? {} : { [key]: idDigest(value) }; }
/** Reuses the SDK projector on an owned minimal object; private text is counted, never serialized. */
export function captureAgentEvent(input: AgentEvent): TraceEventInput {
  const type = field(input, 'type'); if (typeof type !== 'string' || !eventTypes.includes(type)) invalidCapture();
  let safe: unknown;
  switch (type) {
    case 'session.started': safe = { type, session: { id: idDigest(field(field(input, 'session'), 'id')) } }; break;
    case 'turn.started': safe = { type, ...optionalId(input, 'turnId') }; break;
    case 'message.delta': case 'message.completed': {
      const text = field(input, 'text'); if (typeof text !== 'string') invalidCapture(); safe = { type, text }; break;
    }
    case 'tool.started': case 'tool.updated': case 'tool.completed': case 'subagent.started': case 'subagent.completed': safe = { type, id: idDigest(field(input, 'id')) }; break;
    case 'interaction.requested': {
      const binding = field(field(input, 'request'), 'binding'); safe = { type, request: { binding: { interactionId: idDigest(field(binding, 'interactionId')), sessionId: idDigest(field(binding, 'sessionId')), ...optionalId(binding, 'turnId') } } }; break;
    }
    case 'turn.completed': {
      const turn = field(input, 'turn'), usage = field(turn, 'usage'); safe = { type, turn: { ...optionalId(turn, 'id'), status: field(turn, 'status'), session: { id: idDigest(field(field(turn, 'session'), 'id')) }, ...(usage === undefined ? {} : { usage: safeUsage(usage) }) } }; break;
    }
    default: safe = { type };
  }
  return freeze(projectAgentEvent(safe as AgentEvent));
}
/** Preserve the actual complete SessionIdentity as a digest-bound fact without exposing cwd/native labels. */
export function captureSessionBinding(event: AgentEvent): CapturedAgentMetadata['sessionBinding'] {
  const type = field(event, 'type'), session = type === 'session.started' ? field(event, 'session') : type === 'turn.completed' ? field(field(event, 'turn'), 'session') : undefined;
  if (session === undefined || field(session, 'schemaVersion') === undefined) return undefined;
  const fields = ['schemaVersion', 'id', 'provider', 'model', 'cwd', 'transport', 'persistence', 'transportEpoch', 'createdAt'];
  const copy: Record<string, unknown> = {};
  for (const key of fields) { const value = field(session, key); if (key === 'model' && value === undefined) continue; copy[key] = value; }
  if (copy.schemaVersion !== 1 || !['exec', 'control'].includes(copy.transport as string) || !['provider', 'process'].includes(copy.persistence as string)) invalidCapture();
  for (const key of ['id', 'provider', 'cwd', 'transportEpoch', 'createdAt']) idDigest(copy[key]); if (copy.model !== undefined) idDigest(copy.model);
  return freeze({ bindingDigest: digest(canonical(copy)), sessionIdDigest: idDigest(copy.id), transportEpochDigest: idDigest(copy.transportEpoch), providerDigest: idDigest(copy.provider), ...(copy.model === undefined ? {} : { modelDigest: idDigest(copy.model) }), transport: copy.transport as 'exec' | 'control', persistence: copy.persistence as 'provider' | 'process' });
}
function validateActual(input: unknown): CaptureActual {
  object(input, ['providerDigest', 'modelDigest', 'attemptDigest', 'transport', 'phase', 'sessionIdDigest', 'transportEpochDigest']); hash(input.providerDigest); hash(input.attemptDigest); for (const key of ['modelDigest', 'sessionIdDigest', 'transportEpochDigest']) if (input[key] !== undefined) hash(input[key]);
  if (input.transport !== undefined && !['exec', 'control'].includes(input.transport as string) || input.phase !== undefined && !['startup', 'turn'].includes(input.phase as string)) invalidCapture();
  return input as unknown as CaptureActual;
}
/** Decoder accepts only the closed metadata grammar, never arbitrary TraceEvent fields/prose. */
export function decodeCaptureMetadata(schema: string, type: string, input: unknown): CapturedAgentMetadata | CapturedOperationMetadata {
  object(input, schema === AGENT_METADATA_SCHEMA ? ['mode', 'invocationDigest', 'actual', 'event', 'sessionBinding'] : ['mode', 'invocationDigest', 'actual', 'stage', 'outcome', 'usage']);
  if (input.mode !== 'metadata-only') invalidCapture(); hash(input.invocationDigest); validateActual(input.actual);
  if (schema === AGENT_METADATA_SCHEMA) {
    object(input.event, eventKeys); if (!eventTypes.includes(input.event.type as string) || input.event.type !== type) invalidCapture();
    for (const key of ['sessionId', 'turnId', 'toolId', 'subagentId', 'interactionId']) if (input.event[key] !== undefined) hash(input.event[key]);
    if (input.event.status !== undefined && !['completed', 'failed', 'interrupted', 'refused'].includes(input.event.status as string)) invalidCapture();
    const required: Record<string, string[]> = { 'session.started': ['sessionId'], 'message.delta': ['count'], 'message.completed': ['count'], 'tool.started': ['toolId'], 'tool.updated': ['toolId'], 'tool.completed': ['toolId'], 'subagent.started': ['subagentId'], 'subagent.completed': ['subagentId'], 'interaction.requested': ['interactionId', 'sessionId'], 'turn.completed': ['sessionId', 'status'] };
    const allowed = ['type', ...(required[type] ?? []), ...(type === 'turn.started' || type === 'turn.completed' || type === 'interaction.requested' ? ['turnId'] : []), ...(type === 'turn.completed' ? ['usage'] : [])];
    object(input.event, allowed); for (const key of required[type] ?? []) if (!Object.hasOwn(input.event, key)) invalidCapture();
    if (input.event.usage !== undefined) validateEncodedUsage(input.event.usage);
    if (input.sessionBinding !== undefined) {
      const binding = input.sessionBinding; object(binding, ['bindingDigest', 'sessionIdDigest', 'transportEpochDigest', 'providerDigest', 'modelDigest', 'transport', 'persistence']);
      for (const key of ['bindingDigest', 'sessionIdDigest', 'transportEpochDigest', 'providerDigest']) hash(binding[key]); if (binding.modelDigest !== undefined) hash(binding.modelDigest);
      if (!['exec', 'control'].includes(binding.transport as string) || !['provider', 'process'].includes(binding.persistence as string) || binding.sessionIdDigest !== input.event.sessionId) invalidCapture();
    }
    validateEvent(input.event);
  } else {
    if (schema !== CAPTURE_OPERATION_SCHEMA || !['started', 'settled', 'interrupted'].includes(input.stage as string) || type !== `capture.${input.stage}`) invalidCapture();
    if (input.stage === 'started' ? input.outcome !== undefined || input.usage !== undefined : !['returned', 'failed', 'halted'].includes(input.outcome as string)) invalidCapture();
    if (input.usage !== undefined) validateEncodedUsage(input.usage);
  }
  if (Buffer.byteLength(canonical(input)) > 16384) invalidCapture();
  return freeze(input) as unknown as CapturedAgentMetadata | CapturedOperationMetadata;
}
function validateEncodedUsage(input: unknown): void {
  object(input, [...usageKeys, 'costMeaning', 'perModel']);
  if (input.perModel !== undefined) { object(input.perModel); for (const key of Object.keys(input.perModel)) { hash(key); object(input.perModel[key], usageKeys); } }
  validateUsage(input);
}
