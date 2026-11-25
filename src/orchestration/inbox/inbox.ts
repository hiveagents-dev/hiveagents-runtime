import { mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { armBell } from '../budget/bell.js';
import { hostLedgerPath } from '../budget/host-options.js';
import { absolutePath, busyTimeout, integer } from '../budget/validation.js';
import { InboxInputError, declareDisplay, inboxIdentifier } from './action.js';
import { InboxEngine, MAX_APPROVAL_LIFETIME_MS, closedInput, type InboxFilingLimits } from './engine.js';
import type {
  InboxApproveInput, InboxApproved, InboxConsumeInput, InboxConsumed, InboxDisplayField, InboxFiled, InboxItem, InboxRejectInput, InboxRejected,
  InboxRequestInput, InboxResult, InboxStatus, InboxWaitOptions, InboxWithdrawInput, OwnerInboxOptions, SystemInboxOptions,
} from './types.js';

const DEFAULT_BUSY_TIMEOUT_MS = 1000;
const DEFAULT_MAX_OPEN_REQUESTS = 100;
const DEFAULT_MAX_FILED_PER_HOUR = 200;
const DEFAULT_APPROVAL_LIFETIME_MS = 3_600_000;
const MAX_DECLARED_ACTIONS = 256;
/** Longest sleep between two looks at the file while waiting, should a change hint be lost. */
const BACKSTOP_MS = 30_000;
/** How soon a waiter looks again after finding the file held by another process. */
const BUSY_RETRY_MS = 250;

/**
 * Where the machine's one decision inbox lives: next to the shared admission ledger, so every
 * system and the console find the same file. `OAR_HOST_INBOX` overrides it with an absolute path.
 */
export function hostInboxPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.OAR_HOST_INBOX !== undefined) {
    absolutePath(env.OAR_HOST_INBOX);
    return env.OAR_HOST_INBOX;
  }
  return join(dirname(hostLedgerPath(env, platform)), 'inbox.sqlite');
}

/** A file that is rewritten whenever the inbox changes. Watch it instead of polling the inbox. */
export function inboxBellPath(databasePath: string): string {
  absolutePath(databasePath);
  return `${databasePath}.bell`;
}

function openEngine(options: { databasePath?: string; busyTimeoutMs?: number; now?: () => number }): InboxEngine {
  // Every option is checked before anything touches the disk.
  busyTimeout(options.busyTimeoutMs);
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function that returns epoch milliseconds');
  const databasePath = options.databasePath === undefined ? hostInboxPath() : options.databasePath;
  absolutePath(databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const engine = new InboxEngine({
    databasePath,
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    now: options.now ?? Date.now,
  });
  // A path that was refused (a foreign or empty file, a link) gets nothing created beside it.
  if (!engine.usable) return engine;
  try {
    closeSync(openSync(engine.bellPath, 'a', 0o600));
  } catch {
    // Without the bell file a waiter still wakes at its backstop.
  }
  return engine;
}

function plainOptions(options: unknown, required: readonly string[], optional: readonly string[]): void {
  try {
    closedInput(options, required, optional);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : 'Invalid inbox options');
  }
}

/**
 * A system's side of the inbox: it asks, waits and uses approvals, and can do nothing else.
 * It cannot approve, and it cannot see or touch another system's requests.
 *
 * This coordinates cooperating local processes. It is not a security boundary against a process
 * that can write the file directly; keeping agents away from the file is the containment's job.
 *
 * Every call answers with a result. `busy` means another process held the file for longer than
 * `busyTimeoutMs` and nothing changed: the caller decides when to try again.
 */
export class SystemInbox {
  readonly systemId: string;
  readonly #engine: InboxEngine;
  readonly #declared: ReadonlyMap<string, readonly InboxDisplayField[]>;
  readonly #limits: InboxFilingLimits;
  readonly #waits = new Set<() => void>();
  #closed = false;

  /** Throws `TypeError` for a configuration mistake, before creating any file. */
  constructor(options: SystemInboxOptions) {
    plainOptions(options, ['systemId', 'irreversibleActions', 'display'], ['databasePath', 'busyTimeoutMs', 'now', 'maxOpenRequests', 'maxFiledPerHour']);
    try {
      this.systemId = inboxIdentifier(options.systemId, 'systemId');
      const actions: unknown = options.irreversibleActions;
      if (!Array.isArray(actions) || actions.length > MAX_DECLARED_ACTIONS) throw new InboxInputError('irreversibleActions must be a list of action kinds');
      const kinds = new Set(actions.map((kind: unknown) => inboxIdentifier(kind, 'irreversibleActions[]')));
      const display = closedInput(options.display, [...kinds]);
      this.#declared = new Map([...kinds].map((kind) => [kind, declareDisplay(display[kind], `display.${kind}`)]));
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : 'Invalid inbox options');
    }
    const maxOpen = options.maxOpenRequests ?? DEFAULT_MAX_OPEN_REQUESTS;
    if (!integer(maxOpen, 1) || maxOpen > 10_000) throw new TypeError('maxOpenRequests must be an integer from 1 to 10000');
    const maxFiledPerHour = options.maxFiledPerHour ?? DEFAULT_MAX_FILED_PER_HOUR;
    if (!integer(maxFiledPerHour, 1) || maxFiledPerHour > 100_000) throw new TypeError('maxFiledPerHour must be an integer from 1 to 100000');
    this.#limits = { maxOpen, maxFiledPerHour };
    this.#engine = openEngine(options);
  }

  /**
   * Asks a person to allow one irreversible action. The card shows the lines this system declared
   * for that action kind, each read from this payload; a payload that lacks one of them is
   * refused. Asking again for an action that already has an open request returns that request, so
   * a retry after a crash never adds a second card.
   */
  request(input: InboxRequestInput): InboxResult<InboxFiled> {
    return this.#engine.file(this.systemId, this.#declared, this.#limits, input);
  }

  /**
   * Uses the approval for the action about to be executed, at most once across every process.
   * Call it immediately before executing, with the action rebuilt from what will really run:
   * if it differs in any field from the approved one, the answer is `action-changed`.
   * After `ok`, the approval is spent even if the caller then fails to execute.
   */
  consume(input: InboxConsumeInput): InboxResult<InboxConsumed> {
    return this.#engine.consume(this.systemId, input);
  }

  /** Gives up a request this system no longer needs. */
  withdraw(input: InboxWithdrawInput): InboxResult<{ status: 'withdrawn' }> {
    return this.#engine.withdraw(this.systemId, input);
  }

  /**
   * Everything stored about one of this system's requests, including who changed it and when.
   * Like every call here it takes the file's write lock for a moment (it records due expiries),
   * so it can answer `busy`: nothing changed, ask again.
   */
  inspect(requestId: string): InboxResult<{ item: InboxItem }> {
    return this.#engine.inspect(requestId, this.systemId);
  }

  /**
   * Resolves as soon as the request stops being pending (a person answered, the system withdrew
   * it, or its own deadline passed), or with `pending` once `maxWaitMs` have passed. It sleeps on
   * the inbox's change hint and wakes by itself only at the request's deadline, not on a polling
   * timer. While another process holds the file it looks again every quarter of a second, and
   * answers `busy` only if the file is still held when the time is up. Rejects only if `signal`
   * aborts.
   */
  async waitForDecision(requestId: string, options: InboxWaitOptions): Promise<InboxResult<{ status: InboxStatus }>> {
    if (options === null || typeof options !== 'object' || !integer(options.maxWaitMs)
      || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new TypeError('Wait options require a non-negative integer maxWaitMs and an optional AbortSignal');
    }
    const { maxWaitMs, signal } = options;
    const deadline = performance.now() + maxWaitMs;
    for (;;) {
      signal?.throwIfAborted();
      // Arm before reading, so a change between the read and the sleep still wakes this waiter.
      const bell = armBell(this.#engine.bellPath, signal);
      this.#waits.add(bell.cancel);
      try {
        if (maxWaitMs > 0) {
          // A file watch only starts listening once the event loop turns.
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          signal?.throwIfAborted();
        }
        const read = this.#engine.inspect(requestId, this.systemId);
        const remaining = deadline - performance.now();
        if (!read.ok) {
          // A held file says nothing about the request, so it does not end the wait.
          if (read.reason !== 'busy' || remaining <= 0 || this.#closed) return read;
          await bell.wait(Math.min(remaining, BUSY_RETRY_MS));
          continue;
        }
        if (read.item.status !== 'pending' || remaining <= 0 || this.#closed) return { ok: true, status: read.item.status };
        const expiresAt = read.item.expiresAt;
        const untilExpiry = expiresAt === null ? BACKSTOP_MS : Math.max(1, expiresAt - this.#engine.now() + 1);
        await bell.wait(Math.min(remaining, untilExpiry, BACKSTOP_MS));
      } finally {
        bell.cancel();
        this.#waits.delete(bell.cancel);
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.#engine.close();
    for (const cancel of this.#waits) cancel();
    this.#waits.clear();
  }
}

/**
 * The person's side of the inbox: approve or reject what the systems asked. The console's main
 * process holds it; no system process should.
 */
export class OwnerInbox {
  readonly #engine: InboxEngine;
  readonly #approvalLifetimeMs: number;

  /** Throws `TypeError` for a configuration mistake, before creating any file. */
  constructor(options: OwnerInboxOptions = {}) {
    plainOptions(options, [], ['databasePath', 'busyTimeoutMs', 'now', 'approvalLifetimeMs']);
    const lifetime = options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
    if (!integer(lifetime, 1000) || lifetime > MAX_APPROVAL_LIFETIME_MS) {
      throw new TypeError('approvalLifetimeMs must be an integer from one second to thirty days, in milliseconds');
    }
    this.#approvalLifetimeMs = lifetime;
    this.#engine = openEngine(options);
  }

  /**
   * Approves exactly the action whose hash is given, for one use and for a limited time: until
   * `expiresAt`, or for the inbox's default lifetime (one hour unless configured). A hash other
   * than the stored one approves nothing: the person can only approve what they were shown.
   */
  approve(input: InboxApproveInput): InboxResult<InboxApproved> {
    return this.#engine.approve(input, this.#approvalLifetimeMs);
  }

  /**
   * Rejects a pending request for good, or takes back an approval that was given and not used
   * yet. If a system already used the approval, the answer is `already-used`.
   */
  reject(input: InboxRejectInput): InboxResult<InboxRejected> {
    return this.#engine.reject(input);
  }

  /** Everything stored about one request of any system. */
  inspect(requestId: string): InboxResult<{ item: InboxItem }> {
    return this.#engine.inspect(requestId);
  }

  /** Records as expired every request whose deadline has passed. */
  sweep(): InboxResult<{ expired: number }> {
    return this.#engine.sweep();
  }

  close(): void {
    this.#engine.close();
  }
}
