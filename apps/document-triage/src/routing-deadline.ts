import { performance } from 'node:perf_hooks';
import { TimeoutError } from 'hiveagents-runtime';

/** The timer requests cancellation; the synchronous boundary check enforces expiry. */
export function routingDeadline(timeoutMs: number, parent?: AbortSignal) {
  const deadline = performance.now() + timeoutMs, controller = new AbortController();
  const expire = () => controller.abort(new TimeoutError({ retryable: true }, 'Routing application deadline exceeded'));
  const timer = setTimeout(expire, timeoutMs);
  const signal = parent === undefined ? controller.signal : AbortSignal.any([controller.signal, parent]);
  return {
    signal,
    remaining() {
      const milliseconds = deadline - performance.now();
      if (milliseconds < 1 && !signal.aborted) expire();
      signal.throwIfAborted();
      return Math.floor(milliseconds);
    },
    dispose() { clearTimeout(timer); },
  };
}
