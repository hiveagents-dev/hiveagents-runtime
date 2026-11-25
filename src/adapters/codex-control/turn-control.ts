import { UnsupportedCapabilityError } from '../../public/errors.js';
import type { AgentInput, InterruptReceipt, SteerReceipt } from '../../public/types.js';
import { stringValue } from '../provider.js';
import type { CodexThreadRegistry } from './identity.js';
import type { CodexControlProjector, CodexTurnTerminal } from './projector.js';
import type { CodexRequester } from './requester.js';

export interface CodexTurnControlOptions {
  requester: CodexRequester;
  registry: CodexThreadRegistry;
  projector: CodexControlProjector;
  /** Bound on interrupt's RPC plus terminal wait (default CODEX_INTERRUPT_GRACE_MS). */
  interruptGraceMs?: number;
}

/**
 * How long interrupt() waits for the App Server to acknowledge and report the
 * turn's terminal before answering 'unknown'. Same order as the supervisor's
 * drain bound and the Claude reconcile grace: a wedged server must not hold
 * an interrupt (or the delivery-failure path that awaits it) forever.
 */
export const CODEX_INTERRUPT_GRACE_MS = 5_000;

export interface StartTurnReceipt {
  turnId?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeInput(input: AgentInput): Array<{ type: 'text'; text: string }> {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  const items: Array<{ type: 'text'; text: string }> = [];
  for (const item of input) {
    if (item.type === 'text') {
      items.push({ type: 'text', text: item.text });
    } else {
      // Image/file inputs over the control transport are not verified against
      // Codex 0.149.0; refusing is honest, silently dropping content is not.
      throw new UnsupportedCapabilityError(
        { provider: 'codex', transport: 'control', retryable: false },
        `Codex control input item type '${item.type}' is not supported yet`,
      );
    }
  }
  return items;
}

function mapTerminal(terminal: CodexTurnTerminal): InterruptReceipt['terminal'] {
  return terminal.status;
}

export class CodexTurnControl {
  readonly #requester: CodexRequester;
  readonly #registry: CodexThreadRegistry;
  readonly #projector: CodexControlProjector;
  readonly #activeTurnIds = new Map<string, string>();
  readonly #interruptGraceMs: number;

  constructor(options: CodexTurnControlOptions) {
    this.#requester = options.requester;
    this.#registry = options.registry;
    this.#projector = options.projector;
    this.#interruptGraceMs = options.interruptGraceMs ?? CODEX_INTERRUPT_GRACE_MS;
  }

  async startTurn(
    threadId: string,
    input: AgentInput,
    options?: { providerParams?: Record<string, unknown>; outputSchema?: Record<string, unknown> },
  ): Promise<StartTurnReceipt> {
    this.#registry.assertWritable(threadId);
    const items = normalizeInput(input);
    // Mark the turn active before the RPC: turn/started and item notifications
    // can legally arrive before the turn/start response.
    this.#projector.noteTurnStarted(threadId);
    const result = await this.#requester.request('turn/start', {
      threadId,
      input: items,
      ...(options?.providerParams ?? {}),
      ...(options?.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    });
    const raw = asObject(result);
    const turnId = stringValue(raw?.turnId ?? raw?.turn_id ?? asObject(raw?.turn)?.id);
    if (turnId !== undefined) {
      this.#activeTurnIds.set(threadId, turnId);
      this.#projector.noteTurnConfirmed(threadId, turnId);
    }
    return turnId === undefined ? {} : { turnId };
  }

  async steer(threadId: string, input: AgentInput): Promise<SteerReceipt> {
    this.#registry.assertWritable(threadId);
    const turnId = this.#activeTurnIds.get(threadId);
    await this.#requester.request('turn/steer', {
      threadId,
      ...(turnId === undefined ? {} : { turnId }),
      input: normalizeInput(input),
    });
    return { accepted: true, ...(turnId === undefined ? {} : { turnId }) };
  }

  /**
   * Sends turn/interrupt and then waits for the terminal turn notification.
   * The RPC ack alone never resolves the receipt: an interrupt is only
   * complete when turn/completed, turn/failed, or turn/interrupted arrives.
   * Both waits share one grace: on expiry the receipt is 'unknown' — the
   * request was sent, but no terminal was observed — never a guessed outcome.
   */
  async interrupt(threadId: string): Promise<InterruptReceipt> {
    const turnId = this.#activeTurnIds.get(threadId);
    // Withdrawn once interrupt() answers: an 'unknown' receipt must not leave a waiter queued in the projector.
    const stopWaiting = new AbortController();
    const terminalWait = this.#projector.waitForTurnTerminal(threadId, stopWaiting.signal);
    // Avoid an unhandled rejection if the RPC itself fails first.
    terminalWait.catch(() => undefined);
    const settled = (async () => {
      await this.#requester.request('turn/interrupt', {
        threadId,
        ...(turnId === undefined ? {} : { turnId }),
      });
      return mapTerminal(await terminalWait);
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      const terminal = await Promise.race([
        settled,
        new Promise<'unknown'>((resolve) => {
          timer = setTimeout(() => resolve('unknown'), this.#interruptGraceMs);
          timer.unref();
        }),
      ]);
      // An expired grace proves nothing about the turn: keep its id so a retried interrupt or a
      // steer still names it. Only an observed terminal retires it.
      if (terminal !== 'unknown') this.#activeTurnIds.delete(threadId);
      return { requested: true, terminal };
    } finally {
      if (timer) clearTimeout(timer);
      stopWaiting.abort();
      // A late RPC failure after the grace answered must not go unhandled.
      settled.catch(() => undefined);
    }
  }

  waitForTerminal(threadId: string): Promise<CodexTurnTerminal> {
    return this.#projector.waitForTurnTerminal(threadId);
  }
}
