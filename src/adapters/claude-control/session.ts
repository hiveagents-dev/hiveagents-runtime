import { createControlBuffer, type ControlBuffer, type ControlBufferLimits } from '../../control/event-spool.js';
import { claudeQueryFailure, translateClaudeOutput, type PumpItem } from './output-spool.js';
import type { AgentRuntimeError } from '../../public/errors.js';
import type { ApplicationTool } from '../../tools/types.js';
import { ClaudeToolLifecycle } from './tool-lifecycle.js';
import { APPLICATION_TOOL_SERVER, type McpToolSchemaLoader } from './tools.js';
import type { InteractionBroker } from '../../control/interaction-broker.js';
import {
  AbortError,
  ApprovalRequiredError,
  ProtocolError,
  SessionBusyError,
  TimeoutError,
  UnsupportedCapabilityError,
} from '../../public/errors.js';
import type {
  AgentEvent,
  AgentInput,
  InteractionRequest,
  InteractionResponse,
  InterruptReceipt,
  SessionPersistence,
  SupportLevel,
  Usage,
} from '../../public/types.js';
import { stringValue, type AdapterStreamItem, type ProtocolResult } from '../provider.js';
import { AsyncQueue } from './async-queue.js';
import { finalizeResult } from './result.js';
import {
  loadClaudeAgentSdk,
  type ClaudeAgentSdk,
  type SdkCanUseTool,
  type SdkPermissionMode,
  type SdkPermissionResult,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkUserMessage,
} from './sdk.js';

/** Verdicts honestos de esta implementación para el registry (Tarea 8). */
export const CLAUDE_CONTROL_CAPABILITY_VERDICTS: Readonly<Record<string, SupportLevel>> = Object.freeze({
  interactiveApprovals: 'full',
  userInputDuringTurn: 'none',
  steering: 'none',
  inProcessTools: 'partial',
  processPersistence: 'full',
  messageDeltas: 'full',
  dynamicPermissions: 'partial',
  sessionInspection: 'none',
  checkpointOrRollback: 'none',
  subagentLifecycle: 'unknown',
  subagentMessages: 'unknown',
  subagentDeltas: 'none',
  refusalDetection: 'none',
});

const APPROVAL_DECISIONS = Object.freeze(['allow', 'deny']);

/** How long a deadline-interrupted turn's result may take before the Query is declared wedged. */
export const CLAUDE_CONTROL_TERMINAL_GRACE_MS = 5_000;

// Autoridad relativa de cada permission mode: un cambio a un rango mayor que
// el inicial amplía el SafetyEnvelope y exige una sesión nueva (§2.4).
const MODE_AUTHORITY: Record<SdkPermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
};

export type ClaudeControlInteractionHandler =
  (request: InteractionRequest) => Promise<InteractionResponse>;

export interface ClaudeControlSessionOptions {
  tools?: readonly ApplicationTool[];
  authorityEpoch?: string;
  loadMcpSchemas?: McpToolSchemaLoader;
  sessionId: string;
  cwd: string;
  persistence: SessionPersistence;
  model?: string;
  /** Native session id a reanudar; sólo válido con persistence 'provider'. */
  resume?: string;
  forkSession?: boolean;
  permissionMode?: SdkPermissionMode;
  /** Modelos dentro del envelope negociado; sin lista, setModel no restringe. */
  allowedModels?: readonly string[];
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
  broker: InteractionBroker;
  onInteraction?: ClaudeControlInteractionHandler;
  /** Inyección del SDK para tests; ausente, se carga el paquete opcional. */
  sdk?: ClaudeAgentSdk;
  queryOptions?: SdkQueryOptions;
  buffering?: ControlBufferLimits;
}

export interface ClaudeControlTurnOptions {
  timeoutMs?: number;
  onInteraction?: ClaudeControlInteractionHandler;
  signal?: AbortSignal;
}

function requireUncancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortError(
      { provider: 'claude', transport: 'control', retryable: true },
      'Claude control turn aborted before prompt submission',
    );
  }
}

/**
 * Sesión de control de Claude: un único `Query` long-lived del Agent SDK en
 * streaming input mode (§10.3/§10.6), una cola de input abierta y un output
 * pump. Cada turn es un user message y su ciclo de respuesta; el input
 * adicional encola mensajes futuros — no existe steering del turn activo.
 */
export class ClaudeControlSession {
  readonly #options: ClaudeControlSessionOptions;
  readonly #broker: InteractionBroker;
  readonly #input = new AsyncQueue<SdkUserMessage>();
  #output: ControlBuffer<PumpItem> | undefined;
  #preparing: Promise<ControlBuffer<PumpItem>> | undefined;
  #deliveryFailure: AgentRuntimeError | undefined;
  #queryFailure: AgentRuntimeError | undefined;
  #accepting = false;
  #query: SdkQuery | undefined;
  #pumpDone: Promise<void> | undefined;
  #nativeSessionId: string | undefined;
  #account: { plan?: string } | undefined;
  #cumulativeUsage: Usage | undefined;
  #mode: SdkPermissionMode;
  readonly #modeCeiling: number;
  #running = false;
  #idle: Promise<void> = Promise.resolve();
  #markIdle: (() => void) | undefined;
  #closed = false;
  #turnCount = 0;
  #turnId: string | undefined;
  #turnError: unknown;
  #resultQueued = false;
  #turnHandler: ClaudeControlInteractionHandler | undefined;
  #toolFallbackIndex = 0;
  readonly #tools: ClaudeToolLifecycle | undefined;

  constructor(options: ClaudeControlSessionOptions) {
    if (options.resume !== undefined && options.persistence !== 'provider') {
      throw new UnsupportedCapabilityError(
        { provider: 'claude', transport: 'control', retryable: false },
        'Resuming a Claude session requires provider persistence; process persistence is ephemeral',
      );
    }
    this.#options = { ...options, buffering: { ...options.buffering } };
    this.#tools = options.tools?.length ? new ClaudeToolLifecycle(options.tools, () => ({
      provider: 'claude', transport: 'control', cwd: options.cwd,
      sessionId: this.#nativeSessionId ?? options.sessionId, authorityEpoch: options.authorityEpoch ?? options.sessionId,
      ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
    }), options.loadMcpSchemas) : undefined;
    this.#broker = options.broker;
    this.#mode = options.permissionMode ?? 'default';
    this.#modeCeiling = MODE_AUTHORITY[this.#mode];
  }

  get deliveryFailure(): AgentRuntimeError | undefined { return this.#deliveryFailure ?? this.#queryFailure; }

  get nativeSessionId(): string | undefined { return this.#nativeSessionId; }

  /** Account info redactada: sólo el plan sobrevive (§2, matriz honesta). */
  account(): Readonly<{ plan?: string }> | undefined {
    return this.#account === undefined ? undefined : Object.freeze({ ...this.#account });
  }

  async send(input: string | AgentInput, options?: ClaudeControlTurnOptions): Promise<ProtocolResult> {
    let result: ProtocolResult | undefined;
    for await (const item of this.stream(input, options)) if (item.kind === 'result') result = item.result;
    if (result === undefined) throw new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Claude control turn ended without a result');
    return result;
  }

  async *stream(
    input: string | AgentInput,
    options?: ClaudeControlTurnOptions,
  ): AsyncGenerator<AdapterStreamItem> {
    if (this.#deliveryFailure) throw this.#deliveryFailure;
    if (this.#closed) throw new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Claude control session is closed');
    if (this.#running) throw new SessionBusyError({ provider: 'claude', transport: 'control', retryable: true });
    if (this.#queryFailure) throw this.#queryFailure;
    this.#running = true;
    this.#idle = new Promise<void>((resolve) => { this.#markIdle = resolve; });
    this.#turnError = undefined; this.#resultQueued = false;
    this.#turnHandler = options?.onInteraction;
    this.#turnId = `turn-${this.#turnCount++}`;
    let output: ControlBuffer<PumpItem> | undefined, terminalSeen = false, submitted = false;
    let expired: AgentRuntimeError | undefined, deadline: NodeJS.Timeout | undefined, graceFailure: unknown;
    const timeoutMs = options?.timeoutMs ?? 600_000;
    // The turn's own deadline: interrupt the Query and settle TIMEOUT at the
    // interrupted turn's result. An owner that already cancelled (aborted
    // signal) drains that result itself. With no result within the grace the
    // Query is wedged: the session fails rather than misattribute a late result.
    const onDeadline = () => {
      if (this.#resultQueued) return; // The result is already queued: the turn finished in time.
      if (!options?.signal?.aborted) {
        expired = new TimeoutError({ provider: 'claude', transport: 'control', retryable: true, sanitizedDiagnostics: { timeoutMs } }, `Control turn timed out after ${timeoutMs} ms`);
        this.#turnError ??= expired;
        if (submitted) void this.interrupt().catch(() => undefined);
      }
      if (!submitted) return;
      const wedged = graceFailure = new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Claude control turn reached no terminal after its deadline interrupt');
      deadline = setTimeout(() => output?.fail(wedged), CLAUDE_CONTROL_TERMINAL_GRACE_MS);
      deadline.unref();
    };
    try {
      const preparing = createControlBuffer<PumpItem>({ ...this.#options.buffering, epoch: this.#turnId,
        context: { provider: 'claude', transport: 'control', retryable: false },
        isCritical: item => item.kind === 'terminal' || (item.kind === 'event' && item.event.type === 'interaction.requested'),
        onFailure: error => { if (this.#output === output) this.#deliveryFailed(error); },
      });
      this.#preparing = preparing;
      output = await preparing.finally(() => { if (this.#preparing === preparing) this.#preparing = undefined; });
      if (this.#closed) throw new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Claude control session is closed');
      this.#output = output;
      this.#tools?.start(timeoutMs, options?.signal);
      deadline = setTimeout(onDeadline, timeoutMs); deadline.unref();
      requireUncancelled(options?.signal);
      await this.#ensureQuery(options?.signal);
      if (this.#queryFailure) throw this.#queryFailure;
      requireUncancelled(options?.signal);
      if (expired) throw expired;
      if (this.#closed) throw new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Claude control session is closed');
      const message = this.#userMessage(input); this.#accepting = true;
      this.#input.push(message); submitted = true;
      const events: AgentEvent[] = [];
      const nativeEvents: unknown[] = [];
      for (;;) {
        const item = await output.next().catch((error: unknown) => { throw expired !== undefined && error === graceFailure ? expired : error; });
        if (item.done) {
          throw new ProtocolError(
            { provider: 'claude', transport: 'control', retryable: false },
            'Claude control stream ended without a result message',
          );
        }
        const value = item.value;
        if (value.kind === 'native') {
          nativeEvents.push(value.message);
        } else if (value.kind === 'session') {
          yield { kind: 'session', sessionId: value.sessionId };
        } else if (value.kind === 'event') {
          events.push(value.event);
          yield { kind: 'event', event: value.event };
        } else {
          terminalSeen = true; clearTimeout(deadline);
          await output.dispose(); this.#output = undefined;
          if (this.#turnError !== undefined) throw this.#turnError;
          const finalized = finalizeResult(value.message, events, nativeEvents, this.#cumulativeUsage, this.#nativeSessionId);
          if (finalized.cumulative !== undefined) this.#cumulativeUsage = finalized.cumulative;
          yield { kind: 'result', result: finalized.result };
          return;
        }
      }
    } finally {
      clearTimeout(deadline);
      if (output && submitted && !terminalSeen && this.#query && !this.#closed && !this.#deliveryFailure) {
        output.fail(new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Control consumer ended before its terminal'));
      }
      this.#retireTurn();
      await output?.dispose();
      if (this.#output === output) this.#output = undefined;
      this.#running = false;
      this.#turnHandler = undefined;
      this.#turnError = undefined;
      this.#markIdle?.();
    }
  }

  /**
   * Resolves true once no turn is in flight on the single Query, or false if
   * one is still draining when the wait runs out. An interrupted turn whose
   * result message arrives late is still consumed to its terminal by the
   * runtime; this is how a reconcile learns that the drain has completed.
   */
  async awaitIdle(timeoutMs: number): Promise<boolean> {
    if (!this.#running) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#idle.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async interrupt(): Promise<InterruptReceipt> {
    if (this.#query === undefined) return { requested: false, terminal: 'unknown' };
    await this.#query.interrupt();
    return { requested: true, terminal: 'unknown' };
  }

  async setPermissionMode(mode: SdkPermissionMode): Promise<void> {
    if (MODE_AUTHORITY[mode] > this.#modeCeiling) {
      throw new UnsupportedCapabilityError(
        { provider: 'claude', transport: 'control', retryable: false },
        `Permission mode "${mode}" would widen the SafetyEnvelope; widening requires a new session`,
      );
    }
    if (this.#query !== undefined) await this.#query.setPermissionMode(mode);
    this.#mode = mode;
  }

  async setModel(model?: string): Promise<void> {
    const allowed = this.#options.allowedModels;
    if (model !== undefined && allowed !== undefined && !allowed.includes(model)) {
      throw new UnsupportedCapabilityError(
        { provider: 'claude', transport: 'control', retryable: false },
        `Model "${model}" is outside the negotiated SafetyEnvelope for this session`,
      );
    }
    if (this.#query !== undefined) await this.#query.setModel(model);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#retireTurn();
    this.#input.end();
    this.#output?.close();
    const preparing = await this.#preparing?.catch(() => undefined);
    await preparing?.dispose();
    await this.#output?.dispose();
    this.#query?.close?.();
    if (this.#pumpDone !== undefined) await this.#pumpDone.catch(() => undefined);
  }

  async #ensureQuery(signal?: AbortSignal): Promise<SdkQuery> {
    if (this.#queryFailure) throw this.#queryFailure;
    if (this.#query !== undefined) return this.#query;
    const sdk = this.#options.sdk ?? await loadClaudeAgentSdk();
    requireUncancelled(signal);
    const options: SdkQueryOptions = {
      ...this.#options.queryOptions,
      cwd: this.#options.cwd,
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      permissionMode: this.#mode,
      canUseTool: this.#canUseTool,
      // Keep a reasoning-only turn observably alive.
      includePartialMessages: true,
      ...(this.#options.persistence === 'process' ? { persistSession: false } : {}),
      ...(this.#options.resume === undefined ? {} : { resume: this.#options.resume }),
      ...(this.#options.forkSession === undefined ? {} : { forkSession: this.#options.forkSession }),
      ...(this.#options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable }),
      ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
    };
    if (this.#tools) options.mcpServers = { [APPLICATION_TOOL_SERVER]: await this.#tools.server(sdk) };
    requireUncancelled(signal);
    this.#query = sdk.query({ prompt: this.#input, options });
    this.#pumpDone = this.#pump(this.#query);
    return this.#query;
  }

  #deliveryFailed(error: AgentRuntimeError): void {
    if (this.#deliveryFailure) return;
    this.#deliveryFailure = error; this.#retireTurn(); this.#input.end();
    void this.interrupt().catch(() => undefined);
    this.#query?.close?.();
  }

  #retireTurn(): void {
    this.#accepting = false; this.#tools?.end(); this.#broker.expireScope(this.#options.sessionId, this.#turnId);
  }
  #queryStopped(cause?: unknown): void {
    if (this.#closed) return;
    this.#queryFailure ??= claudeQueryFailure(cause);
    const active = this.#accepting; this.#retireTurn(); this.#input.end();
    if (active) this.#output?.fail(this.#queryFailure); else this.#output?.close();
  }
  #publish(item: PumpItem): void { this.#output?.push(item); }
  async #pump(query: SdkQuery): Promise<void> {
    try {
      for await (const message of query) {
        if (!this.#output || this.#deliveryFailure) continue;
        this.#publish({ kind: 'native', message });
        const metadata = translateClaudeOutput(message, this.#nativeSessionId, () => `claude-tool-${this.#toolFallbackIndex++}`, item => this.#publish(item));
        if (metadata.sessionId !== undefined) this.#nativeSessionId = metadata.sessionId;
        if (metadata.account !== undefined) this.#account = metadata.account;
        if (message.type === 'result') { this.#resultQueued = true; this.#retireTurn(); this.#output?.close(); }
      }
      this.#queryStopped();
    } catch (error) { this.#queryStopped(error); }
  }

  readonly #canUseTool: SdkCanUseTool = (toolName, input, { signal }) => {
    const cancelled: SdkPermissionResult = { behavior: 'deny', message: 'Tool approval cancelled by Claude' };
    if (signal.aborted || this.#closed || this.#deliveryFailure || !this.#accepting) return Promise.resolve(cancelled);
    // The common registry performs application authorization immediately before execution.
    if (this.#tools?.ownsSdkName(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const resolveWire = (response: SdkPermissionResult) => {
        signal.removeEventListener('abort', cancel);
        handle.signal.removeEventListener('abort', expired);
        resolve(response);
      };
      // The approval belongs to this turn; a failure that lands after the turn
      // ended (the SDK abandoned the tool on interrupt) must not fail a later one.
      const turnId = this.#turnId;
      const failTurn = (error: unknown) => {
        if (this.#running && this.#turnId === turnId) this.#turnError = error;
      };
      const handle = this.#broker.register({
        method: 'canUseTool',
        sessionId: this.#options.sessionId,
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        // `allow` hands this same input back as updatedInput: bind it.
        payload: { toolName, input }, bindPayload: true,
        availableDecisions: APPROVAL_DECISIONS,
        settle: async (response) => {
          resolveWire(response.decision === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message: stringValue(response.reason) ?? 'Denied by the application',
              });
        },
      });
      const cancel = () => {
        if (this.#broker.expire(handle.binding.interactionId, 'Claude cancelled tool approval')) resolveWire(cancelled);
      };
      const expired = () => resolveWire({ behavior: 'deny', message: handle.signal.reason instanceof Error ? handle.signal.reason.message : cancelled.message });
      handle.signal.addEventListener('abort', expired, { once: true });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      const request: InteractionRequest = {
        kind: 'tool-approval',
        toolName,
        input,
        binding: handle.binding,
        availableDecisions: handle.availableDecisions,
        signal: handle.signal,
      };
      this.#publish({ kind: 'event', event: { type: 'interaction.requested', request } });
      if (this.#deliveryFailure) return;
      const handler = this.#turnHandler ?? this.#options.onInteraction;
      if (handler === undefined) {
        // Missing handler: primero deny wire-level, después expira el broker
        // (una respuesta tardía ya no puede «acertar») y el error tipado (§15.3).
        resolveWire({ behavior: 'deny', message: 'No interaction handler is registered' });
        this.#broker.expire(handle.binding.interactionId, 'No interaction handler registered');
        failTurn(new ApprovalRequiredError(
          { provider: 'claude', transport: 'control', retryable: false },
          `No interaction handler for tool approval "${toolName}"`,
        ));
        void this.interrupt().catch(() => undefined);
        return;
      }
      void (async () => {
        try {
          const response = await handler(request);
          const decision = response.kind === 'approval' ? response.decision : 'deny';
          await this.#broker.respond(handle.binding.interactionId, {
            decision,
            ...(response.kind === 'approval' && response.reason !== undefined
              ? { reason: response.reason }
              : {}),
          });
        } catch (error) {
          // The wire is denied only if nobody settled this interaction first;
          // an out-of-band TurnHandle.respond that won the race already did.
          if (!this.#broker.expire(handle.binding.interactionId, 'Interaction handler failed')) return;
          resolveWire({ behavior: 'deny', message: 'Interaction handler failed' });
          failTurn(error);
        }
      })();
    });
  };

  #userMessage(input: string | AgentInput): SdkUserMessage {
    const content = typeof input === 'string'
      ? input
      : input.map((item) => {
          if (item.type !== 'text') {
            throw new UnsupportedCapabilityError(
              { provider: 'claude', transport: 'control', retryable: false },
              `Claude control input does not support "${item.type}" items yet`,
            );
          }
          return { type: 'text', text: item.text };
        });
    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.#nativeSessionId ?? '',
    };
  }
}
