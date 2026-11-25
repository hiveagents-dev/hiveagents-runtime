import type { ManagedEffectAssociation } from '../log/execution-types.js';

/** Strict JSON, as stored. No undefined, no functions, no class instances. */
export type InboxJson = null | boolean | number | string | readonly InboxJson[] | { readonly [key: string]: InboxJson };
export type InboxJsonObject = { readonly [key: string]: InboxJson };

/**
 * `pending` waits for a person. `approved` may be used exactly once, until its deadline. The other
 * four are final: `consumed` (the approval was used), `rejected` (a person said no, or took back
 * an approval nobody had used yet), `expired` (nobody answered, or the approval was not used in
 * time) and `withdrawn` (the system no longer needs it).
 */
export type InboxStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn' | 'consumed';

/**
 * One line of the card: a label and the place in the payload the value is read from. A system
 * declares its lines once per action kind when it opens the inbox; a request cannot bring its own.
 * The value itself always comes from the exact payload the approval is bound to.
 */
export interface InboxDisplayField {
  label: string;
  /** Keys (or array indexes, as decimal strings) from the payload root to the value. */
  path: readonly string[];
}

/** The exact thing a person approves. Any difference in any field is a different action. */
export interface InboxAction {
  systemId: string;
  /** One of the irreversible actions the system declared. */
  actionKind: string;
  payload: InboxJsonObject;
  /** The effect in the neutral log this action will run as: run identity and idempotency key. */
  effect?: ManagedEffectAssociation;
}

export interface InboxRequestInput {
  actionKind: string;
  payload: InboxJsonObject;
  /** Who files it, for the record: for example `grow:run-12`. It is never drawn on the card. */
  requestedBy: string;
  effect?: ManagedEffectAssociation;
  /** Epoch ms after which an unanswered request expires. Omit for no deadline. */
  expiresAt?: number;
}

export interface InboxConsumeInput {
  requestId: string;
  /** The action about to be executed, rebuilt by the caller at execution time. */
  actionKind: string;
  payload: InboxJsonObject;
  effect?: ManagedEffectAssociation;
  /** Who executes, for the record. */
  by: string;
}

export interface InboxApproveInput {
  requestId: string;
  /** The hash of the action the person was shown. It must match the stored one. */
  actionHash: string;
  by: string;
  /**
   * Epoch ms after which an unused approval expires, at most thirty days ahead. Omit for the
   * inbox's default lifetime: no approval is open-ended.
   */
  expiresAt?: number;
}

export interface InboxRejectInput {
  requestId: string;
  by: string;
  /** The person's own words, kept for the record. */
  reason?: string;
}

export interface InboxWithdrawInput {
  requestId: string;
  by: string;
  reason?: string;
}

export type InboxRefusal =
  | 'invalid-input'
  /** The action kind is not one of the system's declared irreversible actions. */
  | 'undeclared-action'
  /** The system already has as many open requests as it is allowed. */
  | 'queue-full'
  /** The system filed as many requests in the last hour as it is allowed. Nothing was stored. */
  | 'rate-limited'
  | 'unknown-request'
  /** The action presented differs from the one the approval is bound to. */
  | 'action-changed'
  | 'not-pending'
  | 'not-approved'
  /** The approval was already used once. */
  | 'already-used'
  | 'rejected'
  | 'expired'
  | 'withdrawn'
  /** A stored request no longer matches its own hash. */
  | 'integrity'
  /** Another process held the file for longer than `busyTimeoutMs`. Nothing changed: try again. */
  | 'busy'
  | 'storage-unavailable'
  | 'closed';

export interface InboxFailure {
  ok: false;
  reason: InboxRefusal;
  detail?: string;
  /** The request's status when the refusal depends on it. */
  status?: InboxStatus;
}

export type InboxResult<T> = ({ ok: true } & T) | InboxFailure;

/** One recorded change of state: what changed, who did it and when. */
export interface InboxTransition {
  sequence: number;
  from: InboxStatus | null;
  to: InboxStatus;
  by: string;
  at: number;
  note?: string;
}

/** The last attempt to use an approval that was refused. Refusals never change the state. */
export interface InboxRefusedUse {
  at: number;
  by: string;
  reason: InboxRefusal;
}

/** Everything stored about one request. */
export interface InboxItem {
  requestId: string;
  systemId: string;
  actionKind: string;
  actionHash: string;
  payload: InboxJsonObject;
  display: readonly InboxDisplayField[];
  effect?: ManagedEffectAssociation;
  status: InboxStatus;
  requestedAt: number;
  expiresAt: number | null;
  approvalExpiresAt: number | null;
  refusedUses: number;
  lastRefusedUse?: InboxRefusedUse;
  transitions: readonly InboxTransition[];
}

export interface InboxFiled {
  requestId: string;
  actionHash: string;
  status: InboxStatus;
  /** False when the same action already had an open request, which is returned instead. */
  created: boolean;
}

export interface InboxConsumed {
  consumedAt: number;
  approvedBy: string;
  approvedAt: number;
  approvalExpiresAt: number | null;
}

export interface InboxApproved {
  status: 'approved';
  /** When the approval stops being usable if nobody used it. */
  approvalExpiresAt: number;
}

export interface InboxRejected {
  status: 'rejected';
  /** True when this took back an approval that had been given and not used. */
  wasApproved: boolean;
}

export interface InboxWaitOptions {
  /** Zero answers at once with the current status. */
  maxWaitMs: number;
  signal?: AbortSignal;
}

interface InboxCommonOptions {
  /** Absolute path of the shared file. Defaults to `hostInboxPath()`. */
  databasePath?: string;
  /** Longest synchronous wait for another process's write. Default 1000 ms. */
  busyTimeoutMs?: number;
  /** Clock in epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

export interface SystemInboxOptions extends InboxCommonOptions {
  systemId: string;
  /** The irreversible actions this system declared in its manifest. Nothing else can be filed. */
  irreversibleActions: readonly string[];
  /**
   * The card of each declared action: one to eight lines, each a short visible label and the
   * place in the payload its value is read from. Every declared action needs its lines, and they
   * are fixed here, by the system's code: no request can word its own card.
   */
  display: Readonly<Record<string, readonly InboxDisplayField[]>>;
  /** Most requests this system may have open (pending or approved) at once. Default 100. */
  maxOpenRequests?: number;
  /**
   * Most new requests this system may file in any hour, open or closed. Default 200. It bounds
   * how fast a system stuck in a loop can grow the shared file.
   */
  maxFiledPerHour?: number;
}

export interface OwnerInboxOptions extends InboxCommonOptions {
  /**
   * How long an approval stays usable when the person gives no deadline. Default one hour, from
   * one second to thirty days. A system that was down for longer has to ask again.
   */
  approvalLifetimeMs?: number;
}

/** A line of a card, already resolved to text. */
export interface InboxCardField {
  label: string;
  value: string;
  /** Set when the value was too long to show in full. */
  cut?: true;
}

/** What a person needs to decide, built only from stored structured fields. */
export interface InboxCard {
  requestId: string;
  systemId: string;
  actionKind: string;
  actionHash: string;
  requestedAt: number;
  requestedBy: string;
  expiresAt: number | null;
  fields: readonly InboxCardField[];
  /** Single values of the payload, at any depth, that no line of the card shows. */
  hiddenFields: number;
  /** Lines whose value was too long and is shown cut. */
  cutFields: number;
  /** Where to find the effect in the neutral log, when the request names one. */
  effect?: { runId: string; agentId: string; effectKey: string };
}

/** A request that no longer waits for a person, with its last change. */
export interface InboxOutcome extends InboxCard {
  status: Exclude<InboxStatus, 'pending'>;
  at: number;
  by: string;
  note?: string;
  /** True when a person approved it at some point, whatever happened afterwards. */
  wasApproved: boolean;
  /** When the approval runs out or ran out; null when it was never approved. */
  approvalExpiresAt: number | null;
}

export type InboxView =
  | {
    ok: true;
    readAt: number;
    /** Every system's pending requests in one list, oldest first. */
    pending: readonly InboxCard[];
    /** How many are pending in total; larger than `pending.length` when the list was cut. */
    pendingTotal: number;
    /** Latest changes first. */
    recent: readonly InboxOutcome[];
    /** Stored requests that no longer match their own hash and are therefore not shown. */
    damaged: number;
  }
  | { ok: false; reason: 'absent' | 'unrecognized' | 'unavailable' };

export interface InboxViewOptions {
  now?: number;
  /** Default 100, at most 500. */
  pendingLimit?: number;
  /** Default 20, at most 200. */
  recentLimit?: number;
}
