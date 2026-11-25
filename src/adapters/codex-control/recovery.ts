import { randomUUID } from 'node:crypto';
import type { ControlSessionState } from '../../session/control-session.js';

export interface CodexRecoveryRead {
  readonly threadId: string; readonly status: 'idle'; readonly cwd?: string; readonly model?: string;
  readonly latestTurn?: Readonly<{ id: string; status: 'completed' | 'failed' | 'interrupted' }>;
}
export interface CodexRecoveryAttempt {
  readonly epoch: string;
  isCurrent(): boolean;
  commit(adopt: () => void): boolean;
  onInvalidate(cleanup: () => void | Promise<void>): void;
}
interface Flight { readonly promise: Promise<ControlSessionState>; invalidate(state: 'closed' | 'unknown'): void }
/** One finite public wait; a late native promise remains quarantined and observed. */
export class CodexRecoveryCoordinator {
  #closed = false;
  #flight: Flight | undefined;
  #cleanup: Promise<void> | undefined;
  #failure: unknown;
  reconcile(work: (attempt: CodexRecoveryAttempt) => Promise<ControlSessionState>): Promise<ControlSessionState> {
    if (this.#closed) return Promise.resolve('closed');
    if (this.#flight) return this.#flight.promise;
    this.#cleanup = undefined; this.#failure = undefined;
    let settle!: (state: ControlSessionState) => void, invalid = false, committed = false, cleanup: (() => void | Promise<void>) | undefined;
    const deadline = Date.now() + 5000;
    const promise = new Promise<ControlSessionState>(resolve => { settle = resolve; });
    const runCleanup = () => {
      if (!committed && cleanup && !this.#cleanup) this.#cleanup = Promise.resolve().then(cleanup).catch(cause => { this.#failure ??= cause; });
    };
    const flight: Flight = { promise, invalidate: state => {
      if (committed) { if (state === 'closed') settle(state); return; }
      invalid = true; runCleanup(); settle(state);
    } };
    this.#flight = flight;
    const timer = setTimeout(() => flight.invalidate('unknown'), 5000); timer.unref();
    const attempt: CodexRecoveryAttempt = Object.freeze({ epoch: randomUUID(),
      isCurrent: () => !invalid && !this.#closed && this.#flight === flight && (committed || Date.now() < deadline),
      commit: (adopt: () => void) => {
        if (committed || !attempt.isCurrent()) return false;
        // No await or external work in adopt: deadline fencing and ownership transfer share one turn.
        clearTimeout(timer);
        try { adopt(); committed = true; return true; }
        catch (cause) { this.#failure ??= cause; invalid = true; runCleanup(); return false; }
      },
      onInvalidate: (callback: () => void | Promise<void>) => {
        if (cleanup) throw new Error('Recovery candidate cleanup is already registered');
        cleanup = callback; if (invalid || this.#closed) runCleanup();
      },
    });
    void (async () => {
      try { await work(attempt); } catch (cause) { this.#failure ??= cause; }
      if (!committed) { invalid = true; runCleanup(); await this.#cleanup; }
      clearTimeout(timer);
      if (this.#flight === flight) this.#flight = undefined;
      settle(this.#closed ? 'closed' : committed ? 'active' : 'unknown');
    })().catch(cause => {
      this.#failure ??= cause; clearTimeout(timer); if (this.#flight === flight) this.#flight = undefined;
      settle(this.#closed ? 'closed' : 'unknown');
    });
    return promise;
  }
  invalidate(): void { this.#closed = true; this.#flight?.invalidate('closed'); }
  async drainKnownCleanup(): Promise<void> { await this.#cleanup; }
}

import { types } from 'node:util';
import { InteractionBroker, type BrokerDecision } from '../../control/interaction-broker.js';
import type { ControlBufferLimits } from '../../control/event-spool.js';
import { ProtocolError, ProviderUnavailableError, UnsupportedCapabilityError } from '../../public/errors.js';
import type { InteractionRequest } from '../../public/types.js';
import type { ControlSessionRequest } from '../../session/control-session.js';
import type { CodexControlFactoryOptions, CodexControlTransport, CodexTransportStarter, CodexTransportStartOptions } from './factory.js';
import { createCodexApplicationToolBinding } from './application-tools.js';
import { assertCodexApproval } from './approval-policy.js';
import { codexControlConfiguration } from './configuration.js';
import { CodexDynamicToolHost } from './dynamic-tools.js';
import { CodexThreadRegistry } from './identity.js';
import { CodexInteractionBridge } from './interactions.js';
import { CodexControlProjector } from './projector.js';
import { CodexAppServerSupervisor } from './supervisor.js';
import { CodexThreadControl } from './thread-control.js';
import { CodexTurnControl } from './turn-control.js';

interface PlaneHandle {
  hasHandler: boolean; deliver(request: InteractionRequest): void;
  toolContext(): { signal?: AbortSignal; deadline?: number };
  acceptsToolTurn(turnId: string | undefined): boolean;
}
export interface KnownCodexTurn { readonly id?: string; readonly status: 'unknown' | 'completed' | 'failed' | 'interrupted' }
export interface CodexConstruction {
  readonly start: CodexTransportStarter; readonly launch: Readonly<Pick<CodexTransportStartOptions, 'command' | 'cwd' | 'experimentalApi'> & { args: readonly string[]; env: Readonly<NodeJS.ProcessEnv> }>;
  readonly params: Readonly<Record<string, unknown>>; readonly dynamicTools: CodexDynamicToolHost; readonly applicationTools: ReadonlySet<string>;
  readonly permissionCeiling: string | undefined; readonly authorityEpoch: string; readonly buffering: ControlBufferLimits;
  readonly model: string; readonly persistence: ControlSessionRequest['persistence']; readonly resumeId?: string; readonly toolHash: string;
}
export interface CodexPlane {
  readonly construction: CodexConstruction; readonly epoch: string; readonly transport: CodexControlTransport;
  readonly registry: CodexThreadRegistry; readonly projector: CodexControlProjector; readonly broker: InteractionBroker;
  readonly threadControl: CodexThreadControl; readonly turnControl: CodexTurnControl;
  readonly handles: Map<string, PlaneHandle>; readonly latest: Map<string, KnownCodexTurn>;
  readonly dynamicTools: CodexDynamicToolHost; readonly threadParams: Readonly<Record<string, unknown>>; readonly buffering: ControlBufferLimits;
  dead: boolean; closed: boolean; accepted: boolean; tainted: boolean;
  pending(threadId: string): number;
  track<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
async function defaultStart(options: CodexTransportStartOptions): Promise<CodexControlTransport> {
  const supervisor = await CodexAppServerSupervisor.start(options);
  return { request: (method, params) => supervisor.connection.request(method, params), close: () => supervisor.shutdown() };
}
function freezeData<T>(value: T, seen = new Set<object>(), depth = 0): T {
  if (value && typeof value === 'object') {
    if (depth > 32 || seen.size > 4096 || types.isProxy(value)) throw new ProtocolError({ provider: 'codex', retryable: false }, 'Control construction exceeds its data bound');
    if (seen.has(value)) return value; seen.add(value);
    for (const item of Object.values(value)) freezeData(item, seen, depth + 1); Object.freeze(value);
  }
  return value;
}
export function captureCodexConstruction(request: ControlSessionRequest, options: CodexControlFactoryOptions): CodexConstruction {
  const config = codexControlConfiguration(request), application = createCodexApplicationToolBinding(request.tools ?? []);
  const dynamicTools = new CodexDynamicToolHost({ experimentalApi: request.experimentalApi,
    tools: [...(options.tools ?? []), ...application.definitions], hasExternalPending: id => application.hasPending(id) });
  const args = options.args === undefined ? config.args : [...config.args.slice(0, -2), ...options.args];
  return Object.freeze({ start: options.startTransport ?? defaultStart,
    launch: Object.freeze({ command: options.command ?? request.executablePath ?? 'codex', cwd: request.cwd,
      experimentalApi: request.experimentalApi, args: Object.freeze([...args]), env: Object.freeze({ ...request.env }) }),
    params: freezeData(structuredClone(config.params)), dynamicTools, applicationTools: new Set(application.definitions.map(tool => tool.name)),
    permissionCeiling: request.envelope.permissionModeCeiling, authorityEpoch: request.envelope.authorityEpoch,
    buffering: Object.freeze({ ...options.buffering }), model: request.model.id, persistence: request.persistence,
    ...(request.resume === undefined ? {} : { resumeId: request.resume.id }), toolHash: dynamicTools.registryHash(),
  });
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isIdleStatus(value: unknown): boolean {
  const status = object(value), keys = Object.keys(status);
  return keys.length === 1 && keys[0] === 'type' && status.type === 'idle';
}
function threadOf(params: unknown): string {
  const raw = object(params);
  return [raw.threadId, raw.thread_id, raw.conversationId, raw.conversation_id].find((value): value is string => typeof value === 'string') ?? '';
}
function unavailable(): InstanceType<typeof ProviderUnavailableError> {
  return new ProviderUnavailableError({ provider: 'codex', transport: 'control', retryable: false }, 'Control plane no longer owns a live transport');
}
/** Construction is shared; a provisional plane owns metadata RPCs only, never application authority. */
export async function createCodexPlane(construction: CodexConstruction, attempt?: CodexRecoveryAttempt, expectedThreadId?: string): Promise<CodexPlane> {
  const epoch = attempt?.epoch ?? randomUUID(), registry = new CodexThreadRegistry({ epoch });
  const projector = new CodexControlProjector({ registry }), broker = new InteractionBroker({ provider: 'codex', epoch });
  let raw: CodexControlTransport | undefined, closing: Promise<void> | undefined;
  const pending = new Map<string, number>();
  const track = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    pending.set(id, (pending.get(id) ?? 0) + 1);
    let operation: Promise<T>; try { operation = work(); } catch (cause) { operation = Promise.reject(cause); }
    return Promise.resolve(operation).finally(() => { const count = pending.get(id)! - 1; if (count) pending.set(id, count); else pending.delete(id); });
  };
  const close = (): Promise<void> => {
    plane.closed = true; plane.accepted = false; broker.expireAll(randomUUID());
    if (!raw) return Promise.resolve();
    closing ??= Promise.resolve().then(() => raw!.close()); return closing;
  };
  const transport: CodexControlTransport = { close, request: (method, params) => {
    if (!raw || plane.dead || plane.closed || (!plane.accepted && !['thread/resume', 'thread/read', 'thread/turns/list'].includes(method))) return Promise.reject(unavailable());
    const id = threadOf(params); if (method === 'turn/start') plane.latest.set(id, Object.freeze({ status: 'unknown' }));
    return track(id, async () => { const result = await raw!.request(method, params); if (plane.dead || plane.closed) throw unavailable(); return result; });
  } };
  const plane: CodexPlane = { construction, epoch, registry, projector, broker, transport, close, track,
    handles: new Map(), latest: new Map(), dynamicTools: construction.dynamicTools, threadParams: construction.params, buffering: construction.buffering,
    threadControl: new CodexThreadControl({ requester: transport, registry, projector, cwd: construction.launch.cwd, dynamicTools: construction.dynamicTools }),
    turnControl: new CodexTurnControl({ requester: transport, registry, projector }),
    pending: id => (pending.get(id) ?? 0) + (pending.get('') ?? 0), dead: false, closed: false, accepted: attempt === undefined, tainted: false,
  };
  const validateResponse = (method: string, response: BrokerDecision) => assertCodexApproval(construction.permissionCeiling, method, response);
  const toolContext = (binding: InteractionRequest['binding']) => ({ ...plane.handles.get(binding.sessionId)?.toolContext(), scope: {
    provider: 'codex', transport: 'control' as const, cwd: construction.launch.cwd, sessionId: binding.sessionId, authorityEpoch: construction.authorityEpoch,
    ...(binding.turnId ? { turnId: binding.turnId } : {}), ...(binding.itemId ? { callId: binding.itemId } : {}),
  } });
  const delivering = new CodexInteractionBridge({ broker, dynamicTools: construction.dynamicTools, validateResponse, toolContext,
    deliver: interaction => plane.handles.get(interaction.binding.sessionId)?.deliver(interaction) });
  const declining = new CodexInteractionBridge({ broker, dynamicTools: construction.dynamicTools, validateResponse, toolContext });
  attempt?.onInvalidate(close);
  try {
    raw = await construction.start({ ...construction.launch, args: [...construction.launch.args], env: { ...construction.launch.env },
      onServerRequest: (method, params, id) => {
        if (plane.dead || plane.closed || !plane.accepted) {
          if (!plane.accepted) plane.tainted = true;
          return Promise.reject(method === 'item/tool/call' ? new ProtocolError({ provider: 'codex', transport: 'control', retryable: false }, 'Tool has no owned active plane') : unavailable());
        }
        const value = object(params), handle = plane.handles.get(threadOf(params));
        if (method === 'item/tool/call' && (attempt !== undefined || construction.applicationTools.has(value.tool as string))) {
          const turnId = typeof value.turnId === 'string' ? value.turnId : typeof value.turn_id === 'string' ? value.turn_id : undefined;
          if (!handle?.acceptsToolTurn(turnId)) return Promise.reject(new ProtocolError({ provider: 'codex', transport: 'control', retryable: false }, 'Tool has no confirmed active turn'));
        }
        if (method === 'item/permissions/requestApproval') return Promise.reject(new UnsupportedCapabilityError({ provider: 'codex', transport: 'control', retryable: false }, 'Codex permission grants have no verified control response mapping'));
        return (handle?.hasHandler ? delivering : declining).handleServerRequest(method, params, id);
      },
      onNotification: (method, params) => {
        if (plane.closed || plane.dead) return;
        if (!plane.accepted) {
          const value = object(params), thread = object(value.thread);
          if (method.startsWith('turn/') || method.startsWith('item/')
            || method === 'thread/status/changed' && !isIdleStatus(value.status)
            || method === 'thread/started' && (thread.id !== expectedThreadId
              || Object.hasOwn(thread, 'status') && !isIdleStatus(thread.status))) plane.tainted = true;
          return;
        }
        projector.handleNotification(method, params);
      },
      onUnexpectedExit: () => { if (!plane.dead && !plane.closed) { plane.dead = true; projector.handleTransportDeath(); broker.expireAll(randomUUID()); } },
      onNoise: line => { if (plane.accepted && !plane.dead && !plane.closed) projector.noteNoise(line); },
    });
    if (plane.dead || plane.closed || attempt && !attempt.isCurrent()) { await close(); throw unavailable(); }
    return plane;
  } catch (cause) { await close(); throw cause; }
}
