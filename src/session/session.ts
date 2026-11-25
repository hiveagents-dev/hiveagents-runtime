import { awaitExecWork } from '../control/exec-settlement.js';
import type { ValidateFunction } from 'ajv';

import type { ExecOperation, ExecTurnRequest, ProtocolResult } from '../adapters/provider.js';
import { validateOutput } from '../core/schema.js';
import {
  ProtocolError,
  SessionBusyError,
  SessionMismatchError,
  SessionNotFoundError,
  StructuredOutputError,
  UnsupportedCapabilityError,
} from '../public/errors.js';
import type {
  AgentEvent, AgentInput, ForkOptions, ProviderId, SessionIdentity,
  PersistedSessionRef, SessionRef, SessionState, Turn, TurnHandle, TurnOptions,
} from '../public/types.js';
import type { ControlSessionHandle, ControlTurnHandle } from './control-session.js';
import { runControlTurn, streamControlTurn, type ControlTurnHost } from './control-turn.js';
import {
  buildExecRequest,
  inputToPrompt,
  mapFailure,
  startExecTurn,
  streamExecTurn,
  performExecTurn,
} from './exec-turn.js';
import { checkExecFork, startNativeFork, type ForkHost } from './fork.js';
import { settledTurnHandle, type TurnProjection } from './turn-projection.js';
import type { SessionConfig } from './config.js';
import { structuredOutputValidator } from './validation.js';
import { assertNativeSessionIdentity, nativeRef } from './native-identity.js';
import { isExecutionHalted } from '../public/execution-halt.js';
import { requiredTurnCapture } from './required-capture.js';
import { controlNote, requestNotes } from './pinned.js';
import type { PinnedTurnNote } from '../public/types.js';
import { annotateMemory, type RecalledTurn } from './memory.js';
import { remembered, rememberedFork, rememberedHandle, rememberedStream, type MemoryWrap } from './memory-turn.js';
import { acquireError, interruptedBy } from './session-guards.js';
import { completedTurn, memoryCall, preflightTurn } from './session-turns.js';
export type { SessionConfig } from './config.js';

type RecalledRun<T> = (input: AgentInput, options: TurnOptions, recalled?: RecalledTurn) => T;

const LIVE_SUPPORT = new Set(['full', 'partial']);
const RECOVERABLE_EXEC = new Set<SessionState>(['interrupted', 'unknown', 'failed']);

export class Session {
  #state: SessionState = 'idle';
  #ref: SessionIdentity | undefined;
  readonly #createdAt: string;
  readonly #config: SessionConfig;
  readonly #control: ControlSessionHandle | undefined;
  #activeTurn: ControlTurnHandle | undefined;
  #controlOwner = 0;
  /** What the pinned option did for the turn now running; read once by `#complete`. */
  #note: PinnedTurnNote | undefined;
  /** What memory did for the turn now running; recorded by `#complete`, before any log capture sees the turn. */
  #recalled: RecalledTurn | undefined;
  readonly #pendingExec = new Set<Promise<unknown>>();
  #confirmIdentity!: (identity: SessionIdentity) => void;
  readonly #identityPromise = new Promise<SessionIdentity>((resolve) => { this.#confirmIdentity = resolve; });

  constructor(config: SessionConfig) {
    this.#config = config;
    this.#control = config.control;
    // A live control handle knows the real transport epoch; a resumed ref may
    // carry a stale one, and no new interaction binding may reuse that.
    const adopted = config.control?.identity;
    const base = adopted ?? config.resume;
    this.#ref = base === undefined
      ? undefined
      : {
          ...base,
          ...(adopted === undefined ? {} : { model: adopted.model ?? config.model.id }),
          transportEpoch: config.control?.transportEpoch
            ?? base.transportEpoch
            ?? crypto.randomUUID(),
        };
    this.#createdAt = this.#ref?.createdAt ?? new Date().toISOString();
    if (this.#ref) this.#confirmIdentity(this.#ref);
  }

  get state(): SessionState { return this.#state; }
  get provider(): ProviderId { return this.#config.adapter.id; }

  get ref(): SessionRef | undefined {
    return this.#ref;
  }

  get identity(): SessionIdentity | undefined {
    return this.#ref && { ...this.#ref };
  }

  export(): PersistedSessionRef {
    if (this.#config.persistence !== 'provider') {
      throw new UnsupportedCapabilityError(
        { provider: this.#config.adapter.id, transport: this.#config.transport, retryable: false },
        'Process-only sessions cannot be exported',
      );
    }
    return { ...this.#requireRef(), persistence: 'provider' };
  }

  send(input: AgentInput, options: TurnOptions = {}): Promise<Turn> { return this.#remember(input, options, remembered, (i, o, r) => this.#send(i, o, r)); }
  start(input: AgentInput, options: TurnOptions = {}): TurnHandle { return this.#remember(input, options, rememberedHandle, (i, o, r) => this.#start(i, o, r)); }
  stream(input: AgentInput, options: TurnOptions = {}): AsyncIterable<AgentEvent> { return this.#remember(input, options, rememberedStream, (i, o, r) => this.#stream(i, o, r)); }
  runOneShot(input: AgentInput, options: TurnOptions = {}): Promise<Turn> { return this.#remember(input, options, remembered, (i, o, r) => this.#runOneShot(i, o, r), 'one-shot'); }

  async #send(input: AgentInput, options: TurnOptions, recalled?: RecalledTurn): Promise<Turn> {
    if (this.#control) {
      this.#validator(options);
      this.#gateControl(recalled);
      this.#acquire();
      return this.#runControl(input, options).result;
    }
    // Validated before acquiring: a request the CLI never saw must not leave the session failed.
    const validate = this.#validator(options);
    const request = this.#execRequest(input, options, undefined, recalled);
    this.#acquire();
    try {
      return await this.#perform(request, validate);
    } finally {
      if (this.#state === 'running') this.#state = 'idle';
    }
  }

  #start(input: AgentInput, options: TurnOptions, recalled?: RecalledTurn): TurnHandle {
    if (this.#control) {
      this.#validator(options);
      this.#gateControl(recalled);
      this.#acquire();
      return this.#runControl(input, options).handle;
    }
    const validate = this.#validator(options);
    const request = this.#execRequest(input, options, undefined, recalled);
    this.#acquire();
    return startExecTurn(
      this.#config,
      (turnOptions) => this.#perform(
        turnOptions.signal === undefined ? request : { ...request, signal: turnOptions.signal },
        validate,
      ).finally(() => {
        if (this.#state === 'running') this.#state = 'idle';
      }),
      () => this.#state,
      options,
    );
  }

  async *#stream(input: AgentInput, options: TurnOptions, recalled?: RecalledTurn): AsyncIterable<AgentEvent> {
    const validate = this.#validator(options);
    if (this.#control) {
      this.#validator(options);
      this.#gateControl(recalled);
      this.#acquire();
      yield* streamControlTurn(this.#controlHost(options), input, options, validate);
      return;
    }
    const adapterStream = this.#config.adapter.stream?.bind(this.#config.adapter);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const request = this.#execRequest(input, { ...options, signal }, undefined, recalled);
    this.#acquire();
    try {
      if (!adapterStream) {
        const turn = await this.#perform(request, validate);
        for (const event of turn.events) yield event;
        yield { type: 'turn.completed', turn };
        return;
      }
      yield* streamExecTurn(this.#config, adapterStream, this.#projection(), request, validate, (work) => this.#trackExec(work), this.identity);
    } catch (error) {
      if (this.#state === 'running') {
        this.#state = error instanceof StructuredOutputError
          ? 'idle'
          : interruptedBy(error) ? 'unknown' : 'failed';
      }
      throw error;
    } finally {
      controller.abort();
      if (this.#state === 'running') this.#state = 'unknown';
    }
  }

  async #runOneShot(input: AgentInput, options: TurnOptions, recalled?: RecalledTurn): Promise<Turn> {
    if (this.#control) {
      this.#validator(options);
      this.#gateControl(recalled);
      this.#acquire();
      return this.#runControl(input, options).result;
    }
    const validate = this.#validator(options);
    const request = this.#execRequest(input, options, 'one-shot', recalled);
    this.#acquire();
    try {
      return await this.#perform(request, validate);
    } finally {
      if (this.#state === 'running') this.#state = 'idle';
    }
  }

  async forkAndSend(
    input: AgentInput,
    options: ForkOptions = {},
  ): Promise<{ session: Session; turn: Turn }> {
    const { session, turn } = await this.startFork(input, options);
    return { session, turn: await turn.result };
  }

  /** Returns after native child identity is confirmed; its first turn remains live. */
  async startFork(input: AgentInput, options: ForkOptions = {}): Promise<{ session: Session; turn: TurnHandle }> {
    this.#acquire();
    try {
      const host: ForkHost = {
        config: this.#config, source: this.#requireRef(),
        ...(this.#control ? { control: this.#control } : {}),
        create: (model, resume, control) => {
          const { control: _control, resume: _resume, ...rest } = this.#config;
          return new Session({ ...rest, model, ...(resume ? { resume } : {}), ...(control ? { control } : {}) });
        },
        identity: (session) => session.#identityPromise,
        state: (session, state) => { session.#state = state; },
        track: (session, work) => { session.#trackExec(work); },
        complete: (session, result, validate) => session.#complete(result, validate),
      };
      // A control child recalls in its own `start`; an exec fork recalls here, after the refusals it makes before it starts.
      const memory = this.#control ? undefined : memoryCall(this.#config, false);
      if (!memory) return await startNativeFork(host, input, options);
      checkExecFork(host, input, options);
      return await rememberedFork(memory, input, options, (forkInput, forkOptions, recalled) => startNativeFork(
        { ...host, annotate: (turn) => annotateMemory(turn, recalled.note) }, forkInput, forkOptions,
      ));
    } finally { if (this.#state === 'running') this.#state = 'idle'; }
  }

  /** Forks and starts a turn; a confirmed child survives a failed turn. */
  async forkAndStart(
    input: AgentInput,
    options: ForkOptions = {},
  ): Promise<{ session: Session; turn: TurnHandle }> {
    const { session, turn } = await this.forkAndSend(input, options);
    return { session, turn: settledTurnHandle(turn) };
  }

  /** Injects input into the turn already running; control transports that negotiated steering only. */
  async steer(input: AgentInput): Promise<void> {
    const turn = this.#activeTurn;
    if (!this.#control || !this.#steeringNegotiated() || !turn?.steer) {
      throw new UnsupportedCapabilityError(
        { provider: this.#config.adapter.id, transport: this.#config.transport, retryable: false },
        this.#control
          ? 'This control session did not negotiate steering, or no turn is running'
          : 'Steering requires a control transport',
      );
    }
    await turn.steer(input);
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'running') {
      throw new SessionBusyError(
        { provider: this.#config.adapter.id, transport: this.#config.transport, retryable: true },
        'Cannot close a session while a turn is running',
      );
    }
    this.#controlOwner += 1;
    this.#state = 'closing';
    try {
      if (this.#config.memory) await this.#config.memory.drain(this);
      await this.#control?.close();
      this.#state = 'closed';
    } catch (error) {
      this.#state = this.#config.persistence === 'provider' ? 'unknown' : 'failed';
      throw error;
    }
  }

  async reconcile(): Promise<SessionState> {
    this.#config.capture?.assertActive();
    if (this.#control) {
      // Recovery must not take ownership from a live turn or reverse a close.
      if (this.#state === 'running' || this.#state === 'closing' || this.#state === 'closed') return this.#state;
      if ((this.#state === 'unknown' || this.#state === 'failed') && !this.#control.reconcile) return this.#state;
      const owner = this.#controlOwner, observed = this.#state;
      const state = await (this.#control.reconcile?.() ?? Promise.resolve(this.#control.state()));
      if (owner !== this.#controlOwner || observed !== this.#state) return this.#state;
      const identity = state === 'active' ? this.#control.identity : undefined;
      if (identity || state === 'active' && this.#ref && this.#control.transportEpoch !== this.#ref.transportEpoch) {
        const expected = { schemaVersion: 1, provider: this.provider, transport: 'control', persistence: this.#config.persistence, cwd: this.#config.cwd, transportEpoch: this.#control.transportEpoch };
        if (!identity || Object.entries(expected).some(([key, value]) => identity[key as keyof SessionIdentity] !== value) || typeof identity.id !== 'string' || !identity.id.trim() || typeof expected.transportEpoch !== 'string' || !expected.transportEpoch.trim() || this.#ref && identity.id !== this.#ref.id || identity.model !== undefined && identity.model !== this.#config.model.id) { this.#state = 'unknown'; throw new SessionMismatchError({ provider: this.provider, transport: 'control', retryable: false }, 'Reconciled control identity changed its binding'); }
        this.#ref = { ...this.#ref, ...this.#makeRef(identity.id, identity.model ?? this.#config.model.id) }; this.#confirmIdentity(this.#ref);
      }
      this.#state = state === 'active' ? 'idle'
        : state === 'closed' ? 'closed' : state === 'unknown' ? 'unknown' : 'failed';
      return this.#state;
    }
    if (!RECOVERABLE_EXEC.has(this.#state)) return this.#state;
    await awaitExecWork(this.#pendingExec);
    // Exec keeps no live channel: settled work is the only proof that nothing still writes the native transcript.
    if (this.#pendingExec.size === 0 && RECOVERABLE_EXEC.has(this.#state) && this.#config.persistence === 'provider') this.#state = 'idle';
    return this.#state;
  }

  #trackExec(work: Promise<unknown>): void {
    const retire = () => { this.#pendingExec.delete(work); };
    this.#pendingExec.add(work);
    void work.then(retire, retire);
  }

  #acquire(): void {
    this.#config.capture?.assertActive();
    const refused = acquireError(this.#config, this.#state, this.#ref);
    if (refused) throw refused;
    this.#state = 'running';
  }

  /**
   * Without memory the turn runs as it always did. With memory the session is held through recall:
   * the refusals a turn without memory makes before it runs run first, in its order and where it
   * throws them, so a refused turn never reaches the provider. The pinned option is only checked
   * there: the turn delivers it once recall is done, with the constraints current at that point.
   */
  #remember<T>(input: AgentInput, options: TurnOptions, wrap: MemoryWrap<T>, run: RecalledRun<T>, mode?: ExecOperation): T {
    const memory = memoryCall(this.#config, this.#control !== undefined && this.#steeringNegotiated());
    if (!memory) return run(input, options);
    const release = () => { if (this.#state === 'running') this.#state = 'idle'; };
    return wrap({
      ...memory, owner: this, release,
      hold: () => preflightTurn(this.#config, input, options, mode ?? (this.#ref ? 'resume' : 'open'), () => this.#acquire(), release),
    }, input, options, run);
  }

  #runControl(input: AgentInput, options: TurnOptions) {
    try {
      return runControlTurn(this.#controlHost(options), input, options, this.#validator(options));
    } catch (error) {
      if (this.#state === 'running') this.#state = 'idle';
      throw error;
    }
  }

  #controlHost(options: TurnOptions): ControlTurnHost {
    const owner = ++this.#controlOwner;
    const owns = () => owner === this.#controlOwner;
    return {
      ...(this.#config.capture ? { createCapture: () => { try { return requiredTurnCapture(this.#config, options, this.identity); } catch (error) { this.#state = 'unknown'; throw error; } } } : {}),
      ...this.#projection(),
      provider: this.#config.adapter.id,
      control: this.#control as ControlSessionHandle,
      ownsTurn: () => owns() && this.#state === 'running',
      steering: () => this.#steeringNegotiated(),
      activate: (turn) => { if (owns()) this.#activeTurn = turn; },
      fail: (error) => { if (owns()) this.#failControl(error); },
      release: () => {
        if (!owns()) return;
        this.#controlOwner += 1;
        if (this.#state === 'running') this.#state = 'idle';
      },
      onInterrupt: (receipt) => {
        if (owns() && receipt.terminal === 'unknown' && this.#state !== 'running') this.#state = 'unknown';
      },
      onCancellation: (terminalKnown) => {
        if (!owns()) return;
        this.#state = terminalKnown && this.#control?.state() !== 'unknown'
          ? 'interrupted'
          : this.#config.persistence === 'provider' ? 'unknown' : 'failed';
      },
    };
  }

  #projection(): TurnProjection {
    return {
      adopt: (sessionId) => this.#adopt(sessionId),
      complete: (result, events, validate) => this.#complete(result, validate, events),
    };
  }

  #validator(options: TurnOptions): ValidateFunction | undefined {
    return structuredOutputValidator(this.#config, options);
  }

  /** A control turn that ends badly is interrupted, or whatever the transport reports. */
  #failControl(error: unknown): void {
    if (this.#state !== 'running') return;
    if (this.#config.capture && isExecutionHalted(error)) { this.#state = 'unknown'; return; }
    if (interruptedBy(error)) {
      this.#state = 'interrupted';
      return;
    }
    this.#state = this.#control?.state() === 'unknown' ? 'unknown' : 'failed';
  }

  #steeringNegotiated(): boolean {
    return LIVE_SUPPORT.has(this.#config.negotiated?.steering?.support ?? 'unknown');
  }

  #adopt(sessionId: string, usage?: ProtocolResult['usage']): AgentEvent | undefined {
    try { assertNativeSessionIdentity(this.#config, this.#ref, sessionId, usage); }
    catch (error) { this.#state = 'failed'; throw error; }
    if (this.#ref) return undefined;
    this.#ref = this.#makeRef(sessionId);
    this.#confirmIdentity(this.#ref);
    return { type: 'session.started', session: this.#ref };
  }

  #execRequest(input: AgentInput, options: TurnOptions, mode?: ExecOperation, recalled?: RecalledTurn): ExecTurnRequest {
    this.#note = undefined;
    this.#recalled = undefined;
    const request = buildExecRequest(
      this.#config,
      inputToPrompt(input, this.#config.adapter.id),
      options,
      mode ?? (this.#ref ? 'resume' : 'open'),
      this.#ref?.id,
    );
    this.#note = requestNotes.get(request);
    this.#recalled = recalled;
    return request;
  }

  /** Control turns have no verified pinned channel: refuse, or record the opt-out, before the turn starts. */
  #gateControl(recalled?: RecalledTurn): void {
    this.#note = controlNote(this.#config);
    this.#recalled = recalled;
  }

  async #perform(request: ExecTurnRequest, validate: ValidateFunction | undefined): Promise<Turn> {
    return performExecTurn(this.#config, request, result => this.#complete(result, validate), work => { this.#trackExec(work); }, (error, aborted) => {
      if (!(error instanceof StructuredOutputError)) this.#state = this.#config.capture && isExecutionHalted(error) ? 'unknown' : interruptedBy(error) ? aborted || this.#pendingExec.size > 0 ? 'unknown' : 'interrupted' : 'failed';
    }, this.identity);
  }

  #complete(
    result: ProtocolResult,
    validate: ValidateFunction | undefined,
    streamedEvents?: AgentEvent[],
  ): Turn {
    const firstSessionEvent = this.#ref === undefined;
    if (result.sessionId !== undefined) this.#adopt(result.sessionId, result.usage);
    if (result.failure) {
      this.#state = 'failed';
      throw mapFailure(result.failure, this.#config, this.#ref, result.usage);
    }
    if (!result.sessionId) {
      this.#state = 'failed';
      throw new ProtocolError(
        {
          provider: this.#config.adapter.id, transport: this.#config.transport, retryable: false,
          ...(result.usage === undefined ? {} : { observedUsage: structuredClone(result.usage) }),
        },
        'Provider completed without confirming a native session id',
      );
    }
    this.#ref = this.#makeRef(result.sessionId);
    this.#confirmIdentity(this.#ref);
    this.#state = 'idle';
    if (validate) validateOutput(validate, result.output, result.usage);

    const baseEvents = streamedEvents ?? result.events;
    const events: AgentEvent[] = firstSessionEvent
      ? [{ type: 'session.started', session: this.#ref }, ...baseEvents]
      : [...baseEvents];
    const note = this.#note, recalled = this.#recalled;
    this.#note = undefined;
    this.#recalled = undefined;
    return completedTurn(this.#config, this.#ref, result, events, note, recalled);
  }

  #makeRef(id: string, modelId = this.#config.model.id): SessionIdentity {
    return nativeRef(this.#config, id, modelId, this.#control?.transportEpoch ?? this.#ref?.transportEpoch, this.#createdAt);
  }

  #requireRef(): SessionIdentity {
    if (!this.#ref) {
      throw new SessionNotFoundError(
        { provider: this.#config.adapter.id, transport: this.#config.transport, retryable: false },
        'Native session id is not available until the first turn confirms it',
      );
    }
    return this.#ref;
  }
}
