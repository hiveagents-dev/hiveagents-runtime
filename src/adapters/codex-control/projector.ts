import { ProviderUnavailableError } from '../../public/errors.js';
import type { AgentEvent, InteractionRequest, RuntimeWarning, Usage } from '../../public/types.js';
import type { TwoLaneDelivery } from '../../control/bounded-lanes.js';
import { numberValue, stringValue } from '../provider.js';
import { readProviderRateLimits, resolveProviderRateLimits } from '../provider-limits.js';
import type { CodexThreadRegistry } from './identity.js';

export interface CodexTurnTerminal {
  status: 'completed' | 'failed' | 'interrupted';
  turnId?: string;
  usage?: Usage;
  failureMessage?: string;
  raw?: unknown;
}

export type CodexCriticalEvent =
  | { kind: 'turn-terminal'; threadId: string; terminal: CodexTurnTerminal }
  | { kind: 'interaction'; threadId?: string; request: InteractionRequest }
  | { kind: 'thread-state'; threadId: string; state: 'unknown' | 'failed'; info: RuntimeWarning };

export type CodexDelivery = TwoLaneDelivery<CodexCriticalEvent, AgentEvent>;

interface TerminalWaiter {
  resolve(terminal: CodexTurnTerminal): void;
  reject(error: unknown): void;
}

interface ThreadProjection {
  delivery: CodexDelivery;
  activeTurnId?: string;
  turnActive: boolean;
  lastTerminal?: CodexTurnTerminal;
  lastUsage?: Usage;
  waiters: TerminalWaiter[];
  /** Per-item accumulated delta text; item/completed is authoritative and clears it. */
  deltaText: Map<string, string>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

// Notification payloads are untrusted (they bypass pinned-schema validation by
// design), so every field access is defensive and unknown shapes degrade to
// provider.event instead of throwing.
function parseUsage(value: unknown): Usage | undefined {
  const raw = asObject(value);
  if (!raw) return undefined;
  const usage: Usage = { costMeaning: 'unavailable' };
  const input = numberValue(raw.input_tokens ?? raw.inputTokens);
  const output = numberValue(raw.output_tokens ?? raw.outputTokens);
  const cached = numberValue(raw.cached_input_tokens ?? raw.cachedInputTokens);
  const cacheWrite = numberValue(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (cacheWrite !== undefined) usage.cacheCreationTokens = cacheWrite;
  return usage;
}

const TOOL_ITEM_TYPES = new Set([
  'command_execution', 'commandExecution',
  'mcp_tool_call', 'mcpToolCall',
  'file_change', 'fileChange',
  'patch_apply', 'patchApply',
  'web_search', 'webSearch',
  'tool_call', 'toolCall',
]);

const MESSAGE_ITEM_TYPES = new Set(['agent_message', 'agentMessage']);

const NOISE_LINE_LIMIT = 1_024;

function toolName(item: Record<string, unknown>, type: string): string {
  if (type === 'command_execution' || type === 'commandExecution') return 'shell';
  if (type === 'mcp_tool_call' || type === 'mcpToolCall') return stringValue(item.tool) ?? 'mcp';
  return type;
}

export class CodexControlProjector {
  readonly #registry: CodexThreadRegistry;
  readonly #threads = new Map<string, ThreadProjection>();

  constructor(options: { registry: CodexThreadRegistry }) {
    this.#registry = options.registry;
  }

  subscribe(threadId: string, delivery: CodexDelivery): void {
    this.#threads.set(threadId, {
      delivery,
      turnActive: false,
      waiters: [],
      deltaText: new Map(),
    });
  }

  unsubscribe(threadId: string): void {
    this.#threads.delete(threadId);
  }

  /**
   * Called by turn control BEFORE the turn/start RPC so notifications that
   * race ahead of the RPC response are attributed to an active turn.
   */
  noteTurnStarted(threadId: string): void {
    const projection = this.#threads.get(threadId);
    if (!projection) return;
    projection.turnActive = true;
    delete projection.activeTurnId;
    delete projection.lastTerminal;
    delete projection.lastUsage;
  }

  /** Only provider-confirmed active turn identity can authorize host callbacks. */
  isActiveToolTurn(threadId: string, turnId: string | undefined): boolean {
    const projection = this.#threads.get(threadId);
    return turnId !== undefined && projection?.turnActive === true && projection.activeTurnId === turnId;
  }

  noteTurnConfirmed(threadId: string, turnId: string): void {
    const projection = this.#threads.get(threadId);
    if (projection?.turnActive && projection.activeTurnId === undefined) projection.activeTurnId = turnId;
  }

  /**
   * Resolves only when a terminal turn notification (turn/completed or
   * turn/failed) arrives — never on an RPC ack. If the turn already reached a
   * terminal state, resolves immediately with that cached terminal. Aborting
   * `signal` withdraws the waiter (rejecting with the signal's reason), so a
   * caller that stops waiting does not stay queued until the next terminal.
   */
  waitForTurnTerminal(threadId: string, signal?: AbortSignal): Promise<CodexTurnTerminal> {
    const projection = this.#threads.get(threadId);
    if (!projection) {
      return Promise.reject(new ProviderUnavailableError(
        { provider: 'codex', transport: 'control', retryable: false },
        `No subscription for thread ${threadId}`,
      ));
    }
    if (!projection.turnActive && projection.lastTerminal) {
      return Promise.resolve(projection.lastTerminal);
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const withdraw = () => {
        const index = projection.waiters.indexOf(waiter);
        if (index !== -1) projection.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      const waiter: TerminalWaiter = {
        resolve: (terminal) => { signal?.removeEventListener('abort', withdraw); resolve(terminal); },
        reject: (error) => { signal?.removeEventListener('abort', withdraw); reject(error); },
      };
      signal?.addEventListener('abort', withdraw, { once: true });
      projection.waiters.push(waiter);
    });
  }

  /** Terminal waiters still queued for a thread (observability and leak tests). */
  pendingTerminalWaiters(threadId: string): number {
    return this.#threads.get(threadId)?.waiters.length ?? 0;
  }

  handleNotification(method: string, params: unknown): void {
    if (method === 'account/rateLimits/updated') {
      const limits = resolveProviderRateLimits(readProviderRateLimits('codex', { method, params }));
      if (limits) for (const projection of this.#threads.values()) if (projection.turnActive)
        projection.delivery.publishEvent({ type: 'provider.event', provider: 'codex', event: limits });
      return;
    }
    const payload = asObject(params) ?? {};
    const threadId = stringValue(payload.threadId ?? payload.thread_id);
    const projection = threadId === undefined ? undefined : this.#threads.get(threadId);
    if (!projection || threadId === undefined) return;

    if (method === 'turn/started') {
      const turn = asObject(payload.turn);
      const turnId = stringValue(payload.turnId ?? payload.turn_id ?? turn?.id);
      projection.turnActive = true;
      if (turnId !== undefined) projection.activeTurnId = turnId;
      projection.delivery.publishEvent(
        turnId === undefined ? { type: 'turn.started' } : { type: 'turn.started', turnId },
      );
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = parseUsage(asObject(payload.tokenUsage)?.last);
      if (projection.turnActive && usage !== undefined) projection.lastUsage = usage;
      projection.delivery.publishEvent({ type: 'provider.event', provider: 'codex', event: { method, params } });
      return;
    }
    if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/interrupted') {
      this.#settleTerminal(threadId, projection, method, payload);
      return;
    }
    // A failed public delivery must not keep accumulating text, but terminal/usage
    // bookkeeping above remains live independently of the public consumer.
    if ('failed' in projection.delivery && projection.delivery.failed === true) { projection.deltaText.clear(); return; }
    if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
      this.#projectItem(projection, method, payload, params);
      return;
    }
    if (method.endsWith('/delta')) {
      this.#projectDelta(projection, method, payload, params);
      return;
    }
    projection.delivery.publishEvent({ type: 'provider.event', provider: 'codex', event: { method, params } });
  }

  /**
   * A non-JSON stdout line the transport tolerated. It cannot be attributed to
   * a thread, so every thread with an active turn sees it as a provider event;
   * between turns it is dropped rather than queued for a turn it predates.
   */
  noteNoise(line: string): void {
    const trimmed = line.length > NOISE_LINE_LIMIT ? `${line.slice(0, NOISE_LINE_LIMIT)}…` : line;
    for (const projection of this.#threads.values()) {
      if (!projection.turnActive) continue;
      projection.delivery.publishEvent({
        type: 'provider.event',
        provider: 'codex',
        event: { method: 'stdout/noise', line: trimmed },
      });
    }
  }

  /**
   * The control transport died. Persisted threads surface a typed reconcile
   * notice and state 'unknown'; ephemeral threads surface a terminal failure.
   * Pending terminal waiters never hang: ephemeral resolve failed, persisted
   * reject (the turn outcome is genuinely unknown and must not be invented).
   */
  handleTransportDeath(cause?: string): void {
    const detail = cause ?? 'Codex App Server transport died';
    for (const transition of this.#registry.markTransportDeath()) {
      const projection = this.#threads.get(transition.threadId);
      if (!projection) continue;
      if (transition.state === 'failed') {
        const terminal: CodexTurnTerminal = { status: 'failed', failureMessage: detail };
        projection.delivery.pushCritical({ kind: 'turn-terminal', threadId: transition.threadId, terminal });
        projection.delivery.pushCritical({
          kind: 'thread-state',
          threadId: transition.threadId,
          state: 'failed',
          info: { code: 'CODEX_THREAD_DIED', message: `${detail}; ephemeral thread ${transition.threadId} is terminally failed` },
        });
        this.#flushWaiters(projection, terminal);
      } else {
        projection.delivery.pushCritical({
          kind: 'thread-state',
          threadId: transition.threadId,
          state: 'unknown',
          info: {
            code: 'CODEX_THREAD_UNKNOWN',
            message: `${detail}; persisted thread ${transition.threadId} requires resume/reconcile before further turns`,
          },
        });
        const error = new ProviderUnavailableError(
          { provider: 'codex', transport: 'control', retryable: true },
          `${detail}; the outcome of the in-flight turn on thread ${transition.threadId} is unknown`,
        );
        for (const waiter of projection.waiters.splice(0)) waiter.reject(error);
      }
      projection.turnActive = false;
      projection.delivery.close();
    }
  }

  #settleTerminal(
    threadId: string,
    projection: ThreadProjection,
    method: string,
    payload: Record<string, unknown>,
  ): void {
    const turn = asObject(payload.turn);
    const turnId = stringValue(payload.turnId ?? payload.turn_id ?? turn?.id) ?? projection.activeTurnId;
    const declaredStatus = stringValue(turn?.status ?? payload.status);
    const status: CodexTurnTerminal['status'] = method === 'turn/failed' || declaredStatus === 'failed'
      ? 'failed'
      : method === 'turn/interrupted' || declaredStatus === 'interrupted'
        ? 'interrupted'
        : 'completed';
    const usage = parseUsage(turn?.usage ?? payload.usage) ?? projection.lastUsage;
    const failureMessage = status === 'failed'
      ? stringValue(asObject(turn?.error)?.message ?? asObject(payload.error)?.message ?? payload.message) ?? 'Codex turn failed'
      : undefined;
    const terminal: CodexTurnTerminal = {
      status,
      ...(turnId === undefined ? {} : { turnId }),
      ...(usage === undefined ? {} : { usage }),
      ...(failureMessage === undefined ? {} : { failureMessage }),
      raw: payload,
    };
    projection.turnActive = false;
    projection.lastTerminal = terminal;
    projection.deltaText.clear();
    projection.delivery.pushCritical({ kind: 'turn-terminal', threadId, terminal });
    this.#flushWaiters(projection, terminal);
  }

  #projectItem(
    projection: ThreadProjection,
    method: string,
    payload: Record<string, unknown>,
    params: unknown,
  ): void {
    const item = asObject(payload.item);
    const itemType = item === undefined ? undefined : stringValue(item.type);
    const id = item === undefined ? undefined : stringValue(item.id);
    if (!item || itemType === undefined || id === undefined) {
      projection.delivery.publishEvent({ type: 'provider.event', provider: 'codex', event: { method, params } });
      return;
    }
    if (MESSAGE_ITEM_TYPES.has(itemType)) {
      if (method === 'item/completed') {
        // The completed item's text is authoritative over any accumulated deltas.
        const text = stringValue(item.text) ?? projection.deltaText.get(id) ?? '';
        projection.deltaText.delete(id);
        projection.delivery.publishEvent({ type: 'message.completed', text });
      }
      return;
    }
    if (TOOL_ITEM_TYPES.has(itemType)) {
      if (method === 'item/started') {
        projection.delivery.publishEvent({ type: 'tool.started', id, name: toolName(item, itemType), input: item });
      } else if (method === 'item/updated') {
        projection.delivery.publishEvent({ type: 'tool.updated', id, update: item });
      } else {
        projection.delivery.publishEvent({ type: 'tool.completed', id, output: item });
      }
      return;
    }
    projection.delivery.publishEvent({ type: 'provider.event', provider: 'codex', event: { method, params } });
  }

  #projectDelta(
    projection: ThreadProjection,
    method: string,
    payload: Record<string, unknown>,
    params: unknown,
  ): void {
    const itemId = stringValue(payload.itemId ?? payload.item_id);
    const delta = stringValue(payload.delta ?? payload.text);
    if (itemId === undefined || delta === undefined) {
      projection.delivery.publishEvent({ type: 'provider.event', provider: 'codex', event: { method, params } });
      return;
    }
    if (method.includes('agentMessage') || method.includes('agent_message')) {
      projection.deltaText.set(itemId, (projection.deltaText.get(itemId) ?? '') + delta);
      projection.delivery.publishEvent({ type: 'message.delta', text: delta });
      return;
    }
    projection.delivery.publishEvent({ type: 'tool.updated', id: itemId, update: { method, delta } });
  }

  #flushWaiters(projection: ThreadProjection, terminal: CodexTurnTerminal): void {
    for (const waiter of projection.waiters.splice(0)) waiter.resolve(terminal);
  }
}
