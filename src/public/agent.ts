import { validateSettlementOption } from '../control/exec-settlement.js';
import { raceExecWork, resultUsage, settledHandleUsage } from '../control/exec-usage.js';
import { snapshotAgentOptions } from './agent-options.js';
import { agentEnvironment, freshAgentReadiness, prepareAgent, type PreparedAgent } from './agent-readiness.js';
import { streamAgentOperation } from './agent-operation.js';
import { OperationScope } from '../control/operation-scope.js';
import { validateTimeoutMs } from '../process/run-process.js';
import { isSafeSessionId } from '../adapters/provider.js';
import {
  controlSessionUnavailableMessage,
  experimentalGates,
} from '../core/registry.js';
import { defaultRuntime, type Runtime } from '../core/runtime.js';
import type { ControlSessionHandle } from '../session/control-session.js';
import { Session } from '../session/session.js';
import type { AgentLogCaptureBinding } from '../orchestration/log/capture-runtime.js';
import { captureControlOpen } from '../session/required-capture.js';
import { PinnedTurns } from '../session/pinned.js';
import { agentMemory, type MemoryTurns } from '../session/memory.js';
import { freeze } from '../shared/json.js';
import {
  SessionMismatchError,
  SessionBusyError,
  UnsupportedCapabilityError,
} from './errors.js';
import type {
  AgentEvent, AgentInput, AgentOptions, AgentReadiness, AgentReadinessOptions,
  CapabilityReport,
  ModelInfo, NegotiatedPlan, OneShotOptions,
  RuntimeWarning,
  SessionOptions,
  SessionPersistence,
  Turn, TurnHandle, TurnOptions,
} from './types.js';
export class Agent {
  readonly model: ModelInfo;
  readonly #model: ModelInfo;
  readonly #options: Readonly<AgentOptions>;
  readonly #runtime: Runtime;
  #capture: AgentLogCaptureBinding | undefined;
  #implicitSession: Session | undefined;
  #implicitOpening: Promise<Session> | undefined;
  #preparation: Promise<PreparedAgent> | undefined;
  #implicitTurnActive = false;
  #pinned: PinnedTurns | undefined;
  /** One per Agent, shared by its sessions; an internal `run` owner shares this Agent's. */
  #memory: MemoryTurns | undefined;
  constructor(options: AgentOptions, runtime: Runtime = defaultRuntime) {
    this.#capture = runtime.bindLogCapture();
    const model = runtime.resolveModel(options.model);
    // Keep the public model descriptor separate from the resolved execution identity.
    this.#model = freeze(model);
    this.model = this.#capture ? this.#model : structuredClone(this.#model);
    // Response authority must not change when the caller later mutates its tool/config arrays.
    const { pinned, memory, ...plain } = options;
    this.#pinned = pinned === undefined ? undefined : new PinnedTurns(pinned);
    this.#memory = agentMemory(memory, runtime.memoryDefault(), { model: structuredClone(model), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    // Pinned delivery was examined for the exec transport only, so `auto` means `exec` here.
    this.#options = snapshotAgentOptions(this.#pinned && (plain.transport ?? 'auto') === 'auto' ? { ...plain, transport: 'exec' } : plain);
    this.#runtime = runtime;
  }
  /** Logical capture identity of this actual Agent instance; never a dispatch authority. */
  get logIdentity() { return this.#capture?.identity; }
  /** Options request fresh bounded readiness, independent of the default readiness cache. */
  async ready(options?: AgentReadinessOptions): Promise<AgentReadiness> {
    this.#capture?.assertActive();
    if (options !== undefined) return freshAgentReadiness(this.#options, this.#runtime, this.#model, options);
    return (await this.#cachedPreparation()).readiness;
  }
  async capabilities(): Promise<CapabilityReport> { return (await this.ready()).capabilities; }
  async openSession(options: SessionOptions = {}): Promise<Session> {
    return this.#openSession(options);
  }
  async #openSession(options: SessionOptions, scope?: OperationScope): Promise<Session> {
    this.#capture?.assertActive();
    const persistence = options.persistence ?? options.resume?.persistence ?? 'provider';
    const { cwd, permissions: intent, sessionAdapter, launchPlan, readiness } = persistence === 'provider'
      ? await this.#cachedPreparation(scope)
      : await prepareAgent(this.#options, this.#runtime, this.#model, persistence, scope);
    const { transport } = launchPlan;
    await scope?.race(() => undefined);
    if (options.resume) {
      if (readiness.capabilities.features.resume === 'unsupported') {
        throw new UnsupportedCapabilityError(
          {
            provider: this.#model.provider,
            transport,
            retryable: false,
            ...(readiness.installation.version === undefined
              ? {}
              : { cliVersion: readiness.installation.version }),
          },
          `resume is not supported by the installed ${this.#model.provider} CLI`,
        );
      }
      const structurallyInvalid = options.resume.schemaVersion !== 1
        || !isSafeSessionId(options.resume.id)
        || Number.isNaN(Date.parse(options.resume.createdAt));
      const mismatch = options.resume.provider !== this.#model.provider
        || options.resume.cwd !== cwd
        || options.resume.transport !== transport
        || options.resume.persistence !== persistence;
      if (structurallyInvalid || mismatch) {
        throw new SessionMismatchError(
          { provider: this.#model.provider, transport, retryable: false, session: options.resume },
          structurallyInvalid ? 'SessionRef is malformed' : 'SessionRef provider, cwd, transport, or persistence does not match this Agent',
        );
      }
    }
    const context = this.#runtime.registration(this.#model.provider).translateContext(this.#options.context);
    const permissions = this.#runtime.registration(this.#model.provider).translatePermissions(
      intent,
      transport,
    );
    const warnings: RuntimeWarning[] = [
      ...readiness.capabilities.warnings,
      ...(options.resume?.model && options.resume.model !== this.#model.id
        ? [{
            code: 'SESSION_MODEL_CHANGED',
            message: `Resuming session created with ${options.resume.model} using ${this.#model.id}`,
          }]
        : []),
      ...context.warnings.map((message) => ({ code: 'CONTEXT_PARTIAL', message })),
      ...permissions.report.warnings.map((message) => ({ code: 'PERMISSION_WARNING', message })),
    ];
    const providerOptions = this.#model.provider === 'claude' ? this.#options.providerOptions?.claude
      : this.#model.provider === 'codex' ? this.#options.providerOptions?.codex
      : this.#options.providerOptions?.external?.[this.#model.provider];
    const control = transport === 'control'
      ? await this.#openControlSession(launchPlan, cwd, options, persistence, providerOptions, scope)
      : undefined;
    return new Session({
      adapter: sessionAdapter,
      ...(this.#capture ? { capture: this.#capture } : {}),
      model: this.#model,
      resolveModel: (requested) => this.#runtime.resolveModel(requested),
      cwd,
      transport,
      persistence,
      ...(control === undefined
        ? {}
        : { control, negotiated: launchPlan.capabilities }),
      ...(readiness.installation.version === undefined ? {} : { cliVersion: readiness.installation.version }),
      ...(this.#options.instructions === undefined ? {} : { instructions: this.#options.instructions }),
      ...(this.#options.effort === undefined ? {} : { effort: this.#options.effort }),
      ...(this.#pinned === undefined ? {} : { pinned: this.#pinned }),
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      contextArgs: context.args,
      permissionArgs: permissions.args,
      env: this.#environment(),
      warnings,
      features: readiness.capabilities.features,
      ...(providerOptions === undefined ? {} : { providerOptions }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    });
  }
  async send(input: AgentInput, options: TurnOptions = {}): Promise<Turn> {
    return this.start(input, options).result;
  }
  start(input: AgentInput, options: TurnOptions = {}): TurnHandle {
    validateSettlementOption(options.awaitSettlement);
    if (this.#implicitTurnActive) {
      throw new SessionBusyError({
        provider: this.#model.provider,
        transport: this.#options.transport === 'control' ? 'control' : 'exec',
        retryable: true,
      });
    }
    this.#implicitTurnActive = true;
    let scope: OperationScope;
    try { scope = new OperationScope({ timeoutMs: validateTimeoutMs(options.timeoutMs), ...(options.signal ? { signal: options.signal } : {}), context: { provider: this.#model.provider, retryable: true } }); }
    catch (error) { this.#implicitTurnActive = false; throw error; }
    const nested = scope.race(() => this.#getImplicitSession(scope)).then((session) =>
      raceExecWork(scope, () => Promise.resolve(session.start(input, { ...options, timeoutMs: scope.remainingMs(), signal: scope.signal })), options.awaitSettlement, settledHandleUsage));
    const turnId = nested.then((handle) => handle.turnId);
    // send() consumers only await result; an early readiness failure must not create
    // a second unhandled rejection from the optional id channel.
    void turnId.catch(() => undefined);
    const result = nested.then((handle) => handle.result).finally(async () => {
      try {
        if (options.awaitSettlement) { await scope.drain(); scope.rethrowExecutionHalt(); }
      } finally {
        this.#implicitTurnActive = false;
        scope.dispose();
      }
    });
    void result.catch(() => undefined);
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield* (await nested).events;
    })();
    return {
      token: { value: crypto.randomUUID() },
      turnId,
      events,
      result,
      interrupt: async (reason) => (await nested).interrupt(reason),
      detach: () => { void nested.then((handle) => handle.detach()).catch(() => undefined); },
      respond: async (interactionId, response) => (await nested).respond(interactionId, response),
    };
  }
  async *stream(input: AgentInput, options: TurnOptions = {}): AsyncIterable<AgentEvent> {
    yield* streamAgentOperation((scope) => this.#getImplicitSession(scope), this.#model.provider, input, options);
  }
  async run(input: AgentInput, options: OneShotOptions = {}): Promise<Turn> {
    validateSettlementOption(options.awaitSettlement);
    const owner = options.context
      ? new Agent({ ...this.#options, context: options.context, memory: false }, this.#runtime)
      : this;
    // An internal one-shot owner is still this public logical Agent.
    if (owner !== this) { owner.#capture = this.#capture; owner.#pinned = this.#pinned; owner.#memory = this.#memory; }
    const scope = new OperationScope({ timeoutMs: validateTimeoutMs(options.timeoutMs), ...(options.signal ? { signal: options.signal } : {}), context: { provider: this.#model.provider, retryable: true } });
    let session: Session | undefined;
    const opening = owner.#openSession({ persistence: 'provider' }, scope);
    void opening.then((opened) => { if (scope.signal.aborted) void opened.close().catch(() => undefined); }, () => undefined);
    const { context: _context, ...turnOptions } = options;
    try {
      session = await scope.race(() => opening);
      return await raceExecWork(scope, () => session!.runOneShot(input, { ...turnOptions, timeoutMs: scope.remainingMs(), signal: scope.signal }), options.awaitSettlement, resultUsage);
    } finally {
      try {
        if (options.awaitSettlement) { await scope.drain(); scope.rethrowExecutionHalt(); }
      } finally {
        scope.dispose();
        // The one-shot's capture must not delay its result: `close()` of this Agent waits for it.
        if (session && this.#memory) this.#memory.forget(session);
        await session?.close().catch(() => undefined);
      }
    }
  }
  /** Also waits for pending memory captures of every session of this Agent, each bounded by 10 s. */
  async close(): Promise<void> {
    if (this.#implicitOpening) await this.#implicitOpening;
    await this.#implicitSession?.close();
    this.#implicitSession = undefined;
    this.#implicitOpening = undefined;
    if (this.#memory) await this.#memory.drain();
  }
  async #getImplicitSession(scope?: OperationScope): Promise<Session> {
    const implicit = this.#implicitSession;
    if (implicit) {
      if (['interrupted', 'unknown', 'failed'].includes(implicit.state)) await implicit.reconcile();
      return implicit;
    }
    this.#implicitOpening ??= this.#openSession({ persistence: 'provider' }, scope);
    try {
      const session = await this.#implicitOpening;
      if (scope?.signal.aborted) { await session.close().catch(() => undefined); throw scope.signal.reason; }
      this.#implicitSession = session;
      return session;
    } finally {
      this.#implicitOpening = undefined;
    }
  }
  #cachedPreparation(scope?: OperationScope): Promise<PreparedAgent> {
    if (!this.#preparation) {
      const pending = prepareAgent(this.#options, this.#runtime, this.#model, 'provider', scope).catch((error: unknown) => {
        if (this.#preparation === pending) this.#preparation = undefined;
        throw error;
      });
      this.#preparation = pending;
    }
    return this.#preparation;
  }
  async #openControlSession(
    plan: NegotiatedPlan,
    cwd: string,
    options: SessionOptions,
    persistence: SessionPersistence,
    providerOptions: Record<string, unknown> | undefined,
    scope?: OperationScope,
  ): Promise<ControlSessionHandle> {
    const registration = this.#runtime.controlRegistration(this.#model.provider);
    if (!registration?.createSession) {
      throw new UnsupportedCapabilityError(
        { provider: this.#model.provider, transport: 'control', retryable: false },
        controlSessionUnavailableMessage(this.#model.provider),
      );
    }
    const executablePath = plan.fingerprint.executableRealpath;
    return captureControlOpen(this.#capture, this.#model, scope?.signal, () => registration.createSession!({
      model: this.#model,
      cwd,
      persistence,
      env: this.#environment(),
      envelope: plan.envelope,
      capabilities: plan.capabilities,
      experimentalApi: experimentalGates(this.#options.providerOptions).api,
      ...(this.#options.tools === undefined ? {} : { tools: this.#options.tools }),
      ...(this.#options.context === undefined ? {} : { context: this.#options.context }),
      ...(this.#options.instructions === undefined ? {} : { instructions: this.#options.instructions }),
      ...(this.#options.effort === undefined ? {} : { effort: this.#options.effort }),
      ...(executablePath === '' ? {} : { executablePath }),
      ...(this.#options.requireAuth === 'subscription' ? { requireSubscription: true } : {}),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(providerOptions === undefined ? {} : { providerOptions }),
    }));
  }
  #environment() { return agentEnvironment(this.#options); }
}
