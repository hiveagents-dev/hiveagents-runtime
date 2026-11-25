import type { ValidateFunction } from 'ajv';
import type { ProtocolResult } from '../adapters/provider.js';
import { TurnEvents } from './turn-events.js';
import { OperationScope } from '../control/operation-scope.js';
import { resolveModel } from '../core/models.js';
import { validateTimeoutMs } from '../process/run-process.js';
import { ProtocolError, SessionMismatchError, UnsupportedCapabilityError } from '../public/errors.js';
import type { AgentEvent, AgentInput, ForkOptions, ModelInfo, SessionIdentity, Turn, TurnHandle } from '../public/types.js';
import type { SessionConfig } from './config.js';
import type { ControlSessionHandle } from './control-session.js';
import { buildExecRequest, checkExecRequest, failedForkTurn, inputToPrompt, mapFailure, requireExecFeature, scopedExecItems } from './exec-turn.js';
import type { Session } from './session.js';
import { settledTurnHandle } from './turn-projection.js';
import { structuredOutputValidator } from './validation.js';
import { captureControlOpen, requiredTurnCapture } from './required-capture.js';
import { annotateTurn, requestNotes } from './pinned.js';

export interface ForkHost {
  config: SessionConfig;
  source: SessionIdentity;
  control?: ControlSessionHandle;
  create(model: ModelInfo, identity?: SessionIdentity, control?: ControlSessionHandle): Session;
  identity(session: Session): Promise<SessionIdentity>;
  state(session: Session, state: 'running' | 'idle' | 'unknown'): void;
  track(session: Session, work: Promise<unknown>): void;
  complete(session: Session, result: ProtocolResult, validate?: ValidateFunction): Turn;
  /** Records what memory did on an exec fork's first turn, before a log capture sees it. */
  annotate?(turn: Turn): Turn;
}

/** The refusals a fork makes before it starts anything. */
function checkFork(host: ForkHost, options: ForkOptions): { model: ModelInfo; validate: ValidateFunction | undefined } {
  const { config, source } = host;
  const model = options.model ? (config.resolveModel ?? resolveModel)(options.model) : config.model;
  if (model.provider !== config.adapter.id) throw new SessionMismatchError(
    { provider: config.adapter.id, transport: config.transport, session: source, retryable: false },
    'A native fork cannot change provider',
  );
  const validate = structuredOutputValidator({ ...config, model }, options);
  if (!host.control) {
    requireExecFeature(config, 'forkWithPrompt');
    if (options.onInteraction) throw new UnsupportedCapabilityError(
      { provider: config.adapter.id, transport: 'exec', retryable: false }, 'Exec forks have no interaction channel',
    );
  }
  return { model, validate };
}

/**
 * An exec fork's refusals, in the order the fork makes them, before memory recalls for its first
 * turn: a fork that is always refused never reaches the provider. A fork whose signal is already
 * aborted refuses with that abort before anything else, as without memory, so the rest is left to
 * it. The request (and the pinned option's single delivery) is built once recall is done.
 */
export function checkExecFork(host: ForkHost, input: AgentInput, options: ForkOptions): void {
  const { model } = checkFork(host, options);
  validateTimeoutMs(options.timeoutMs);
  if (options.signal?.aborted) return;
  inputToPrompt(input, host.config.adapter.id);
  checkExecRequest(host.config, options, 'fork', model.id);
}

/** A confirmed native child has a separate lifetime from its first turn. */
export async function startNativeFork(host: ForkHost, input: AgentInput, options: ForkOptions): Promise<{ session: Session; turn: TurnHandle }> {
  const { config } = host;
  const { model, validate } = checkFork(host, options);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const scope = new OperationScope({ timeoutMs: validateTimeoutMs(options.timeoutMs), signal, context: { provider: config.adapter.id, transport: config.transport, retryable: true } });
  try {
    await scope.race(() => undefined);
    if (!host.control) return await startExecFork(host, input, options, model, validate, scope, controller);
    const opening = captureControlOpen(config.capture, model, scope.signal, () => host.control!.fork({ model, signal: scope.signal, timeoutMs: scope.remainingMs(), ...(options.name === undefined ? {} : { name: options.name }) }));
    void opening.then((child) => { if (scope.signal.aborted) void child.close().catch(() => undefined); }, () => undefined);
    const control = await scope.race(() => opening);
    const session = host.create(model, undefined, control);
    const turn = session.start(input, { ...options, signal: scope.signal, timeoutMs: scope.remainingMs() });
    void turn.result.then(() => scope.dispose(), () => scope.dispose());
    await scope.race(() => Promise.race([
      host.identity(session),
      turn.result.then(() => {
        if (!session.identity) throw new ProtocolError({ provider: config.adapter.id, retryable: false }, 'Fork completed without child identity');
        return session.identity;
      }),
    ]));
    return { session, turn };
  } catch (error) { if (options.awaitSettlement) await scope.drain(); scope.dispose(); throw error; }
}

async function startExecFork(
  host: ForkHost, input: AgentInput, options: ForkOptions, model: ModelInfo,
  validate: ValidateFunction | undefined, scope: OperationScope, controller: AbortController,
): Promise<{ session: Session; turn: TurnHandle }> {
  const { config, source } = host;
  const capture = requiredTurnCapture({ ...config, model }, { ...options, signal: scope.signal, timeoutMs: scope.remainingMs() });
  const captureSignal = capture?.signal, onCaptureAbort = () => controller.abort(captureSignal?.reason);
  captureSignal?.addEventListener('abort', onCaptureAbort, { once: true });
  try { await capture?.begin(); } catch (error) { captureSignal?.removeEventListener('abort', onCaptureAbort); if (capture) await capture.fail(error, options.awaitSettlement); throw error; }
  const signal = captureSignal ? AbortSignal.any([scope.signal, captureSignal]) : scope.signal;
  let request: ReturnType<typeof buildExecRequest>;
  try {
    const prompt = inputToPrompt(input, config.adapter.id), turnOptions = { ...options, signal, timeoutMs: scope.remainingMs() };
    request = buildExecRequest(config, prompt, turnOptions, 'fork', source.id, model.id);
  } catch (error) {
    captureSignal?.removeEventListener('abort', onCaptureAbort);
    if (capture) await capture.fail(error, options.awaitSettlement);
    throw error;
  }
  const note = requestNotes.get(request);
  const first = (turn: Turn) => host.annotate?.(turn) ?? turn;
  const create = (id: string) => {
    if (!id || id === source.id) throw new ProtocolError({ provider: config.adapter.id, retryable: false }, 'Provider fork did not confirm a distinct native session id');
    const session = host.create(model, { ...source, id, model: model.id, createdAt: new Date().toISOString() });
    host.state(session, 'running');
    return session;
  };
  if (!config.adapter.stream) {
    try {
    // Execute-only adapters expose a settled fallback, never fabricated live events.
    const result = await scope.race(() => { const work = config.adapter.execute(capture ? { ...request, awaitSettlement: true } : request); capture?.track(work); return work; });
    scope.dispose();
    if (!result.sessionId || result.sessionId === source.id) {
      if (result.failure) throw mapFailure(result.failure, config, source, result.usage);
      throw new ProtocolError({ provider: config.adapter.id, retryable: false }, 'Provider fork did not confirm a distinct native session id');
    }
    const session = create(result.sessionId);
    host.state(session, 'idle');
    const turn = first(result.failure ? failedForkTurn(session.identity!, result, result.failure, config) : annotateTurn(host.complete(session, result, validate), note));
    if (capture) { await capture.observe({ type: 'session.started', session: session.identity! }); await capture.completeTurn(turn, true); }
    return { session, turn: settledTurnHandle(turn) };
    } catch (error) { if (capture) await capture.fail(error, options.awaitSettlement); throw error; }
    finally { captureSignal?.removeEventListener('abort', onCaptureAbort); }
  }
  let session: Session | undefined;
  let confirm!: (session: Session) => void;
  let fail!: (error: unknown) => void;
  const identity = new Promise<Session>((resolve, reject) => { confirm = resolve; fail = reject; });
  const events = new TurnEvents();
  const adopt = async (id: string) => {
    if (session && session.identity?.id !== id) throw new ProtocolError({ provider: config.adapter.id, retryable: false }, 'Provider changed the confirmed fork identity');
    if (!session) {
      session = create(id);
      // The first turn's CLI writes the child's transcript; the child cannot heal while it lives.
      host.track(session, work);
      await capture?.observe({ type: 'session.started', session: session.identity! });
    }
    if (scope.signal.aborted) { host.state(session, 'idle'); void session.close().catch(() => undefined); return; }
    confirm(session);
  };
  const onAbort = () => { if (session) host.state(session, 'unknown'); };
  scope.signal.addEventListener('abort', onAbort, { once: true });
  const work = (async (): Promise<Turn> => {
    try {
    let result: ProtocolResult | undefined;
    scope.signal.throwIfAborted();
    const items = capture ? scopedExecItems(config.adapter.stream!.bind(config.adapter), request, config.adapter.id, work => capture.track(work)) : config.adapter.stream!({ ...request, awaitSettlement: true });
    for await (const item of items) {
      scope.signal.throwIfAborted();
      if (item.kind === 'session') await adopt(item.sessionId);
      else if (item.kind === 'event') { await capture?.observe(item.event); if (!scope.signal.aborted) events.push(item.event); }
      else result = item.result;
    }
    if (!result) throw new ProtocolError({ provider: config.adapter.id, retryable: false }, 'Fork stream ended without a result');
    if (result.sessionId) await adopt(result.sessionId);
    if (scope.signal.aborted) throw scope.signal.reason;
    if (!session) {
      if (result.failure) throw mapFailure(result.failure, config, source, result.usage);
      throw new ProtocolError({ provider: config.adapter.id, retryable: false }, 'Fork stream ended without a child identity');
    }
    host.state(session, 'idle');
    const turn = first(result.failure ? failedForkTurn(session.identity!, result, result.failure, config) : annotateTurn(host.complete(session, result, validate), note));
    return capture ? capture.completeTurn(turn) : turn;
    } catch (error) { if (capture) await capture.fail(error, options.awaitSettlement); throw error; }
    finally { captureSignal?.removeEventListener('abort', onCaptureAbort); }
  })();
  const result = scope.race(() => work).catch(async (error: unknown) => {
    try { capture?.throwIfFailed(); } catch (halt) { error = halt; }
    fail(error);
    if (options.awaitSettlement) await scope.drain();
    throw error;
  });
  void result.then((turn) => { scope.signal.removeEventListener('abort', onAbort); scope.dispose(); events.push({ type: 'turn.completed', turn }); events.close(); }, (error: unknown) => { scope.signal.removeEventListener('abort', onAbort); if (session) host.state(session, 'unknown'); scope.dispose(); fail(error); events.fail(error); });
  const turn: TurnHandle = {
    token: { value: crypto.randomUUID() }, turnId: result.then((value) => value.id, () => undefined), events, result,
    interrupt: async () => { if (scope.signal.aborted) return { requested: false, terminal: 'unknown' }; scope.signal.throwIfAborted(); controller.abort(); return { requested: true, terminal: 'unknown' }; },
    detach: () => undefined,
    respond: async () => { throw new UnsupportedCapabilityError({ provider: config.adapter.id, retryable: false }, 'Exec forks have no interaction channel'); },
  };
  return { session: await scope.race(() => identity), turn };
}
