import { UnsupportedCapabilityError } from '../public/errors.js';
import type { AgentEvent, AgentInput, Turn, TurnHandle, TurnOptions } from '../public/types.js';
import { recallShare, type MemoryTurnContext, type MemoryTurns, type RecalledTurn } from './memory.js';

/** What every memory wrapper needs: the Agent's memory, where the turn runs, and how a cancelled recall ends. */
export interface MemoryCall {
  readonly memory: MemoryTurns;
  readonly context: MemoryTurnContext;
  /** Control transports that negotiated steering keep `steer` on the deferred handle. */
  readonly steering: boolean;
  /** The error a turn cancelled during recall rejects with: what its transport gives an abort before anything ran. */
  cancelled(reason: unknown): Error;
}

/**
 * What a Session lends the memory wrappers for one turn. Recall is asynchronous, so the session
 * is held while it runs: `hold` makes, synchronously and before any recall, every refusal the
 * turn without memory makes before it runs, then takes the session; `release` gives it back
 * right before the real turn takes it again.
 */
export interface MemoryHost extends MemoryCall {
  /** The session whose `close()` waits for the capture this turn may schedule. */
  readonly owner: object;
  hold(): void;
  release(): void;
}

export type TurnRun<T> = (input: AgentInput, options: TurnOptions, recalled?: RecalledTurn) => T;
export type MemoryWrap<T> = (host: MemoryHost, input: AgentInput, options: TurnOptions, run: TurnRun<T>) => T;

interface Begun { recalled: RecalledTurn; handle: TurnHandle }

/**
 * Recalls within a share of the turn's own deadline, then hands the turn the same signal and
 * the rest of that deadline. A turn cancelled while recall ran never runs: this rejects with
 * the transport's own pre-start abort error. A turn cancelled before recall runs as it would
 * without memory, so its refusal is the one it always had.
 */
async function recallFor(host: MemoryCall, input: AgentInput, options: TurnOptions, signal: AbortSignal | undefined) {
  const preAborted = signal?.aborted === true;
  const started = performance.now();
  const recalled = await host.memory.recall(input, host.context, signal, recallShare(options.timeoutMs));
  if (!preAborted && signal?.aborted) throw host.cancelled(signal.reason);
  const spent = Math.ceil(performance.now() - started);
  const turnOptions: TurnOptions = {
    ...options,
    ...(signal === undefined ? {} : { signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: Math.max(1, options.timeoutMs - spent) }),
  };
  return { recalled, options: turnOptions };
}

function finished(recalled: RecalledTurn, event: AgentEvent, owner: object): AgentEvent {
  if (event.type === 'turn.completed') recalled.finish(event.turn, owner);
  return event;
}

/** `send` and `runOneShot`: recall, run, schedule the capture. */
export async function remembered(host: MemoryHost, input: AgentInput, options: TurnOptions, run: TurnRun<Promise<Turn>>): Promise<Turn> {
  host.hold();
  let released = false;
  try {
    const { recalled, options: turnOptions } = await recallFor(host, input, options, options.signal);
    released = true;
    host.release();
    return recalled.finish(await run(recalled.input, turnOptions, recalled), host.owner);
  } finally { if (!released) host.release(); }
}

/** `stream`: holds on the first read, like the stream without memory acquires on its first read. */
export async function* rememberedStream(host: MemoryHost, input: AgentInput, options: TurnOptions, run: TurnRun<AsyncIterable<AgentEvent>>): AsyncGenerator<AgentEvent> {
  host.hold();
  let released = false;
  try {
    const { recalled, options: turnOptions } = await recallFor(host, input, options, options.signal);
    released = true;
    host.release();
    for await (const event of run(recalled.input, turnOptions, recalled)) yield finished(recalled, event, host.owner);
  } finally { if (!released) host.release(); }
}

/**
 * `start`: the handle is returned synchronously, after the same synchronous refusals as without
 * memory; the turn starts once recall settles. An interrupt that arrives during recall cancels
 * it: the turn never runs, the session is left idle, and the receipt says it was interrupted.
 * Once the turn runs, its own handle answers.
 */
export function rememberedHandle(host: MemoryHost, input: AgentInput, options: TurnOptions, run: TurnRun<TurnHandle>): TurnHandle {
  host.hold();
  const early = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, early.signal]) : early.signal;
  let begun: Begun | undefined;
  let cancelled = false;
  const nested = recallFor(host, input, options, signal).then(
    ({ recalled, options: turnOptions }) => {
      host.release();
      begun = { recalled, handle: run(recalled.input, turnOptions, recalled) };
      return begun;
    },
    (error: unknown) => { cancelled = true; host.release(); throw error; },
  );
  return composed(nested, host, host.owner, () => { if (!begun) early.abort(); }, () => cancelled);
}

/** An exec fork's first turn: recalled before the fork starts; its capture belongs to the child. */
export async function rememberedFork<T extends { session: object; turn: TurnHandle }>(
  host: MemoryCall, input: AgentInput, options: TurnOptions, run: (input: AgentInput, options: TurnOptions, recalled: RecalledTurn) => Promise<T>,
): Promise<T> {
  const { recalled, options: turnOptions } = await recallFor(host, input, options, options.signal);
  const forked = await run(recalled.input, turnOptions, recalled);
  return { ...forked, turn: composed(Promise.resolve({ recalled, handle: forked.turn }), host, forked.session) };
}

function composed(
  nested: Promise<Begun>, host: MemoryCall, owner: object, beforeInterrupt?: () => void, cancelled?: () => boolean,
): TurnHandle {
  const result = nested.then(async ({ recalled, handle }) => recalled.finish(await handle.result, owner));
  // Like the handles without memory: the failure is observed through result or events, once.
  void result.catch(() => undefined);
  const events = (async function* (): AsyncGenerator<AgentEvent> {
    const { recalled, handle } = await nested;
    for await (const event of handle.events) yield finished(recalled, event, owner);
  })();
  return {
    token: { value: crypto.randomUUID() },
    turnId: nested.then(({ handle }) => handle.turnId).catch(() => undefined),
    events,
    result,
    interrupt: async (reason) => {
      beforeInterrupt?.();
      let handle: TurnHandle;
      try { ({ handle } = await nested); } catch {
        // Cancelled during recall: nothing ran, so the turn's end is known.
        return cancelled?.() ? { requested: true, terminal: 'interrupted' } : { requested: false, terminal: 'failed' };
      }
      return handle.interrupt(reason);
    },
    detach: () => { void nested.then(({ handle }) => handle.detach(), () => undefined); },
    respond: async (interactionId, response) => (await nested).handle.respond(interactionId, response),
    ...(host.steering ? {
      steer: async (input: AgentInput) => {
        const { handle } = await nested;
        if (!handle.steer) {
          throw new UnsupportedCapabilityError({ provider: host.context.provider, transport: 'control', retryable: false }, 'This turn handle does not implement steering');
        }
        return handle.steer(input);
      },
    } : {}),
  };
}
