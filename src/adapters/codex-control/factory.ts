import { toProtocolResult } from './output.js';

import type { ControlBuffer, ControlBufferLimits } from '../../control/event-spool.js';
import { CONTROL_TRANSPORTS, type ControlAdapterRegistration } from '../../core/registry.js';
import {
  AbortError,
  AgentRuntimeError,
  ApprovalRequiredError,
  ProtocolError,
  SessionBusyError,
  ProviderUnavailableError,
  UnsupportedCapabilityError,
} from '../../public/errors.js';
import type {
  InteractionRequest,
  InteractionResponse,
  SessionIdentity,
  SupportLevel,
} from '../../public/types.js';
import {
  toBrokerResponse,
  type ControlForkRequest,
  type ControlSessionHandle,
  type ControlSessionRequest,
  type ControlSessionState,
  type ControlTurnHandle,
  type ControlTurnRequest,
} from '../../session/control-session.js';
import type { AdapterStreamItem } from '../provider.js';
import type { CodexDynamicToolDefinition } from './dynamic-tools.js';
import type { RpcId } from './rpc-peer.js';
import { finalizedIterator, SequencedDelivery, type SequencedItem } from './sequenced-delivery.js';
import { captureCodexConstruction, createCodexPlane, CodexRecoveryCoordinator, type CodexPlane, type CodexRecoveryAttempt } from './recovery.js';
import { CodexToolLifetime } from './tool-lifetime.js';

export const CODEX_CONTROL_ADAPTER_VERSION = '0.1.0';

/** Verdicts for the App Server surface this adapter actually implements. */
export const CODEX_CONTROL_CAPABILITY_VERDICTS: Readonly<Record<string, SupportLevel>> =
  Object.freeze({
    turns: 'full',
    resume: 'full',
    structuredOutput: 'full',
    interactiveApprovals: 'partial',
    userInputDuringTurn: 'full',
    steering: 'full',
    // thread/fork returns a confirmed child thread id with no prompt, so both
    // fork shapes are native here — unlike either exec CLI.
    forkWithPrompt: 'full',
    forkWithoutPrompt: 'full',
    inProcessTools: 'partial',
    processPersistence: 'full',
    messageDeltas: 'full',
    dynamicPermissions: 'none',
    sessionInspection: 'partial',
    checkpointOrRollback: 'none',
    subagentLifecycle: 'unknown',
    subagentMessages: 'unknown',
    subagentDeltas: 'none',
    refusalDetection: 'none',
  });

export interface CodexControlTransport {
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodexTransportStartOptions {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  experimentalApi: boolean;
  onServerRequest(method: string, params: unknown, id: RpcId): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  onUnexpectedExit(): void;
  /** Optional: a tolerated non-JSON stdout line. */
  onNoise?(line: string): void;
}

export type CodexTransportStarter =
  (options: CodexTransportStartOptions) => Promise<CodexControlTransport>;

export interface CodexControlFactoryOptions {
  command?: string;
  args?: string[];
  tools?: CodexDynamicToolDefinition[];
  /** Injected for tests; the default spawns and supervises the app-server child. */
  startTransport?: CodexTransportStarter;
  protocolVersion?: string;
  buffering?: ControlBufferLimits;
}

/** The bridge's typed refusal of an escalation acceptance it already answered with a decline (interactions.ts). */
function declinedOnWire(error: unknown): error is AgentRuntimeError {
  if (!(error instanceof AgentRuntimeError) || error.code !== 'UNSUPPORTED_CAPABILITY') return false;
  const diagnostics = error.context.sanitizedDiagnostics;
  return typeof diagnostics === 'object' && diagnostics !== null && 'wireDecision' in diagnostics;
}

class CodexControlHandle implements ControlSessionHandle {
  get transportEpoch(): string { return this.#binding.plane.epoch; }
  get identity(): SessionIdentity { return this.#binding.identity; }
  hasHandler = false;
  #binding: Readonly<{ plane: CodexPlane; identity: SessionIdentity; delivery: SequencedDelivery }>;
  get #plane(): CodexPlane { return this.#binding.plane; }
  get #delivery(): SequencedDelivery { return this.#binding.delivery; }
  readonly #recovery = new CodexRecoveryCoordinator();
  #handler: ControlTurnRequest['onInteraction'];
  #turnError: AgentRuntimeError | undefined;
  /** Identifies the turn an interaction belongs to; stale handlers never fail a later turn. */
  #turnSerial = 0;
  #turnStart: Promise<unknown> | undefined;
  #announced = false;
  #closed = false;
  #tools: CodexToolLifetime | undefined;

  constructor(plane: CodexPlane, identity: SessionIdentity, delivery: SequencedDelivery) {
    this.#binding = Object.freeze({ plane, identity, delivery });
    plane.handles.set(identity.id, this);
  }

  state(): ControlSessionState {
    if (this.#closed) return 'closed';
    if (this.#delivery.failed) return this.identity.persistence === 'provider' ? 'unknown' : 'failed';
    if (this.#tools?.signal.aborted && this.#plane.dynamicTools.hasPending(this.identity.id)) return 'unknown';
    try {
      return this.#plane.registry.state(this.identity.id);
    } catch {
      return 'failed';
    }
  }

  /**
   * Routed here by the interaction bridge; sessionId in the binding picks the
   * thread. The request rides the critical lane rather than the inbox directly,
   * so the owner sees it after the events that preceded it on the wire.
   */
  deliver(request: InteractionRequest): void {
    if (this.#closed || this.#delivery.failed || this.#tools?.signal.aborted) {
      this.#plane.broker.expire(request.binding.interactionId, 'Control turn no longer accepts approvals'); return;
    }
    this.#delivery.pushCritical({ kind: 'interaction', threadId: this.identity.id, request });
    const handler = this.#delivery.failed ? undefined : this.#handler;
    if (!handler) return;
    const serial = this.#turnSerial, plane = this.#plane;
    void handler(request)
      .then((response) => plane.track(request.binding.sessionId, () => plane.broker.respond(
        request.binding.interactionId,
        toBrokerResponse(response),
      )))
      .catch((error: unknown) => this.#handlerFailed(request, error, serial, plane));
  }

  /**
   * The handler threw, or answered with something the broker refused. If the
   * interaction is still pending, expiring it settles the wire with the
   * decline (the bridge listens on the handle's signal) and the turn fails
   * typed at its terminal. If it was already settled — the application
   * answered out of band through TurnHandle.respond — the wire is done and
   * the late failure is noise. A failure that belongs to an earlier turn (the
   * App Server abandoned the approval when that turn was interrupted) is still
   * declined on the wire but never fails the turn now running.
   */
  #handlerFailed(request: InteractionRequest, error: unknown, serial: number, plane: CodexPlane): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = serial === this.#turnSerial && plane === this.#plane;
    if (!plane.broker.expire(request.binding.interactionId, `Interaction handler failed (${message})`)) {
      // An acceptance the session's authority does not allow was already declined on the wire by the bridge;
      // the handler never sees respond()'s typed error, so the turn reports it at its terminal instead.
      // Only that case: a declined permissions request also lands here and keeps its previous outcome.
      if (current && declinedOnWire(error)) this.#turnError ??= error;
      return;
    }
    if (!current) return;
    this.#turnError ??= error instanceof AgentRuntimeError
      ? error
      : new ApprovalRequiredError(
          { provider: 'codex', transport: 'control', retryable: false },
          `Interaction handler failed (${message}); declined on the wire`,
        );
  }

  toolContext() { return this.#tools ? { signal: this.#tools.signal, deadline: this.#tools.deadline } : {}; }
  acceptsToolTurn(turnId: string | undefined): boolean {
    return !this.#closed && this.#tools !== undefined && !this.#tools.signal.aborted
      && this.#plane.projector.isActiveToolTurn(this.identity.id, turnId);
  }

  async startTurn(request: ControlTurnRequest): Promise<ControlTurnHandle> {
    if (this.#delivery.failure) throw this.#delivery.failure;
    if (this.#plane.dynamicTools.hasPending(this.identity.id)) throw new ProviderUnavailableError({ provider: 'codex', retryable: false }, 'Prior tool work has not settled');
    if (this.#delivery.busy) throw new SessionBusyError({ provider: 'codex', transport: 'control', retryable: true });
    this.#tools?.cancel();
    this.#tools = new CodexToolLifetime(request, this.#plane.broker, this.identity.id);
    this.#tools.signal.throwIfAborted();
    this.#handler = request.onInteraction;
    this.hasHandler = request.onInteraction !== undefined;
    this.#turnError = undefined;
    this.#turnStart = undefined;
    this.#turnSerial += 1;
    const serial = this.#turnSerial, plane = this.#plane, tools = this.#tools;
    let buffer: ControlBuffer<SequencedItem> | undefined;
    const first = !this.#announced;
    try {
      buffer = await this.#delivery.begin(`${this.transportEpoch}:${serial}`, this.#plane.buffering,
        () => this.#deliveryFailed(serial), () => { if (serial === this.#turnSerial) this.#tools?.cancel(); });
      this.#tools.signal.throwIfAborted();
      this.#turnStart = this.#plane.turnControl.startTurn(this.identity.id, request.input, {
        ...(request.providerParams === undefined ? {} : { providerParams: request.providerParams }),
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      });
      const receipt = await this.#turnStart as { turnId?: string };
      if (receipt.turnId) plane.latest.set(this.identity.id, Object.freeze({ id: receipt.turnId, status: 'unknown' }));
      this.#announced = true;
    } catch (error) { if (buffer) await this.#delivery.end(buffer); this.#tools.cancel(); throw buffer?.failure ?? error; }
    return {
      stream: this.#turnStream(buffer, serial, first, request.outputSchema),
      interrupt: () => { if (!this.#owns(plane, serial)) return Promise.resolve({ requested: false, terminal: 'unknown' }); tools.cancel(); return plane.turnControl.interrupt(this.identity.id); },
      steer: (input) => this.#owns(plane, serial) ? plane.turnControl.steer(this.identity.id, input) : Promise.reject(new ProtocolError({ provider: 'codex', retryable: false }, 'Stale turn control')),
    };
  }

  #deliveryFailed(serial: number): void {
    if (serial !== this.#turnSerial) return;
    this.#tools?.cancel(); this.#plane.broker.expireScope(this.identity.id);
    // Notifications can precede the turn/start response. Observe that response
    // before interruption so a prior turn id can never be used for this failure.
    void Promise.resolve().then(async () => {
      await this.#turnStart;
      if (!this.#closed && serial === this.#turnSerial) await this.#plane.turnControl.interrupt(this.identity.id);
    }).catch(() => undefined);
  }

  #turnStream(buffer: ControlBuffer<SequencedItem>, serial: number, first: boolean, outputSchema?: Record<string, unknown>): AsyncIterableIterator<AdapterStreamItem> {
    let terminalSeen = false, text = '';
    const plane = this.#plane, delivery = this.#delivery, tools = this.#tools;
    const finish = async () => {
      if (!terminalSeen && !this.#closed && serial === this.#turnSerial && !delivery.failed) {
        buffer.fail(new ProtocolError({ provider: 'codex', transport: 'control', retryable: false }, 'Control consumer ended before its terminal'));
      }
      await delivery.end(buffer);
    };
    const stream = (async function* (this: CodexControlHandle): AsyncGenerator<AdapterStreamItem> {
      try {
        if (first) yield { kind: 'session', sessionId: this.identity.id };
        for (;;) {
          const step = await buffer.next();
          if (step.done) throw new ProviderUnavailableError(
            { provider: 'codex', transport: 'control', retryable: true },
            `Codex thread ${this.identity.id} stopped delivering before the turn reached a terminal`,
          );
          const value = step.value;
          if (value.lane === 'public') {
            if (value.event.type === 'message.completed') text = value.event.text;
            yield { kind: 'event', event: value.event }; continue;
          }
          const critical = value.item;
          if (critical.kind === 'interaction') {
            yield { kind: 'event', event: { type: 'interaction.requested', request: critical.request } }; continue;
          }
          if (critical.kind === 'thread-state') {
            throw new ProviderUnavailableError({ provider: 'codex', transport: 'control', retryable: true }, `Codex App Server transport died; the outcome of the in-flight turn on thread ${this.identity.id} is unknown (${critical.info.message})`);
          }
          terminalSeen = true; tools?.cancel();
          plane.latest.set(this.identity.id, Object.freeze({ ...(critical.terminal.turnId ? { id: critical.terminal.turnId } : {}), status: critical.terminal.status }));
          await delivery.end(buffer);
          if (this.#turnError !== undefined) { const error = this.#turnError; this.#turnError = undefined; throw error; }
          if (critical.terminal.status === 'interrupted') throw new AbortError(
            { provider: 'codex', transport: 'control', retryable: true }, `Codex turn on thread ${this.identity.id} was interrupted`,
          );
          yield { kind: 'result', result: toProtocolResult(critical.terminal, this.identity.id, text, outputSchema) }; return;
        }
      } catch (error) { if (!terminalSeen) buffer.fail(error); throw error; } finally { await finish(); }
    }).call(this);
    return finalizedIterator(stream, finish);
  }

  async respond(interactionId: string, response: InteractionResponse): Promise<void> {
    const plane = this.#plane; await plane.track(this.identity.id, () => plane.broker.respond(interactionId, toBrokerResponse(response)));
  }

  async fork(request: ControlForkRequest): Promise<ControlSessionHandle> {
    this.#plane.registry.assertWritable(this.identity.id);
    const plane = this.#plane, delivery = new SequencedDelivery();
    const identity = await plane.threadControl.forkThread(this.identity.id, {
      delivery,
      persistence: this.identity.persistence,
      cwd: this.identity.cwd,
      ...(request.model === undefined ? {} : { model: request.model.id }),
      providerParams: { ...this.#plane.threadParams, ephemeral: this.identity.persistence === 'process' },
    });
    if (this.#closed || plane !== this.#plane || plane.dead) throw new ProviderUnavailableError({ provider: 'codex', retryable: false }, 'Fork owner changed');
    return new CodexControlHandle(plane, identity, delivery);
  }

  #owns(plane: CodexPlane, serial: number): boolean { return !this.#closed && plane === this.#plane && serial === this.#turnSerial && !plane.dead && !plane.closed; }
  #eligible(plane: CodexPlane, identity: SessionIdentity): boolean {
    if (plane.latest.has(identity.id) && !plane.latest.get(identity.id)!.id) return false;
    if (this.#closed || plane !== this.#plane || identity.persistence !== 'provider' || !plane.dead || this.#delivery.busy
      || plane.pending(identity.id) || plane.dynamicTools.hasPending(identity.id)) return false;
    try {
      const current = plane.registry.identity(identity.id), hash = plane.construction.toolHash;
      return plane.registry.state(identity.id) === 'unknown' && plane.registry.toolRegistryHash(identity.id) === hash
        && plane.dynamicTools.registryHash() === hash && ['schemaVersion', 'provider', 'transport', 'id', 'cwd', 'model', 'persistence', 'transportEpoch'].every(key => current[key as keyof SessionIdentity] === identity[key as keyof SessionIdentity]);
    } catch { return false; }
  }
  reconcile(): Promise<ControlSessionState> {
    if (this.#closed) return Promise.resolve('closed');
    if (this.state() === 'active') return Promise.resolve('active');
    if (this.identity.persistence !== 'provider') return Promise.resolve('failed');
    const plane = this.#plane, identity = this.identity;
    if (!this.#eligible(plane, identity)) return Promise.resolve('unknown');
    return this.#recovery.reconcile(attempt => this.#recover(plane, identity, attempt));
  }
  async #recover(old: CodexPlane, identity: SessionIdentity, attempt: CodexRecoveryAttempt): Promise<ControlSessionState> {
    const candidate = await createCodexPlane(old.construction, attempt, identity.id), delivery = new SequencedDelivery();
    const valid = () => attempt.isCurrent() && this.#eligible(old, identity) && !candidate.closed && !candidate.dead && !candidate.tainted;
    const hash = old.registry.toolRegistryHash(identity.id);
    await candidate.threadControl.resumeThread({ threadId: identity.id, delivery, persistence: 'provider', recovering: true,
      cwd: identity.cwd, ...(identity.model ? { model: identity.model } : {}), providerParams: candidate.threadParams, ...(hash ? { toolRegistryHash: hash } : {}) });
    if (!valid()) return 'unknown';
    const view = await candidate.threadControl.readForRecovery(identity.id), known = old.latest.get(identity.id);
    if (!view || view.cwd !== undefined && view.cwd !== identity.cwd || view.model !== undefined && view.model !== identity.model
      || known && (!known.id || view.latestTurn?.id !== known.id || known.status !== 'unknown' && view.latestTurn?.status !== known.status) || !valid()) return 'unknown';
    if (old.handles.size === 1) await old.close();
    if (!valid()) return 'unknown';
    const adopted = candidate.registry.activateRecovered(identity.id, identity, hash);
    if (candidate.dynamicTools.registryHash() !== old.construction.toolHash) return 'unknown';
    this.#tools?.cancel();
    if (!valid()) return 'unknown';
    return attempt.commit(() => {
      this.#tools = undefined; this.#handler = undefined; this.hasHandler = false; this.#turnSerial++;
      this.#binding = Object.freeze({ plane: candidate, identity: adopted, delivery });
      candidate.handles.set(identity.id, this); if (view.latestTurn) candidate.latest.set(identity.id, view.latestTurn);
      candidate.accepted = true; old.handles.delete(identity.id);
    }) ? 'active' : 'unknown';
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#turnSerial++; this.#recovery.invalidate();
    await this.#recovery.drainKnownCleanup();
    this.#tools?.cancel();
    this.#plane.broker.expireScope(this.identity.id);
    this.#plane.threadControl.unsubscribe(this.identity.id);
    this.#plane.registry.close(this.identity.id);
    this.#plane.handles.delete(this.identity.id);
    this.#delivery.close();
    await this.#delivery.dispose();
    if (this.#plane.handles.size === 0) await this.#plane.transport.close();
  }
}

export async function openCodexControlSession(
  request: ControlSessionRequest,
  options: CodexControlFactoryOptions = {},
): Promise<ControlSessionHandle> {
  const construction = captureCodexConstruction(request, options), plane = await createCodexPlane(construction);
  const delivery = new SequencedDelivery();
  const start = { delivery, persistence: construction.persistence, cwd: construction.launch.cwd, model: construction.model, providerParams: construction.params };
  try {
    const identity = construction.resumeId === undefined ? await plane.threadControl.startThread(start)
      : await plane.threadControl.resumeThread({ ...start, threadId: construction.resumeId });
    return new CodexControlHandle(plane, identity, delivery);
  } catch (cause) { await plane.close(); throw cause; }
}

export function createCodexControlRegistration(
  options: CodexControlFactoryOptions = {},
): ControlAdapterRegistration {
  return {
    token: CONTROL_TRANSPORTS.codex.token,
    provider: 'codex',
    packageName: CONTROL_TRANSPORTS.codex.packageName,
    adapterVersion: CODEX_CONTROL_ADAPTER_VERSION,
    capabilityVerdicts: CODEX_CONTROL_CAPABILITY_VERDICTS,
    evidenceSource: 'generated-schema',
    protocolVersion: options.protocolVersion ?? 'codex-app-server-0.149.0',
    createSession: (request) => openCodexControlSession(request, options),
  };
}
