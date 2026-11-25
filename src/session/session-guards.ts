import {
  AbortError,
  AgentRuntimeError,
  SessionBusyError,
  SessionInterruptedError,
  SessionMismatchError,
  TimeoutError,
} from '../public/errors.js';
import type { SessionIdentity, SessionState } from '../public/types.js';
import type { SessionConfig } from './config.js';

/** Why a new turn may not take a session in `state`; undefined when it may. */
export function acquireError(config: SessionConfig, state: SessionState, ref: SessionIdentity | undefined): Error | undefined {
  if (state === 'running') {
    return new SessionBusyError({
      provider: config.adapter.id,
      transport: config.transport,
      retryable: true,
      ...(ref === undefined ? {} : { session: ref }),
    });
  }
  if (state === 'closed' || state === 'closing') {
    return new SessionMismatchError(
      { provider: config.adapter.id, transport: config.transport, retryable: false },
      'Session is closed',
    );
  }
  if (state === 'interrupted' || state === 'unknown' || state === 'failed') {
    return new SessionInterruptedError(
      {
        provider: config.adapter.id,
        transport: config.transport,
        retryable: state !== 'failed',
        ...(ref === undefined ? {} : { session: ref }),
      },
      `Session is ${state}; reconcile or replace it before starting another turn`,
    );
  }
  return undefined;
}

/** A turn that ended by cancellation or deadline, not by a provider failure. */
export function interruptedBy(error: unknown): boolean {
  return error instanceof AbortError
    || error instanceof AgentRuntimeError && error.code === 'TIMEOUT';
}

/**
 * What a turn cancelled before anything ran rejects with: the error its transport gives an abort
 * (or a passed deadline) that arrives before the CLI starts, so callers see one error either way.
 */
export function cancelledBeforeRun(config: SessionConfig, reason: unknown): Error {
  const deadline = reason instanceof TimeoutError;
  if (config.transport === 'control') {
    const context = { provider: config.adapter.id, transport: 'control' as const, retryable: true };
    return deadline ? new TimeoutError(context, 'Control operation deadline exceeded') : new AbortError(context, 'Control turn aborted');
  }
  const context = { retryable: true, provider: config.adapter.id, transport: config.transport };
  return deadline ? new TimeoutError(context, 'Operation deadline exceeded') : new AbortError(context, 'Operation aborted');
}
