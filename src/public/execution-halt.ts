import { types } from 'node:util';
import { AgentRuntimeError, type ErrorContext } from './errors.js';

const halts = new WeakSet<object>();
/** A failed infrastructure boundary must stop execution, selection and dependent retries. */
export class ExecutionHaltedError extends AgentRuntimeError {
  constructor(context: Omit<ErrorContext, 'retryable'> = {}, options?: ErrorOptions) {
    super('EXECUTION_HALTED', 'Execution halted', { ...context, retryable: false }, options);
    halts.add(this);
  }
}
const MAX_NODES = 64, MAX_DEPTH = 16;
type HaltState = 'clear' | 'halted' | 'uninspectable';
function inspect(error: unknown): HaltState {
  const pending = [{ value: error, depth: 0 }], seen = new Set<object>();
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object' || types.isProxy(value)) continue;
    if (halts.has(value)) return 'halted';
    if (!types.isNativeError(value) || seen.has(value)) continue;
    if (seen.size >= MAX_NODES || depth >= MAX_DEPTH) return 'uninspectable';
    seen.add(value);
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && Object.hasOwn(cause, 'value')) pending.push({ value: cause.value, depth: depth + 1 });
    const descriptor = Object.getOwnPropertyDescriptor(value, 'errors');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || types.isProxy(descriptor.value) || !Array.isArray(descriptor.value)) continue;
    const errors = descriptor.value as unknown[];
    if (errors.length > MAX_NODES || pending.length + errors.length > MAX_NODES) return 'uninspectable';
    for (let i = 0; i < errors.length; i++) {
      const item = Object.getOwnPropertyDescriptor(errors, String(i));
      if (item && Object.hasOwn(item, 'value')) pending.push({ value: item.value, depth: depth + 1 });
    }
  }
  return 'clear';
}
/** Genuine nominal errors only; oversized native error graphs are conservatively halting. */
export function isExecutionHalted(error: unknown): boolean { return inspect(error) !== 'clear'; }
/** Preserve the original outer aggregate/cause, without invoking provider getters or proxy traps. */
export function rethrowExecutionHalt(error: unknown): void {
  const state = inspect(error);
  if (state === 'halted') throw error;
  if (state === 'uninspectable') throw new ExecutionHaltedError({ sanitizedDiagnostics: { reason: 'ERROR_GRAPH_LIMIT' } }, { cause: error });
}
