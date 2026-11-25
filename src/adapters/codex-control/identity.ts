import { SessionMismatchError, ProviderUnavailableError, SessionNotFoundError } from '../../public/errors.js';
import type { SessionIdentity, SessionPersistence } from '../../public/types.js';

/**
 * Adapter-level thread state. 'unknown' means the provider may still hold the
 * thread (persisted thread whose transport died) and a reconcile/resume is
 * required before any mutation; 'failed' is terminal (ephemeral thread whose
 * process died).
 */
export type CodexThreadState = 'active' | 'unknown' | 'failed' | 'closed';

export interface RegisterThreadInput {
  threadId: string;
  persistence: SessionPersistence;
  cwd: string;
  model?: string;
  forkedFromId?: string;
  toolRegistryHash?: string;
  recovering?: boolean;
}

export interface ThreadDeathTransition {
  threadId: string;
  identity: SessionIdentity;
  state: 'unknown' | 'failed';
}

interface ThreadRecord {
  identity: SessionIdentity;
  state: CodexThreadState;
  toolRegistryHash?: string;
  recovering?: boolean;
}

export class CodexThreadRegistry {
  readonly #epoch: string;
  readonly #threads = new Map<string, ThreadRecord>();

  constructor(options: { epoch: string }) {
    this.#epoch = options.epoch;
  }

  get epoch(): string {
    return this.#epoch;
  }

  register(input: RegisterThreadInput): SessionIdentity {
    const identity: SessionIdentity = Object.freeze({
      schemaVersion: 1,
      provider: 'codex',
      id: input.threadId,
      sessionId: input.threadId,
      transport: 'control',
      transportEpoch: this.#epoch,
      persistence: input.persistence,
      cwd: input.cwd,
      createdAt: new Date().toISOString(),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.forkedFromId === undefined ? {} : { forkedFromId: input.forkedFromId }),
    });
    this.#threads.set(input.threadId, {
      identity,
      state: input.recovering ? 'unknown' : 'active',
      recovering: input.recovering === true,
      ...(input.toolRegistryHash === undefined ? {} : { toolRegistryHash: input.toolRegistryHash }),
    });
    return identity;
  }

  activateRecovered(threadId: string, expected: SessionIdentity, toolRegistryHash: string | undefined): SessionIdentity {
    const record = this.#record(threadId), candidate = record.identity;
    if (!record.recovering || record.state !== 'unknown' || candidate.persistence !== 'provider'
      || candidate.transportEpoch !== this.#epoch || record.toolRegistryHash !== toolRegistryHash
      || ['id', 'provider', 'transport', 'persistence', 'cwd', 'model'].some(key => candidate[key as keyof SessionIdentity] !== expected[key as keyof SessionIdentity])) {
      throw new SessionMismatchError({ provider: 'codex', transport: 'control', retryable: false }, 'Recovery registry binding changed');
    }
    record.identity = Object.freeze({ ...expected, transportEpoch: this.#epoch }); record.state = 'active'; record.recovering = false;
    return record.identity;
  }

  has(threadId: string): boolean {
    return this.#threads.has(threadId);
  }

  identity(threadId: string): SessionIdentity {
    return this.#record(threadId).identity;
  }

  state(threadId: string): CodexThreadState {
    return this.#record(threadId).state;
  }

  toolRegistryHash(threadId: string): string | undefined {
    return this.#record(threadId).toolRegistryHash;
  }

  threadIds(): string[] {
    return [...this.#threads.keys()];
  }

  /** Throws unless the thread exists and is 'active'; mutations (new turns, steer) call this first. */
  assertWritable(threadId: string): void {
    const record = this.#record(threadId);
    if (record.state === 'active') return;
    throw new ProviderUnavailableError(
      { provider: 'codex', transport: 'control', retryable: false },
      record.state === 'unknown'
        ? `Thread ${threadId} is in state 'unknown' after a transport restart; resume/reconcile it before starting new turns`
        : `Thread ${threadId} is ${record.state} and no longer accepts turns`,
    );
  }

  close(threadId: string): void {
    const record = this.#threads.get(threadId);
    if (record) record.state = 'closed';
  }

  /**
   * The control transport died. Persisted threads may survive on disk, so
   * their state becomes 'unknown' (reconcile required, never auto-replayed);
   * process-persistence threads died with the process and become 'failed'.
   */
  markTransportDeath(): ThreadDeathTransition[] {
    const transitions: ThreadDeathTransition[] = [];
    for (const [threadId, record] of this.#threads) {
      if (record.state !== 'active') continue;
      record.state = record.identity.persistence === 'provider' ? 'unknown' : 'failed';
      transitions.push({ threadId, identity: record.identity, state: record.state });
    }
    return transitions;
  }

  #record(threadId: string): ThreadRecord {
    const record = this.#threads.get(threadId);
    if (!record) {
      throw new SessionNotFoundError(
        { provider: 'codex', transport: 'control', retryable: false },
        `Unknown Codex thread ${threadId}`,
      );
    }
    return record;
  }
}
