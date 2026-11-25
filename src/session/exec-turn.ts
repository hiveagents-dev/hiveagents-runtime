import { settleExecScope } from '../control/exec-settlement.js';
import { raceExecWork, resultUsage, streamStepUsage } from '../control/exec-usage.js';
import { OperationScope } from '../control/operation-scope.js';
import type { ValidateFunction } from 'ajv';

import type {
  AdapterStreamItem,
  ExecAdapter,
  ExecOperation,
  ExecTurnRequest,
  ProtocolFailure,
  ProtocolResult,
} from '../adapters/provider.js';
import {
  AgentRuntimeError,
  ModelUnavailableForAuthError,
  NotAuthenticatedError,
  ProtocolError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnknownModelError,
  UnsupportedCapabilityError,
  UntrustedWorkspaceError,
  UsageLimitError,
} from '../public/errors.js';
import type {
  AgentEvent,
  AgentInput,
  ProviderId,
  SessionIdentity,
  SessionRef,
  SessionState,
  Turn,
  TurnHandle,
  TurnOptions,
  Usage,
} from '../public/types.js';
import { validateTimeoutMs } from '../process/run-process.js';
import type { SessionConfig } from './session.js';
import type { TurnProjection } from './turn-projection.js';
import { projectFailure } from './failure-projection.js';
import { requiredTurnCapture } from './required-capture.js';
import { requestNotes, type PinnedTurnInput } from './pinned.js';

export function inputToPrompt(input: AgentInput, provider: ProviderId): string {
  if (typeof input === 'string') return input;
  const unsupported = input.filter((part) => part.type !== 'text');
  if (unsupported.length > 0) {
    throw new UnsupportedCapabilityError(
      { provider, transport: 'exec', retryable: false },
      'Phase 1 exec input supports text only; image and file inputs require a verified capability',
    );
  }
  return input.map((part) => part.type === 'text' ? part.text : '').join('\n');
}

export function mapFailure(
  failure: ProtocolFailure,
  config: SessionConfig,
  ref?: SessionRef,
  observedUsage?: Usage,
): AgentRuntimeError {
  const safe = projectFailure(failure);
  const context = {
    provider: config.adapter.id,
    transport: config.transport,
    retryable: safe.failure.kind === 'provider-unavailable'
      && safe.failure.reason !== 'request-rejected' && safe.failure.reason !== 'execution-limit',
    ...(config.cliVersion === undefined ? {} : { cliVersion: config.cliVersion }),
    ...(ref === undefined ? {} : { session: ref }),
    ...(safe.rawCode === undefined ? {} : { rawCode: safe.rawCode }),
    ...(observedUsage === undefined ? {} : { observedUsage: structuredClone(observedUsage) }),
    sanitizedDiagnostics: safe.diagnostics,
    failure: safe.failure,
  } as const;
  switch (safe.failure.kind) {
    case 'not-authenticated': return new NotAuthenticatedError(config.adapter.id, context);
    case 'model-unavailable':
      return new ModelUnavailableForAuthError(config.adapter.id, config.model.id, context);
    case 'usage-limit': return new UsageLimitError(context, safe.message);
    case 'protocol': return new ProtocolError(context, safe.message);
    case 'unknown-model': return new UnknownModelError(config.model.id, [], context);
    case 'untrusted-workspace': return new UntrustedWorkspaceError(context, safe.message);
    case 'session-not-found': return new SessionNotFoundError(context, safe.message);
    case 'provider-unavailable': return new ProviderUnavailableError(context, safe.message);
  }
}

function pinnedInput(config: SessionConfig, mode: ExecOperation, modelId: string): PinnedTurnInput {
  return {
    modelId, provider: config.adapter.id, transport: config.transport, mode,
    ...(config.cliVersion === undefined ? {} : { cliVersion: config.cliVersion }),
    ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
    ...(config.providerOptions === undefined ? {} : { providerOptions: config.providerOptions }),
  };
}

/**
 * The refusals `buildExecRequest` makes, in its order, without delivering the pinned option: the
 * pre-flight of a turn that recalls memory first and builds its request once recall is done.
 */
export function checkExecRequest(config: SessionConfig, options: TurnOptions, mode: ExecOperation, modelId = config.model.id): void {
  config.pinned?.check(pinnedInput(config, mode, modelId));
  validateTimeoutMs(options.timeoutMs);
}

export function buildExecRequest(
  config: SessionConfig,
  prompt: string,
  options: TurnOptions,
  mode: ExecOperation,
  sessionId?: string,
  modelId = config.model.id,
): ExecTurnRequest {
  const pinned = config.pinned?.apply(pinnedInput(config, mode, modelId));
  const instructions = pinned?.instructions ?? config.instructions;
  const providerOptions = pinned?.providerOptions ?? config.providerOptions;
  const request: ExecTurnRequest = {
    mode,
    modelId,
    cwd: config.cwd,
    prompt,
    env: config.env,
    contextArgs: [...config.contextArgs],
    permissionArgs: [...config.permissionArgs],
    timeoutMs: validateTimeoutMs(options.timeoutMs),
    maxOutputBytes: 64 * 1024 * 1024,
    ...(options.awaitSettlement === undefined ? {} : { awaitSettlement: options.awaitSettlement }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
  if (pinned) requestNotes.set(request, pinned.note);
  return request;
}

/** A confirmed fork whose first turn failed: the child is real, its turn is not. */
export function failedForkTurn(
  ref: SessionIdentity,
  result: ProtocolResult,
  failure: ProtocolFailure,
  config: SessionConfig,
): Turn {
  return {
    session: ref,
    status: 'failed',
    text: result.text,
    events: [...result.events],
    warnings: [...config.warnings],
    providerMetadata: { failureKind: failure.kind },
  };
}

export function requireExecFeature(config: SessionConfig, feature: string): void {
  if (!['unsupported', 'partial'].includes(config.features[feature] ?? 'unverified')) return;
  throw new UnsupportedCapabilityError(
    {
      provider: config.adapter.id,
      transport: config.transport,
      retryable: false,
      ...(config.cliVersion === undefined ? {} : { cliVersion: config.cliVersion }),
    },
    `${feature} is not supported by the installed ${config.adapter.id} CLI`,
  );
}

/**
 * An exec turn has no bidirectional channel, so its handle can only abort the
 * process and report what the abort actually produced. `state()` is read after
 * the turn settles so the receipt reflects the session, not the request.
 */
export function startExecTurn(
  config: SessionConfig,
  run: (options: TurnOptions) => Promise<Turn>,
  state: () => SessionState,
  options: TurnOptions,
): TurnHandle {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const result = run({ ...options, signal });
  const events = (async function* (): AsyncIterable<AgentEvent> {
    const turn = await result;
    yield* turn.events;
    yield { type: 'turn.completed', turn };
  })();
  return {
    token: { value: crypto.randomUUID() },
    // Metadata must not create a second unhandled rejection when callers
    // already observe the failure through result or events (as in control).
    turnId: result.then((turn) => turn.id, () => undefined),
    events,
    result,
    interrupt: async () => {
      controller.abort();
      try {
        await result;
        return { requested: true, terminal: 'completed' };
      } catch {
        return {
          requested: true,
          terminal: state() === 'interrupted' ? 'interrupted' : 'unknown',
        };
      }
    },
    detach: () => undefined,
    respond: async () => {
      throw new UnsupportedCapabilityError(
        { provider: config.adapter.id, transport: config.transport, retryable: false },
        'Exec transport has no bidirectional interaction channel',
      );
    },
  };
}

/**
 * Streams an exec turn: events reach the consumer before the provider process
 * reaches its terminal result, and the terminal result is still the only thing
 * that produces a `Turn`.
 */
export async function* streamExecTurn(
  config: SessionConfig,
  stream: NonNullable<ExecAdapter['stream']>,
  projection: TurnProjection,
  request: ExecTurnRequest,
  validate: ValidateFunction | undefined,
  track?: (work: Promise<unknown>) => void,
  identity?: SessionIdentity,
): AsyncGenerator<AgentEvent> {
  const capture = requiredTurnCapture(config, request, identity); let completed = false;
  const tracked = (work: Promise<unknown>) => { track?.(work); capture?.track(work); };
  const events: AgentEvent[] = [];
  let result: ProtocolResult | undefined;
  try {
  await capture?.begin();
  const capturedRequest = capture ? { ...request, signal: capture.signal, timeoutMs: capture.remainingMs() } : request;
  for await (const item of scopedExecItems(stream, capturedRequest, config.adapter.id, tracked)) {
    if (item.kind === 'session') {
      const started = projection.adopt(item.sessionId);
      if (started) {
        events.push(started);
        await capture?.observe(started);
        yield started;
      }
    } else if (item.kind === 'event') {
      events.push(item.event);
      await capture?.observe(item.event);
      yield item.event;
    } else {
      result = item.result;
    }
  }
  if (!result) {
    throw new ProtocolError(
      { provider: config.adapter.id, transport: config.transport, retryable: false },
      'Provider stream ended without a terminal result',
    );
  }
  const turn = projection.complete(result, events, validate);
  await capture?.completeTurn(turn); completed = true;
  yield { type: 'turn.completed', turn };
  } catch (error) { if (capture) await capture.fail(error, request.awaitSettlement); throw error; }
  finally { if (!completed) capture?.abandon(); }
}

export async function* scopedExecItems(
  stream: NonNullable<ExecAdapter['stream']>,
  request: ExecTurnRequest,
  provider: ProviderId,
  track?: (work: Promise<unknown>) => void,
) {
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  const scope = new OperationScope({ timeoutMs: request.timeoutMs, signal, context: { provider, transport: 'exec', retryable: true } });
  let iterator: AsyncIterator<AdapterStreamItem> | undefined;
  let exhausted = false;
  try {
    // The adapter reports real settlement to `track`; the consumer's own wait below stays bounded unless it opted in.
    const raw = stream({ ...request, awaitSettlement: true, signal: scope.signal, timeoutMs: scope.remainingMs() })[Symbol.asyncIterator]();
    iterator = { next: () => { const work = Promise.resolve().then(() => raw.next()); track?.(work); return work; },
      ...(raw.return ? { return: () => { const work = Promise.resolve().then(() => raw.return!()); track?.(work); return work; } } : {}) };
    for (;;) {
      const step = await raceExecWork(scope, () => iterator!.next(), request.awaitSettlement, streamStepUsage);
      if (step.done) { exhausted = true; return; }
      yield step.value;
    }
  } finally {
    controller.abort();
    await settleExecScope(scope, request.awaitSettlement, iterator, exhausted, track);
  }
}
/** Shared buffering producer; required capture is installed here, not on diagnostic TurnEvents. */
export async function performExecTurn(
  config: SessionConfig, request: ExecTurnRequest, complete: (result: ProtocolResult) => Turn,
  track: (work: Promise<unknown>) => void, onError: (error: unknown, aborted: boolean) => void, identity?: SessionIdentity,
): Promise<Turn> {
  const capture = requiredTurnCapture(config, request, identity);
  const signal = capture?.signal ?? request.signal;
  const scope = new OperationScope({ timeoutMs: request.timeoutMs, ...(signal ? { signal } : {}), context: { provider: config.adapter.id, transport: 'exec', retryable: true } });
  try {
    await capture?.begin();
    const result = await raceExecWork(scope, () => {
      const work = config.adapter.execute({ ...request, awaitSettlement: true, signal: scope.signal, timeoutMs: scope.remainingMs() });
      track(work); capture?.track(work); return work;
    }, request.awaitSettlement, resultUsage);
    const turn = complete(result); return capture ? await capture.completeTurn(turn, true) : turn;
  } catch (error) {
    let original = error; try { if (capture) await capture.fail(error, request.awaitSettlement); } catch (failure) { original = failure; }
    onError(original, scope.signal.aborted); throw original;
  }
  finally { if (request.awaitSettlement) await scope.drain(); scope.dispose(); }
}
