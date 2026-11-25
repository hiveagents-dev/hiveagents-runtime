/**
 * Small helpers shared by the curator and the ablation suite: bounded options,
 * deadlines that compose with a caller's signal, and error labels that carry a
 * code or a class name but never a message (a message can echo stored text).
 */

/** Control, format and line-separator characters, which a store refuses in names. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Node timers clamp anything above this to 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A name a store accepts: nonblank, at most 128 characters, no edge whitespace, nothing unprintable. */
export function isStoreName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 128 && value.trim() === value
    && !UNPRINTABLE.test(value);
}

export function storeName(value: unknown, name: string): string {
  if (!isStoreName(value)) throw new TypeError(`${name} must be a nonblank printable name of at most 128 characters`);
  return value;
}

export function boundedInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

export function optionalSignal(value: unknown): AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  return value as AbortSignal | undefined;
}

/**
 * A short label for a failure: a typed store error's `code` (`DISABLED`, `CONFLICT`, ...) or the
 * error's class name. Never its message, which may quote stored text or model output.
 */
export function errorLabel(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && CLASS_NAME.test(name)) return name;
  }
  return 'Error';
}

export type StopReason = 'aborted' | 'deadline';

/** A signal that aborts when the caller's does or when `ms` passes; `dispose` clears the timer. */
export interface Deadline {
  readonly signal: AbortSignal;
  /** Why the signal aborted, or undefined while it has not. */
  stopped(): StopReason | undefined;
  dispose(): void;
}

export function deadline(outer: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  let reason: StopReason | undefined;
  const stop = (why: StopReason, cause: unknown) => {
    if (controller.signal.aborted) return;
    reason = why;
    controller.abort(cause);
  };
  const onAbort = () => stop('aborted', outer!.reason);
  if (outer?.aborted) onAbort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('deadline', new DOMException('The deadline passed', 'TimeoutError')), ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    stopped: () => reason,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** Settles with `work`, or rejects with the signal's reason as soon as it aborts, even when `work` ignores it. */
export function abortable<T>(work: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
