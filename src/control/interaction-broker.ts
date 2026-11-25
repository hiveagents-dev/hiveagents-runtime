import { createHash, randomUUID } from 'node:crypto';

import { InteractionExpiredError, ProtocolError } from '../public/errors.js';
import type { ProviderId } from '../public/types.js';

export interface BrokerDecision {
  decision: string;
  [key: string]: unknown;
}

export interface BrokerBinding {
  interactionId: string;
  provider: ProviderId;
  transportEpoch: string;
  providerRequestId?: string | number;
  method: string;
  sessionId: string;
  turnId?: string;
  itemId?: string;
  payloadDigest: string;
}

export interface InteractionHandle {
  binding: Readonly<BrokerBinding>;
  availableDecisions: readonly string[];
  signal: AbortSignal;
}

/**
 * A settlement that answered the provider with a decision other than the one
 * requested (an acceptance the policy refused, written as a decline). The wire
 * is settled, so the interaction is resolved; respond() then throws `refusal`
 * so the caller learns its own decision was not applied.
 */
export interface SettledWithRefusal {
  refusal: Error;
}

interface RegisterInteraction {
  providerRequestId?: string | number;
  method: string;
  sessionId: string;
  turnId?: string;
  itemId?: string;
  payload: unknown;
  /**
   * The settlement acts on `payload` by reference (Claude's `allow` hands the
   * presented tool input back as `updatedInput`). The broker then re-digests
   * the payload before settling and refuses a decision whose payload changed
   * after it was presented: an approval covers exactly what was shown.
   */
  bindPayload?: boolean;
  availableDecisions: readonly string[];
  settle(response: BrokerDecision): Promise<void | SettledWithRefusal>;
}

interface Entry {
  handle: InteractionHandle;
  state: 'pending' | 'resolving' | 'resolved' | 'expired';
  controller: AbortController;
  /** Present only for a payload-bound registration; released with the entry. */
  payload?: { value: unknown };
  settle(response: BrokerDecision): Promise<void | SettledWithRefusal>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * Exactly-once settlement for provider interactions. Live entries exist only
 * while an interaction is pending or resolving; once settled or expired the
 * entry (and the settle closure that retains the provider payload) is
 * released, and a bounded tombstone keeps the typed distinction between
 * «already resolved», «expired» and «unknown» for late responses.
 */
export class InteractionBroker {
  /** Upper bound on remembered settled ids; the oldest are forgotten first. */
  static readonly MAX_TOMBSTONES = 4_096;

  readonly #provider: ProviderId;
  #epoch: string;
  readonly #entries = new Map<string, Entry>();
  readonly #tombstones = new Map<string, 'resolved' | 'expired'>();

  constructor(options: { provider: ProviderId; epoch: string }) {
    this.#provider = options.provider;
    this.#epoch = options.epoch;
  }

  /** Interactions still pending or resolving (observability and leak tests). */
  get size(): number {
    return this.#entries.size;
  }

  register(input: RegisterInteraction): InteractionHandle {
    const controller = new AbortController();
    const binding: BrokerBinding = {
      interactionId: randomUUID(),
      provider: this.#provider,
      transportEpoch: this.#epoch,
      ...(input.providerRequestId === undefined ? {} : { providerRequestId: input.providerRequestId }),
      method: input.method,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      payloadDigest: digest(input.payload),
    };
    const handle: InteractionHandle = Object.freeze({
      binding: Object.freeze(binding),
      availableDecisions: Object.freeze([...input.availableDecisions]),
      signal: controller.signal,
    });
    this.#entries.set(binding.interactionId, {
      handle,
      state: 'pending',
      controller,
      ...(input.bindPayload === true ? { payload: { value: input.payload } } : {}),
      settle: input.settle,
    });
    return handle;
  }

  async respond(interactionId: string, response: BrokerDecision): Promise<void> {
    const entry = this.#entries.get(interactionId);
    if (!entry) {
      const tombstone = this.#tombstones.get(interactionId);
      if (tombstone === 'expired') {
        throw new InteractionExpiredError({ provider: this.#provider, retryable: false });
      }
      if (tombstone === 'resolved') {
        throw new ProtocolError({ provider: this.#provider, retryable: false }, 'Interaction already resolved');
      }
      throw new ProtocolError({ retryable: false }, 'Unknown interaction');
    }
    if (entry.state !== 'pending') {
      throw new ProtocolError({ provider: this.#provider, retryable: false }, 'Interaction already resolved');
    }
    // Authority is per transport epoch: a binding minted on an earlier
    // transport never settles on this one, whatever path left it live.
    if (entry.handle.binding.transportEpoch !== this.#epoch) {
      this.#expireEntry(interactionId, entry, 'Transport epoch changed');
      throw new InteractionExpiredError({ provider: this.#provider, retryable: false });
    }
    if (!entry.handle.availableDecisions.includes(response.decision)) {
      throw new ProtocolError(
        { provider: this.#provider, retryable: false },
        `Decision ${response.decision} was not advertised for this interaction`,
      );
    }
    if (entry.payload !== undefined && digest(entry.payload.value) !== entry.handle.binding.payloadDigest) {
      // The presented request was mutated after registration; settling now
      // would apply this decision to something nobody was shown.
      this.#expireEntry(interactionId, entry, 'Interaction payload changed after it was presented');
      throw new ProtocolError(
        { provider: this.#provider, retryable: false },
        'Interaction payload changed after it was presented; the decision was not applied',
      );
    }
    entry.state = 'resolving';
    let outcome: void | SettledWithRefusal;
    try {
      outcome = await entry.settle(response);
    } catch (error) {
      if (entry.state === 'resolving') {
        this.#release(interactionId, entry, 'expired');
        entry.controller.abort(error);
      }
      throw error;
    }
    if (entry.state !== 'resolving') {
      // The epoch rotated while the settlement was in flight: its delivery
      // belongs to a dead transport and is not confirmed on the current one.
      throw new InteractionExpiredError({ provider: this.#provider, retryable: false });
    }
    this.#release(interactionId, entry, 'resolved');
    entry.controller.abort();
    if (outcome) throw outcome.refusal;
  }

  // Expira una única interacción pendiente: settlement remoto, timeout o deny
  // wire-level por handler ausente o fallido. Best-effort e idempotente — una
  // interacción ya resuelta, ya expirada o desconocida es un no-op y devuelve
  // false; true sólo cuando esta llamada expiró una entrada pendiente.
  expire(interactionId: string, reason?: string): boolean {
    const entry = this.#entries.get(interactionId);
    if (!entry || entry.state !== 'pending') return false;
    this.#expireEntry(interactionId, entry, reason ?? 'Interaction expired');
    return true;
  }

  /** Retire a turn/session without cancelling a sibling thread on the same transport. */
  expireScope(sessionId: string, turnId?: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.handle.binding.sessionId === sessionId
        && (turnId === undefined || entry.handle.binding.turnId === turnId)) this.expire(id, 'Native turn retired');
    }
  }

  /**
   * Rotates the transport epoch and retires every live entry, including one
   * whose settlement is in flight: its respond() then reports expiry instead
   * of «resolved», since the old transport can no longer confirm delivery.
   * The settle closure itself is never called twice.
   */
  expireAll(nextEpoch: string): void {
    this.#epoch = nextEpoch;
    for (const [interactionId, entry] of [...this.#entries]) {
      this.#expireEntry(interactionId, entry, 'Transport epoch changed');
    }
  }

  #expireEntry(interactionId: string, entry: Entry, reason: string): void {
    this.#release(interactionId, entry, 'expired');
    entry.controller.abort(new Error(reason));
  }

  #release(interactionId: string, entry: Entry, outcome: 'resolved' | 'expired'): void {
    entry.state = outcome;
    delete entry.payload;
    this.#entries.delete(interactionId);
    this.#tombstones.delete(interactionId);
    this.#tombstones.set(interactionId, outcome);
    while (this.#tombstones.size > InteractionBroker.MAX_TOMBSTONES) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
  }
}
