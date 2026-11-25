import type { ProtocolFailure } from '../adapters/provider.js';

/** Native prose is classification input, never a public diagnostic template. */
const MESSAGES: Readonly<Record<ProtocolFailure['kind'], string>> = Object.freeze({
  'not-authenticated': 'Provider CLI is not authenticated',
  'unknown-model': 'Unknown model',
  'model-unavailable': 'Model is unavailable for the active authentication',
  'usage-limit': 'Provider usage limit reached',
  'untrusted-workspace': 'Run inside a trusted workspace or configure the provider workspace policy',
  'session-not-found': 'Provider session was not found',
  'provider-unavailable': 'Provider is unavailable',
  protocol: 'Provider protocol error',
});

// A syntax check cannot distinguish an arbitrary secret from a machine code.
// Unknown provider codes stay in the explicitly retained native transcript.
const CODES = new Set([
  'api_error', 'error_during_execution', 'error_max_turns',
  'error_max_budget_usd', 'error_max_structured_output_retries',
  '401', '429', '41', 'UNAUTHENTICATED', 'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_ERROR', 'AUTH_ERROR', 'LOGIN_REQUIRED', 'RESOURCE_EXHAUSTED',
  'QUOTA_EXCEEDED', 'RATE_LIMIT', 'RATE_LIMITED', 'MODEL_NOT_FOUND',
  'UNKNOWN_MODEL', 'MODEL_UNAVAILABLE', 'MODEL_CAPACITY', 'INTERNAL', 'UNSUPPORTED_CLIENT',
  ...Array.from({ length: 256 }, (_, code) => `EXIT_${code}`),
]);
const REASONS = new Set(['request-rejected', 'provider-overloaded', 'transport', 'execution-limit', 'unknown']);

export function projectFailure(failure: ProtocolFailure) {
  const validKind = typeof failure.kind === 'string' && Object.hasOwn(MESSAGES, failure.kind);
  const kind: ProtocolFailure['kind'] = validKind ? failure.kind : 'protocol';
  const rawRetryAt = Object.getOwnPropertyDescriptor(failure, 'retryAt');
  const reset = rawRetryAt && 'value' in rawRetryAt ? rawRetryAt.value : undefined;
  const retryAt = kind === 'usage-limit' && Number.isSafeInteger(reset)
    && reset > Date.now() && Number.isFinite(new Date(reset).getTime()) ? reset as number : undefined;
  return {
    message: MESSAGES[kind],
    diagnostics: Object.freeze({ kind }),
    failure: Object.freeze({ kind,
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(validKind && typeof failure.reason === 'string' && REASONS.has(failure.reason) ? { reason: failure.reason } : {}) }),
    ...(typeof failure.rawCode === 'string' && CODES.has(failure.rawCode) ? { rawCode: failure.rawCode } : {}),
  };
}
