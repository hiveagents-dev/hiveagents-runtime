/** A constraint the owner pinned. It reaches the model on every turn, outside the conversation. */
export interface PinnedConstraint {
  /** Who it applies to, for example `host` or `system:grow`. */
  scope: string;
  id: string;
  /** Starts at 1 and grows by one with every change, including a revocation. */
  version: number;
  text: string;
  /** Who set this version, as named by the holder of the authority. */
  setBy: string;
  /** Epoch milliseconds. */
  setAt: number;
}

/** Names one exact version of one constraint. */
export interface ConstraintRef {
  scope: string;
  id: string;
  version: number;
}

/** One entry of a constraint's append-only history. */
export interface ConstraintVersion extends PinnedConstraint {
  status: 'active' | 'revoked';
  /** Present on a revocation. */
  reason?: string;
}

/**
 * What a caller knows a constraint had reached. A store that shows less was rolled back:
 * its newest rows were removed, or an older copy of the file was put in its place.
 */
export interface ConstraintExpectation {
  scope: string;
  id: string;
  /** The store must hold this version or a later one. */
  minVersion: number;
  /** The status the caller saw at exactly `minVersion`. A later version may have any status. */
  status?: 'active' | 'revoked';
}

export interface ConstraintWrite {
  scope: string;
  id: string;
  text: string;
  setBy: string;
  /** The version the writer last saw; 0 when the constraint must not exist yet. */
  expectedVersion: number;
}

export interface ConstraintRevocation {
  scope: string;
  id: string;
  setBy: string;
  reason: string;
  /** The version the writer last saw. */
  expectedVersion: number;
}

/** Opens an existing store. Opening never creates anything. */
export interface ConstraintStoreOptions {
  /** Absolute path of the SQLite file. It must already be a store made by `ConstraintStore.create`. */
  databasePath: string;
  /** Public half of the owner's authority. Every row read is verified against it. */
  publicKey: string;
  /** The `id` of the store the caller expects at this path. A file with another id is refused. */
  storeId?: string;
  busyTimeoutMs?: number;
  /** Clock used for `setAt`. */
  now?: () => number;
}

export interface ConstraintStoreCreateOptions {
  /** Absolute path of the SQLite file to make. Nothing may exist there; missing directories are made. */
  databasePath: string;
  busyTimeoutMs?: number;
  /** Clock used for `setAt`. */
  now?: () => number;
}

/** Material for one task. None of it can change a constraint, whatever it says. */
export interface TaskMaterial {
  instructions: string;
  /** Oldest first. The compiler keeps the most recent entries that fit. */
  history?: readonly HistoryEntry[];
  /** In priority order. A reference is carried whole or left out. */
  references?: readonly ContextReference[];
}

export interface HistoryEntry {
  id: string;
  role: 'user' | 'agent' | 'tool';
  text: string;
}

export interface ContextReference {
  id: string;
  title: string;
  text: string;
}

export interface ContextBudget {
  /** UTF-8 bytes for the pinned channel plus the task prompt. */
  maxBytes: number;
}

/**
 * The constraints of one call, ready for the provider's instruction channel.
 * Only `compileContext` makes one, and only from verified rows of a `ConstraintStore`.
 */
export interface PinnedChannel {
  /** Empty when no constraint is active in the requested scopes. */
  readonly text: string;
  /** Every constraint version in `text`, with its provenance. */
  readonly carried: readonly Omit<PinnedConstraint, 'text'>[];
  /** SHA-256 of `text`. */
  readonly digest: string;
}

export interface CompiledContext {
  /** Never trimmed and never part of `prompt`. */
  readonly pinned: PinnedChannel;
  /**
   * The newest version of every constraint in the requested scopes, revoked ones included.
   * Keep it where agents cannot write and pass it as `require` on the next call.
   */
  readonly seen: readonly Required<ConstraintExpectation>[];
  /** Task instructions, references and selected history. */
  readonly prompt: string;
  readonly included: { readonly history: readonly string[]; readonly references: readonly string[] };
  readonly omitted: { readonly history: readonly string[]; readonly references: readonly string[] };
  readonly bytes: { readonly pinned: number; readonly prompt: number; readonly budget: number };
}

/** The writer does not hold the authority of this store. */
export class ConstraintAuthorityError extends Error {
  override readonly name = 'ConstraintAuthorityError';
}

/** The constraint changed since the writer last read it, or a file already exists where a store was to be made. */
export class ConstraintConflictError extends Error {
  override readonly name = 'ConstraintConflictError';
}

/**
 * The store cannot be trusted for this call: a row does not verify against the owner's public
 * key, the file is missing or is another store, or it holds less than the caller had seen.
 * Do not run the turn.
 */
export class ConstraintIntegrityError extends Error {
  override readonly name = 'ConstraintIntegrityError';
}

/** The pinned constraints and the task instructions do not fit; neither is ever trimmed. */
export class ContextBudgetError extends Error {
  override readonly name = 'ContextBudgetError';
}

/** The provider has no verified channel for pinned constraints in this kind of turn. */
export class UnverifiedPinnedChannelError extends Error {
  override readonly name = 'UnverifiedPinnedChannelError';
}

/** No constraint was active for the turn and the caller did not say that is expected. */
export class NothingPinnedError extends Error {
  override readonly name = 'NothingPinnedError';
}
