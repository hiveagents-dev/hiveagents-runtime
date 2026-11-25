/**
 * Dynamic workflows: the closed error of agent runners.
 *
 * Shared by the bundled `agentRunner` (which throws it) and the engine (which reports its closed code and
 * counts its usage). Type-only imports: loading this module never loads the runtime.
 */
import type { RuntimeErrorCode } from '../../public/errors.js';
import type { Usage } from '../../public/types.js';

export type DynamicRunnerErrorCode =
  /** The request named a model outside the allowlist. Nothing ran. */
  | 'MODEL_NOT_ALLOWED'
  /** The request asked for permissions above the runner's ceiling. Nothing ran. */
  | 'PERMISSION_DENIED'
  /** The request was malformed (prompt, cwd, effort, timeout). Nothing ran. */
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'ABORTED'
  /** The turn ended with a native provider refusal. */
  | 'REFUSED'
  /** The provider or transport cannot run this request (unknown model, missing capability, unenforceable policy). */
  | 'UNSUPPORTED'
  /** The provider's structured output was missing or not JSON. The engine re-asks it like a schema mismatch. */
  | 'OUTPUT_INVALID'
  /**
   * The provider rate-limited or usage-limited the turn (the SDK's `USAGE_LIMIT`). The engine shrinks the
   * run's concurrency window and retries the call after a backoff, up to `DynamicLimits.rateLimitRetries`.
   */
  | 'RATE_LIMITED'
  | 'PROVIDER_FAILED';

const MESSAGES: Readonly<Record<DynamicRunnerErrorCode, string>> = Object.freeze({
  MODEL_NOT_ALLOWED: 'The requested model is not allowed for this workflow',
  PERMISSION_DENIED: 'The requested permissions exceed the workflow ceiling',
  INVALID_REQUEST: 'The agent request is invalid',
  TIMEOUT: 'The agent turn timed out',
  ABORTED: 'The agent turn was aborted',
  REFUSED: 'The provider refused the agent turn',
  UNSUPPORTED: 'The provider cannot run this agent turn',
  OUTPUT_INVALID: 'The agent turn returned invalid structured output',
  RATE_LIMITED: 'The provider rate-limited the agent turn',
  PROVIDER_FAILED: 'The agent turn failed',
});

const RUNTIME_CODE = /^[A-Z][A-Z_]{0,63}$/;

/** True for one of the closed `DynamicRunnerErrorCode`s. */
export function isDynamicRunnerErrorCode(value: unknown): value is DynamicRunnerErrorCode {
  return typeof value === 'string' && Object.hasOwn(MESSAGES, value);
}

/** The fixed SDK message of a code, plus the SDK runtime code when it is well-formed: never free text. */
export function dynamicRunnerMessage(code: DynamicRunnerErrorCode, runtimeCode?: unknown): string {
  return `${MESSAGES[code]}${typeof runtimeCode === 'string' && RUNTIME_CODE.test(runtimeCode) ? ` (${runtimeCode})` : ''}`;
}

/**
 * Message: fixed per code, plus the SDK runtime code when there is one; `cause` keeps the original for the
 * application's own diagnostics. `usage` is what the failed turn spent as the provider reported it (a
 * rejected structured output, a refusal, a provider failure): the engine counts it against the run budget.
 * `retryAt` (RATE_LIMITED only) is the provider-reported reset in epoch milliseconds, when the SDK confirmed
 * one: the engine waits at least until then before retrying, or fails the call when it is too far away.
 */
export class DynamicRunnerError extends Error {
  readonly code: DynamicRunnerErrorCode;
  /** The SDK's closed `AgentRuntimeError` code that led here, when any. */
  readonly runtimeCode?: RuntimeErrorCode;
  /** Provider-reported usage of the failed turn, when known. */
  readonly usage?: Usage;
  /** RATE_LIMITED only: the provider-reported reset (epoch ms), when known. */
  readonly retryAt?: number;

  constructor(code: DynamicRunnerErrorCode, options: {
    runtimeCode?: RuntimeErrorCode; detail?: string; cause?: unknown; usage?: Usage; retryAt?: number;
  } = {}) {
    const suffix = options.runtimeCode ? ` (${options.runtimeCode})` : options.detail ? `: ${options.detail}` : '';
    super(`${MESSAGES[code]}${suffix}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DynamicRunnerError';
    this.code = code;
    if (options.runtimeCode) this.runtimeCode = options.runtimeCode;
    if (options.usage !== undefined) this.usage = options.usage;
    if (code === 'RATE_LIMITED' && Number.isSafeInteger(options.retryAt) && options.retryAt! > 0) this.retryAt = options.retryAt!;
  }
}
