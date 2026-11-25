import type { AgentEvent, SessionRef, Turn, TurnOptions } from '../../public/types.js';

/** Accepts an Agent, Session or an application-owned stream starter. */
export interface ObservedTaskStarter<Input = string> {
  stream(input: Input, options: TurnOptions): AsyncIterable<AgentEvent>;
}

export interface ObservedTaskHandle {
  interrupt(): Promise<{ requested: boolean }>;
}

/** Adapt SharedLaunchBudget or an app's admission service without coupling persistence. */
export interface ObservedTaskBudget {
  acquire(signal: AbortSignal): { release(): void | Promise<void> } | Promise<{ release(): void | Promise<void> }>;
}

export interface ObservedTaskHooks {
  idleTimeoutMs?: number;
  budget?: ObservedTaskBudget;
  onHandle?: (handle: ObservedTaskHandle) => void;
  onProgress?: (kind: string) => void;
  onSession?: (session: SessionRef) => void;
}

/** Provider errors retain their original identity; these codes describe observer failures only. */
export class ObservedTaskError extends Error {
  constructor(readonly code: 'IDLE_TIMEOUT' | 'MISSING_RESULT' | 'CANCELLED', message: string) {
    super(message); this.name = 'ObservedTaskError';
  }
}

/**
 * Observe a single streamed turn. Cancellation is cooperative: this promise and
 * its launch reservation remain active until the iterator and its cleanup settle.
 * The starter must faithfully retain actual native work: SDK exec callers should
 * pass awaitSettlement: true. Default SDK bounded cleanup cannot provide that
 * guarantee. An uncooperative provider can keep the opted-in promise pending after abort.
 */
export async function runObservedTask<Input>(
  starter: ObservedTaskStarter<Input>, input: Input, options: TurnOptions = {}, hooks: ObservedTaskHooks = {},
): Promise<Turn> {
  options = { ...options }; hooks = { ...hooks };
  if (options.signalBehavior === 'detach') throw new Error('Observed tasks cannot detach active provider work');
  const timeout = hooks.idleTimeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2 ** 31 - 1)) {
    throw new RangeError('idleTimeoutMs must be an integer in 1..2^31-1');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const cancelled = () => { throw new ObservedTaskError('CANCELLED', 'Task cancelled'); };
  if (options.signal?.aborted) cancelled();
  options.signal?.addEventListener('abort', abort, { once: true });
  let reservation: Awaited<ReturnType<ObservedTaskBudget['acquire']>> | undefined;
  let failure: { error: unknown } | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stalled = false, awaitingHuman = 0, finished = false;
  const interactions = new Set<Promise<unknown>>();
  const disarm = () => { if (idle !== undefined) clearTimeout(idle); idle = undefined; };
  const arm = () => {
    disarm();
    if (finished || timeout === undefined || awaitingHuman > 0 || controller.signal.aborted) return;
    idle = setTimeout(() => { stalled = true; controller.abort(); }, timeout);
    idle.unref?.();
  };
  const live: ObservedTaskHandle = {
    async interrupt() { controller.abort(); return { requested: true }; },
  };
  const interaction = options.onInteraction;
  const bridged = interaction === undefined ? undefined : (request: Parameters<typeof interaction>[0]) => {
    if (finished) return Promise.reject(new ObservedTaskError('CANCELLED', 'Task already ended'));
    const work = (async () => {
      awaitingHuman++; disarm();
      try { hooks.onProgress?.('interaction'); return await interaction(request); }
      finally { awaitingHuman--; arm(); }
    })();
    interactions.add(work);
    void work.then(() => interactions.delete(work), () => interactions.delete(work));
    return work;
  };
  try {
    hooks.onHandle?.(live);
    if (controller.signal.aborted) cancelled();
    if (hooks.budget !== undefined) reservation = await hooks.budget.acquire(controller.signal);
    if (controller.signal.aborted) cancelled();
    arm();
    let turn: Turn | undefined;
    const events = starter.stream(input, {
      ...options, signal: controller.signal,
      ...(bridged === undefined ? {} : { onInteraction: bridged }),
    });
    try {
      for await (const event of events) {
        arm();
        if (event.type === 'session.started') hooks.onSession?.(event.session);
        else if (event.type === 'turn.started') hooks.onProgress?.('started');
        else if (event.type === 'message.delta') hooks.onProgress?.('delta');
        else if (event.type === 'tool.started') hooks.onProgress?.(`tool:${event.name}`);
        else if (event.type === 'provider.event') hooks.onProgress?.('provider');
        else if (event.type === 'turn.completed') turn = event.turn;
      }
    } catch (error) {
      if (stalled) throw new ObservedTaskError('IDLE_TIMEOUT', 'Task exceeded its idle timeout');
      throw error;
    }
    if (stalled) throw new ObservedTaskError('IDLE_TIMEOUT', 'Task exceeded its idle timeout');
    if (controller.signal.aborted) cancelled();
    if (turn === undefined) throw new ObservedTaskError('MISSING_RESULT', 'Task ended without a result');
    return turn;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    finished = true; disarm();
    await Promise.allSettled([...interactions]);
    options.signal?.removeEventListener('abort', abort);
    try { await reservation?.release(); }
    catch (error) {
      if (failure !== undefined) throw new AggregateError([failure.error, error], 'Task failed and its launch reservation could not be released');
      throw error;
    }
  }
}
