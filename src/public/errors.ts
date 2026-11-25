import { types } from 'node:util';
import type { ProviderId, SessionRef, TransportKind, Usage } from './types.js';

/** Closed semantic facts, classified before native prose is discarded. No retry/reset authority. */
export interface FailureClassification {
  kind: 'not-authenticated' | 'unknown-model' | 'model-unavailable' | 'usage-limit'
    | 'untrusted-workspace' | 'session-not-found' | 'provider-unavailable' | 'protocol';
  reason?: 'request-rejected' | 'provider-overloaded' | 'transport' | 'execution-limit' | 'unknown';
  /** Provider-reported reset in epoch milliseconds; only present on a confirmed usage rejection. */
  retryAt?: number;
}

export interface ErrorContext {
  provider?: ProviderId;
  transport?: TransportKind;
  cliVersion?: string;
  session?: SessionRef;
  retryable: boolean;
  rawCode?: string;
  sanitizedDiagnostics?: unknown;
  /** Provider-reported usage for a failed attempt or local output rejection. Absent when unknown. */
  observedUsage?: Usage;
  failure?: Readonly<FailureClassification>;
}

export type RuntimeErrorCode =
  | 'EXECUTION_HALTED'
  | 'ADMISSION_REFUSED'
  | 'CLI_NOT_INSTALLED'
  | 'NOT_AUTHENTICATED'
  | 'UNEXPECTED_AUTH_SOURCE'
  | 'UNSUPPORTED_CLI_VERSION'
  | 'UNKNOWN_PROVIDER'
  | 'UNKNOWN_MODEL'
  | 'AMBIGUOUS_MODEL'
  | 'MODEL_PROVIDER_MISMATCH'
  | 'MODEL_UNAVAILABLE_FOR_AUTH'
  | 'UNSUPPORTED_CAPABILITY'
  | 'REQUIRED_TRANSPORT_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_MISMATCH'
  | 'SESSION_BUSY'
  | 'SESSION_INTERRUPTED'
  | 'PROTOCOL_ERROR'
  | 'STRUCTURED_OUTPUT_ERROR'
  | 'APPROVAL_REQUIRED'
  | 'INTERACTION_EXPIRED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'OUTPUT_LIMIT'
  | 'USAGE_LIMIT'
  | 'UNTRUSTED_WORKSPACE'
  | 'PROVIDER_UNAVAILABLE';

export class AgentRuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly context: Readonly<ErrorContext>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    context: ErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });
  }
}

type ContextInput = ErrorContext;

export class CliNotInstalledError extends AgentRuntimeError {
  constructor(provider: ProviderId, context: ContextInput) {
    super('CLI_NOT_INSTALLED', `${provider} CLI is not installed or not executable`, {
      ...context,
      provider,
    });
  }
}

export class NotAuthenticatedError extends AgentRuntimeError {
  constructor(provider: ProviderId, context: ContextInput) {
    super('NOT_AUTHENTICATED', `${provider} CLI is not authenticated`, { ...context, provider });
  }
}

export class UnexpectedAuthSourceError extends AgentRuntimeError {
  constructor(provider: ProviderId, context: ContextInput) {
    super('UNEXPECTED_AUTH_SOURCE', `${provider} is using an unexpected authentication source`, {
      ...context,
      provider,
    });
  }
}

export class UnsupportedCliVersionError extends AgentRuntimeError {
  constructor(provider: ProviderId, version: string, context: ContextInput) {
    super('UNSUPPORTED_CLI_VERSION', `Unsupported ${provider} CLI version: ${version}`, {
      ...context,
      provider,
      cliVersion: version,
    });
  }
}

export class UnknownModelError extends AgentRuntimeError {
  readonly requested: string;
  readonly suggestions: string[];

  constructor(
    requested: string,
    suggestions: string[] = [],
    context: ContextInput = { retryable: false },
  ) {
    super(
      'UNKNOWN_MODEL',
      `Unknown model "${requested}"${suggestions.length ? `; try ${suggestions.join(', ')}` : ''}`,
      context,
    );
    this.requested = requested;
    this.suggestions = suggestions;
  }
}

export class AmbiguousModelError extends AgentRuntimeError {
  readonly requested: string;
  readonly providers: ProviderId[];

  constructor(requested: string, providers: ProviderId[]) {
    super(
      'AMBIGUOUS_MODEL',
      `Model alias "${requested}" is ambiguous; use ${providers.map((p) => `${p}/${requested}`).join(' or ')}`,
      { retryable: false },
    );
    this.requested = requested;
    this.providers = providers;
  }
}

export class ModelProviderMismatchError extends AgentRuntimeError {
  constructor(requested: string, provider: ProviderId, inferred: ProviderId) {
    super(
      'MODEL_PROVIDER_MISMATCH',
      `Model "${requested}" belongs to ${inferred}, not ${provider}`,
      { retryable: false, provider },
    );
  }
}

export class ModelUnavailableForAuthError extends AgentRuntimeError {
  constructor(provider: ProviderId, model: string, context: ContextInput) {
    super('MODEL_UNAVAILABLE_FOR_AUTH', `Model "${model}" is unavailable for the active ${provider} authentication`, {
      ...context,
      provider,
    });
  }
}

function simpleError(
  code: RuntimeErrorCode,
  defaultMessage: string,
): new (context: ContextInput, message?: string) => AgentRuntimeError {
  return class extends AgentRuntimeError {
    constructor(context: ContextInput, message = defaultMessage) {
      super(code, message, context);
      this.name = defaultMessage.replace(/\s+/g, '');
    }
  };
}

export const UnsupportedCapabilityError = simpleError('UNSUPPORTED_CAPABILITY', 'Unsupported capability');
/**
 * The Agent was given pinned constraints, but this turn has no verified channel to deliver them
 * on. Nothing ran. `reason` says why; `allowUnpinned` on the option runs such turns anyway.
 */
export class PinnedGuaranteeUnavailableError extends UnsupportedCapabilityError {
  readonly reason: string;
  constructor(context: ContextInput, reason: string) {
    super(context, `The pinned constraints cannot be guaranteed for this turn: ${reason}`);
    this.name = 'PinnedGuaranteeUnavailableError';
    this.reason = reason;
  }
}
export const RequiredTransportUnavailableError = simpleError('REQUIRED_TRANSPORT_UNAVAILABLE', 'Required transport unavailable');
export const SessionNotFoundError = simpleError('SESSION_NOT_FOUND', 'Session not found');
export const SessionMismatchError = simpleError('SESSION_MISMATCH', 'Session does not match this agent');
export const SessionBusyError = simpleError('SESSION_BUSY', 'Session is busy');
export const SessionInterruptedError = simpleError('SESSION_INTERRUPTED', 'Session was interrupted');
export const ProtocolError = simpleError('PROTOCOL_ERROR', 'Provider protocol error');
export const StructuredOutputError = simpleError('STRUCTURED_OUTPUT_ERROR', 'Structured output validation failed');
export const ApprovalRequiredError = simpleError('APPROVAL_REQUIRED', 'Approval handler required');
export const InteractionExpiredError = simpleError('INTERACTION_EXPIRED', 'Interaction expired');
export const TimeoutError = simpleError('TIMEOUT', 'Turn timed out');
export const AbortError = simpleError('ABORTED', 'Turn aborted');
export const OutputLimitError = simpleError('OUTPUT_LIMIT', 'Provider output exceeded the configured limit');
export const UsageLimitError = simpleError('USAGE_LIMIT', 'Provider usage limit reached');

/** Reads one nominal provider rejection; no prose, coercion, cause traversal or scheduling. */
export function observedUsageLimitReset(error: unknown, provider: string, nowMs = Date.now()): number | undefined {
  if (typeof provider !== 'string' || !Number.isSafeInteger(nowMs) || nowMs < 0
    || !types.isNativeError(error) || types.isProxy(error)) return undefined;
  let cursor: object | null = error, nominal = false;
  for (let depth = 0; cursor && depth < 16; depth++) {
    if (types.isProxy(cursor)) return undefined;
    if (cursor === UsageLimitError.prototype) { nominal = true; break; }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  if (!nominal) return undefined;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  if (!code || !('value' in code) || code.value !== 'USAGE_LIMIT') return undefined;
  const data = (value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined => {
    if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  };
  const descriptor = Object.getOwnPropertyDescriptor(error, 'context');
  const context = descriptor && 'value' in descriptor ? data(descriptor.value,
    ['provider', 'transport', 'cliVersion', 'session', 'retryable', 'rawCode', 'sanitizedDiagnostics', 'observedUsage', 'failure']) : undefined;
  if (!context || context.provider !== provider || typeof context.retryable !== 'boolean') return undefined;
  const failure = data(context.failure, ['kind', 'reason', 'retryAt']);
  if (!failure || failure.kind !== 'usage-limit' || (failure.reason !== undefined
    && !['request-rejected', 'provider-overloaded', 'transport', 'execution-limit', 'unknown'].includes(failure.reason as string))) return undefined;
  const at = failure.retryAt;
  return typeof at === 'number' && Number.isSafeInteger(at) && at > nowMs
    && Number.isFinite(new Date(at).getTime()) ? at : undefined;
}
export const UntrustedWorkspaceError = simpleError('UNTRUSTED_WORKSPACE', 'Workspace is not trusted');
export const ProviderUnavailableError = simpleError('PROVIDER_UNAVAILABLE', 'Provider unavailable');

export class UnknownProviderError extends AgentRuntimeError {
  constructor(provider: ProviderId) {
    super('UNKNOWN_PROVIDER', `No provider registered for ${provider}`, { provider, retryable: false });
  }
}

export type AdmissionRefusalReason = 'concurrency-limit' | 'hourly-limit' | 'daily-limit' | 'quota-cooldown' | 'wait-timeout';
/** Closed admission classification only. Its fields grant no retry, fallback, lease or release permission. */
export class AdmissionRefusedError extends AgentRuntimeError {
  readonly provider: ProviderId;
  readonly reason: AdmissionRefusalReason;
  readonly receiptDigest: string;
  constructor(provider:ProviderId,input:{readonly reason:AdmissionRefusalReason;readonly receiptDigest:string}) {
    if(typeof provider!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(provider)||!input||typeof input!=='object'||types.isProxy(input)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new TypeError('Invalid admission refusal');
    const keys=Reflect.ownKeys(input),reason=Object.getOwnPropertyDescriptor(input,'reason'),receipt=Object.getOwnPropertyDescriptor(input,'receiptDigest');
    if(keys.length!==2||keys.some(key=>key!=='reason'&&key!=='receiptDigest')||!reason||!receipt||!Object.hasOwn(reason,'value')||!Object.hasOwn(receipt,'value')
      ||!['concurrency-limit','hourly-limit','daily-limit','quota-cooldown','wait-timeout'].includes(reason.value)
      ||typeof receipt.value!=='string'||!/^[a-f0-9]{64}$/.test(receipt.value))throw new TypeError('Invalid admission refusal');
    super('ADMISSION_REFUSED','Host admission refused',{provider,transport:'exec',retryable:false,sanitizedDiagnostics:{receiptDigest:receipt.value}});
    this.provider=provider;this.reason=reason.value as AdmissionRefusalReason;this.receiptDigest=receipt.value;
    Object.defineProperties(this,{provider:{writable:false},reason:{writable:false},receiptDigest:{writable:false}});
  }
}
