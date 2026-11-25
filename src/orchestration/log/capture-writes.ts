import { types } from 'node:util';
import { boundedInteger, invalidCapture } from './capture-codec.js';
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')!.get!;
export function captureWriteOptions(input: { maxWriteMs?: number; signal?: AbortSignal }) {
  const maxWriteMs = boundedInteger(input.maxWriteMs ?? 5000, 1, 30000), signal = input.signal;
  if (signal !== undefined) {
    if (types.isProxy(signal)) invalidCapture();
    try { Reflect.apply(aborted, signal, []); } catch { invalidCapture(); }
  }
  return { maxWriteMs, signal };
}
/** Abandoned writes remain observed/charged by the owner; cancellation is not a durable ACK. */
export function awaitCaptureWrite<T>(work: Promise<T>, maxWriteMs: number, signal: AbortSignal | undefined, halt: (cause: unknown) => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { if (timer) clearTimeout(timer); if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel); };
    const complete = (callback: () => void) => { if (settled) return; settled = true; clean(); callback(); };
    const cancel = () => complete(() => reject(halt(signal ? Reflect.apply(reason, signal, []) : Error('CAPTURE_WRITE_INTERRUPTED'))));
    work.then(value => complete(() => resolve(value)), error => complete(() => reject(error)));
    if (signal && Reflect.apply(aborted, signal, [])) { cancel(); return; }
    if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, { once: true });
    timer = setTimeout(() => complete(() => reject(halt(Error('CAPTURE_WRITE_TIMEOUT')))), maxWriteMs);
  });
}
