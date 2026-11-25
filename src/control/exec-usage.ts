import { AbortError, AgentRuntimeError, TimeoutError } from '../public/errors.js';
import type { TurnHandle, Usage } from '../public/types.js';
import type { AdapterStreamItem } from '../adapters/provider.js';
import type { OperationScope } from './operation-scope.js';
import { rethrowExecutionHalt } from '../public/execution-halt.js';

export const resultUsage = (value: { usage?: Usage }): Usage | undefined => value.usage;
export const streamStepUsage = (step: IteratorResult<AdapterStreamItem>): Usage | undefined =>
  !step.done && step.value.kind === 'result' ? step.value.result.usage : undefined;

/** A handle may have started work before its public creation race observed cancellation. */
export async function settledHandleUsage(handle: Pick<TurnHandle, 'result'>): Promise<Usage | undefined> {
  try { return (await handle.result).usage; }
  catch (error) { rethrowExecutionHalt(error); return error instanceof AgentRuntimeError ? error.context.observedUsage : undefined; }
}

/** Keep the scope's outcome; opted-in callers can retain accounting from the same actual work. */
export async function raceExecWork<T>(
  scope: OperationScope, work: () => Promise<T>, awaitSettlement: boolean | undefined,
  usageOf: (value: T) => Usage | undefined | Promise<Usage | undefined>,
): Promise<T> {
  let pending: Promise<T> | undefined;
  try {
    // Creating work outside this callback could launch inference after an aborted prerequisite.
    return await scope.race(() => { pending = Promise.resolve(work()); return pending; });
  } catch (primary) {
    rethrowExecutionHalt(primary);
    if (!awaitSettlement || !pending || !(primary instanceof AbortError || primary instanceof TimeoutError)) throw primary;
    const settled = await pending.then(value => ({ value }), error => ({ error }));
    if ('error' in settled) rethrowExecutionHalt(settled.error);
    let usage: Usage | undefined;
    try {
      usage = 'value' in settled ? await usageOf(settled.value)
        : settled.error instanceof AgentRuntimeError ? settled.error.context.observedUsage : undefined;
      if (usage === undefined) throw primary;
      usage = structuredClone(usage);
    } catch (error) { rethrowExecutionHalt(error); throw primary; }
    const context = { ...primary.context, observedUsage: usage };
    const message = primary.message;
    const enriched = primary instanceof TimeoutError
      ? new TimeoutError(context, message) : new AbortError(context, message);
    if (primary.stack !== undefined) enriched.stack = primary.stack;
    if (Object.hasOwn(primary, 'cause')) Object.defineProperty(enriched, 'cause', Object.getOwnPropertyDescriptor(primary, 'cause')!);
    throw enriched;
  }
}
