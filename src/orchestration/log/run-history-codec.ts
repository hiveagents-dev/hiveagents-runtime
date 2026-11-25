import { freeze, hash, object } from '../../shared/json.js';
import type { RunInterruptionReason } from './run-history-types.js';

export const RUN_HISTORY_SCHEMA = 'oar.system.run';
export interface RunMarker { readonly inputDigest: string; readonly outputDigest?: string; readonly reason?: RunInterruptionReason }
/** Closed metadata grammar; no outputs, exception prose or native diagnostics. */
export function decodeRunMarker(type: string, input: unknown): RunMarker {
  object(input, ['inputDigest', 'outputDigest', 'reason']); hash(input.inputDigest);
  if (type === 'run.started') { if (Object.keys(input).length !== 1) throw Error(); }
  else if (type === 'run.completed') {
    if (input.reason !== undefined || Object.hasOwn(input, 'reason')) throw Error();
    if (Object.hasOwn(input, 'outputDigest')) hash(input.outputDigest);
  } else if (type === 'run.interrupted') {
    if (Object.keys(input).length !== 2 || typeof input.reason !== 'string' || !['aborted', 'failed', 'stopped', 'halted'].includes(input.reason)) throw Error();
  } else throw Error();
  return freeze({ inputDigest: input.inputDigest, ...(input.outputDigest === undefined ? {} : { outputDigest: input.outputDigest as string }),
    ...(input.reason === undefined ? {} : { reason: input.reason as RunInterruptionReason }) });
}
export function capturePublicRunMarker(input: unknown): Readonly<Record<string, unknown>> {
  object(input, ['stage', 'inputDigest', 'outputDigest', 'reason']);
  if (typeof input.stage !== 'string') throw Error();
  const { stage, ...body } = input;
  return freeze({ stage, ...decodeRunMarker(`run.${stage}`, body) });
}
