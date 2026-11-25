import type { ValidateFunction } from 'ajv';

import { TurnEvents } from './turn-events.js';
import type { ProtocolResult } from '../adapters/provider.js';
import { ControlTurnLifecycle, settlesWithin, withinGrace } from './control-lifecycle.js';
import { AbortError, ProtocolError, TimeoutError, UnsupportedCapabilityError } from '../public/errors.js';
import type {
  AgentEvent,
  AgentInput,
  InteractionRequest,
  InteractionResponse,
  InterruptReceipt,
  ProviderId,
  Turn,
  TurnHandle,
  TurnOptions,
} from '../public/types.js';
import type {
  ControlSessionHandle,
  ControlTurnHandle,
  ControlTurnRequest,
} from './control-session.js';
import type { TurnProjection } from './turn-projection.js';
import type { RequiredTurnCapture } from './required-capture.js';

/** Everything a control turn needs from the owning `Session`. */
export interface ControlTurnHost extends TurnProjection {
  readonly capture?: RequiredTurnCapture;
  createCapture?(): RequiredTurnCapture | undefined;
  readonly provider: ProviderId;
  readonly control: ControlSessionHandle;
  ownsTurn(): boolean;
  /** Negotiated steering verdict; false hides `steer` from the turn handle entirely. */
  steering(): boolean;
  activate(turn: ControlTurnHandle | undefined): void;
  fail(error: unknown): void;
  release(): void;
  onInterrupt(receipt: InterruptReceipt): void;
  onCancellation(terminalKnown: boolean): void;
}

/**
 * Projects one control turn into runtime events and a `Turn`. The generator's
 * return value is the completed turn, so a streaming consumer and a buffering
 * one share a single implementation.
 */
async function* project(
  turn: ControlTurnHandle,
  host: ControlTurnHost,
  validate: ValidateFunction | undefined,
  lifecycle: ControlTurnLifecycle,
): AsyncGenerator<AgentEvent, Turn, void> {
  const events: AgentEvent[] = [];
  let result: ProtocolResult | undefined;
  const raw = turn.stream[Symbol.asyncIterator]();
  const tracked = { [Symbol.asyncIterator]() { return this; }, next() { const work = Promise.resolve().then(() => raw.next()); host.capture?.track(work); return work; },
    ...(raw.return ? { return() { const work = Promise.resolve().then(() => raw.return!()); host.capture?.track(work); return work; } } : {}) };
  for await (const item of tracked) {
    if (item.kind === 'session') {
      const started = host.adopt(item.sessionId);
      if (started) {
        events.push(started);
        await host.capture?.observe(started);
        yield started;
      }
    } else if (item.kind === 'event') {
      events.push(item.event);
      await host.capture?.observe(item.event);
      yield item.event;
    } else {
      result = item.result;
      lifecycle.markTerminal();
    }
  }
  if (!result) {
    throw new ProtocolError(
      { provider: host.provider, transport: 'control', retryable: false },
      'Control transport ended the turn without a terminal result',
    );
  }
  if (lifecycle.error) throw lifecycle.error;
  return host.complete(result, events, validate);
}

/**
 * Wraps the application's handler so an out-of-band `TurnHandle.respond` and
 * the handler itself cannot both settle one interaction. The broker is
 * exactly-once: whoever settles first wins, and the loser simply never returns
 * rather than raising "already resolved" inside the adapter.
 */
function guardedHandler(
  handler: NonNullable<TurnOptions['onInteraction']>,
  settled: Set<string>,
): (request: InteractionRequest) => Promise<InteractionResponse> {
  return async (request) => {
    const response = await handler(request);
    const id = request.binding.interactionId;
    if (settled.has(id)) return new Promise<never>(() => {});
    settled.add(id);
    return response;
  };
}

function turnRequest(
  input: AgentInput,
  options: TurnOptions,
  settled: Set<string>,
  signal: AbortSignal,
): ControlTurnRequest {
  return {
    input,
    signal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.onInteraction === undefined
      ? {}
      : { onInteraction: guardedHandler(options.onInteraction, settled) }),
  };
}

function handle(
  host: ControlTurnHost,
  started: Promise<ControlTurnHandle>,
  result: Promise<Turn>,
  events: AsyncIterable<AgentEvent>,
  settled: Set<string>,
  interrupt: (reason?: string) => Promise<InterruptReceipt>,
): TurnHandle {
  let terminal: InterruptReceipt['terminal'] = 'unknown';
  void result.then((turn) => {
    terminal = turn.status === 'interrupted' ? 'interrupted'
      : turn.status === 'failed' ? 'failed' : 'completed';
  }, () => undefined);
  const requireOwner = () => {
    if (!host.ownsTurn()) {
      throw new ProtocolError(
        { provider: host.provider, transport: 'control', retryable: false },
        'This turn no longer owns the session',
      );
    }
  };
  const steer = host.steering()
    ? async (input: AgentInput) => {
        requireOwner();
        const turn = await started;
        requireOwner();
        if (!turn.steer) {
          throw new UnsupportedCapabilityError(
            { provider: host.provider, transport: 'control', retryable: false },
            'This control session negotiated steering but its turn handle does not implement it',
          );
        }
        return turn.steer(input);
      }
    : undefined;
  return {
    token: { value: crypto.randomUUID() },
    turnId: result.then((turn) => turn.id, () => undefined),
    events,
    result,
    interrupt: async (reason) => {
      if (!host.ownsTurn()) return { requested: false, terminal };
      const receipt = await interrupt(reason);
      terminal = receipt.terminal;
      host.onInterrupt(receipt);
      return receipt;
    },
    detach: () => undefined,
    respond: async (interactionId, response) => {
      requireOwner();
      // Mark settled only once the broker accepted the response: a refused
      // decision leaves the interaction pending, and the handler's own answer
      // must still be allowed to settle it.
      await host.control.respond(interactionId, response);
      settled.add(interactionId);
    },
    ...(steer === undefined ? {} : { steer }),
  };
}

async function collect(
  host: ControlTurnHost,
  started: Promise<ControlTurnHandle>,
  publish: (event: AgentEvent) => void,
  validate: ValidateFunction | undefined,
  lifecycle: ControlTurnLifecycle,
): Promise<Turn> {
  try {
    const turn = await started;
    if (!lifecycle.error) host.activate(turn);
    const iterator = project(turn, host, validate, lifecycle);
    for (;;) {
      const step = await iterator.next();
      if (step.done) return host.capture ? host.capture.completeTurn(step.value) : step.value;
      publish(step.value);
    }
  } catch (error) {
    host.fail(error);
    if (host.capture) await host.capture.fail(error);
    throw error;
  }
}

export function runControlTurn(
  host: ControlTurnHost,
  input: AgentInput,
  options: TurnOptions,
  validate: ValidateFunction | undefined,
): { handle: TurnHandle; result: Promise<Turn> } {
  let lifecycle!: ControlTurnLifecycle;
  try {
    lifecycle = new ControlTurnLifecycle(host.provider, options);
    const capture = !lifecycle.error ? host.createCapture?.() : undefined; if (capture) host = { ...host, capture };
  } catch (error) {
    lifecycle?.dispose();
    host.release();
    throw error;
  }
  const captureSignal = host.capture?.signal;
  const onCaptureAbort = () => lifecycle.cancel(captureSignal?.reason instanceof TimeoutError ? captureSignal.reason : new AbortError({ provider: host.provider, retryable: false }, 'Required capture cancelled'));
  captureSignal?.addEventListener('abort', onCaptureAbort, { once: true });
  const settled = new Set<string>();
  const preAborted = lifecycle.error !== undefined;
  // A pre-aborted signal never reaches the provider. A later abort observes
  // the start promise and interrupts any handle it eventually returns.
  let started: Promise<ControlTurnHandle>;
  try {
    started = lifecycle.error
      ? Promise.reject<ControlTurnHandle>(lifecycle.error)
      : host.capture ? host.capture.begin().then(() => { if (lifecycle.error) throw lifecycle.error; const work = host.control.startTurn(turnRequest(input, options, settled, lifecycle.signal)); host.capture!.track(work); return work; })
      : host.control.startTurn(turnRequest(input, options, settled, lifecycle.signal));
  } catch (error) {
    lifecycle.dispose();
    host.fail(error);
    host.release();
    throw error;
  }
  const events = new TurnEvents();
  const work = collect(host, started, (event) => events.push(event), validate, lifecycle);
  let interrupting: Promise<InterruptReceipt> | undefined;
  const interruptOnce = (reason?: string) => {
    interrupting ??= started.then((turn): Promise<InterruptReceipt> | InterruptReceipt => {
      if (!host.ownsTurn() && !lifecycle.error) return { requested: false, terminal: 'unknown' };
      return turn.interrupt(reason);
    });
    // The transport may reject after the public cancellation result has settled.
    void interrupting.catch(() => undefined);
    return interrupting;
  };
  const cancelledResult = lifecycle.cancelled.then(async (error): Promise<never> => {
    if (preAborted) {
      host.onCancellation(true);
      throw error;
    }
    const [retired, receipt] = await Promise.all([
      settlesWithin(work),
      withinGrace(interruptOnce()),
    ]);
    host.onCancellation(retired && (lifecycle.terminalObserved
      || (receipt !== undefined && receipt.terminal !== 'unknown')));
    host.capture?.throwIfFailed();
    throw error;
  });
  // Once cancellation wins, an adapter rejection must not expose the result
  // before the cleanup path has classified the session state.
  const observedWork = work.then(
    (turn) => lifecycle.error ? cancelledResult : turn,
    (error): Promise<never> => lifecycle.error ? cancelledResult : Promise.reject(error),
  );
  const result = Promise.race([observedWork, cancelledResult]);
  const release = () => {
    captureSignal?.removeEventListener('abort', onCaptureAbort);
    lifecycle.dispose();
    host.activate(undefined);
    host.release();
  };
  void result.then(release, release);
  void result.then((turn) => {
    try { events.push({ type: 'turn.completed', turn }); events.close(); }
    catch (error) { events.fail(error); }
  }, (error: unknown) => events.fail(error));
  return { handle: handle(host, started, result, events, settled, interruptOnce), result };
}

export async function* streamControlTurn(
  host: ControlTurnHost,
  input: AgentInput,
  options: TurnOptions,
  validate: ValidateFunction | undefined,
): AsyncGenerator<AgentEvent> {
  let lifecycle!: ControlTurnLifecycle;
  try {
    lifecycle = new ControlTurnLifecycle(host.provider, options);
    const capture = !lifecycle.error ? host.createCapture?.() : undefined; if (capture) host = { ...host, capture };
  } catch (error) {
    lifecycle?.dispose();
    host.release();
    throw error;
  }
  const captureSignal = host.capture?.signal;
  const onCaptureAbort = () => lifecycle.cancel(captureSignal?.reason instanceof TimeoutError ? captureSignal.reason : new AbortError({ provider: host.provider, retryable: false }, 'Required capture cancelled'));
  captureSignal?.addEventListener('abort', onCaptureAbort, { once: true });
  const settled = new Set<string>();
  let started: Promise<ControlTurnHandle> | undefined;
  let projection: Promise<AsyncGenerator<AgentEvent, Turn, void>> | undefined;
  let pending: Promise<IteratorResult<AgentEvent, Turn>> | undefined;
  let completed = false;
  let failed = false;
  let released = false;
  let cleanup: Promise<void> | undefined;
  let interrupting: Promise<InterruptReceipt> | undefined;
  const interruptOnce = (): Promise<InterruptReceipt> => {
    interrupting ??= (started ?? Promise.reject(lifecycle.error)).then((active) => active.interrupt());
    void interrupting.catch(() => undefined);
    return interrupting;
  };
  const release = () => {
    if (released) return;
    released = true;
    captureSignal?.removeEventListener('abort', onCaptureAbort);
    lifecycle.dispose();
    host.activate(undefined);
    host.release();
  };
  const cancelOnce = (): Promise<void> => {
    cleanup ??= (async () => {
      if (!projection) {
        host.onCancellation(true);
      } else {
        // Consume the old turn's terminal before a shared transport can be reused.
        // Reuse a pending read: starting another one could consume a later turn.
        const drain = (async () => {
          const iterator = await projection;
          for (;;) {
            const step = await (pending ?? iterator.next());
            pending = undefined;
            if (step.done) return;
          }
        })();
        const [retired, receipt] = await Promise.all([
          settlesWithin(drain),
          withinGrace(interruptOnce()),
        ]);
        host.onCancellation(retired && (lifecycle.terminalObserved
          || (receipt !== undefined && receipt.terminal !== 'unknown')));
      }
      release();
    })();
    return cleanup;
  };
  try {
    if (lifecycle.error) throw lifecycle.error;
    await host.capture?.begin(); if (lifecycle.error) throw lifecycle.error;
    started = host.control.startTurn(turnRequest(input, options, settled, lifecycle.signal)); host.capture?.track(started);
    projection = started.then((turn) => {
      if (!lifecycle.error) host.activate(turn);
      return project(turn, host, validate, lifecycle);
    });
    // The listener runs even while the consumer is paused at a yielded event.
    void lifecycle.cancelled.then(cancelOnce);
    // One reaction on `cancelled` for the whole turn: it rejects whichever step
    // is pending when cancellation fires. Racing every step against the
    // still-pending `cancelled` promise attached one reaction per event, and
    // all of them stayed retained until the turn ended (~555 B per event).
    let rejectStep: ((error: Error) => void) | undefined;
    void lifecycle.cancelled.then((error) => { rejectStep?.(error); });
    const untilCancelled = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      if (lifecycle.error) {
        reject(lifecycle.error);
        return;
      }
      rejectStep = reject;
      work.then(
        (value) => { rejectStep = undefined; resolve(value); },
        (error: unknown) => { rejectStep = undefined; reject(error); },
      );
    });
    const iterator = await untilCancelled(projection);
    if (lifecycle.error) throw lifecycle.error;
    for (;;) {
      pending = iterator.next();
      const step = await untilCancelled(pending);
      if (lifecycle.error) throw lifecycle.error;
      pending = undefined;
      if (step.done) {
        await host.capture?.completeTurn(step.value);
        completed = true;
        release();
        yield { type: 'turn.completed', turn: step.value };
        return;
      }
      yield step.value;
    }
  } catch (error) {
    failed = true;
    if (lifecycle.error) {
      await cancelOnce();
    } else {
      host.fail(error);
    }
    if (host.capture) { host.capture.throwIfFailed(); await host.capture.fail(error); }
    throw error;
  } finally {
    if (!completed) host.capture?.abandon();
    if (!completed && !failed && !lifecycle.error && started) {
      // A consumer that stops reading still owns a live provider turn.
      lifecycle.cancel(new AbortError(
        { provider: host.provider, transport: 'control', retryable: true },
        'Control stream consumer stopped reading',
      ));
    }
    if (lifecycle.error) await cancelOnce();
    release();
  }
}
