import type { ModelInfo, ProviderId, TransportKind, Turn } from './types.js';

/**
 * Per-agent memory: the public contract.
 *
 * Memory is an application resource. The SDK never stores, embeds or ranks
 * anything itself here: it asks the application's provider for a few recalled
 * items before a turn, carries them to the model as reference data (never as
 * instructions), and, only when asked, hands the completed turn back to the
 * provider afterwards. Every step is opt-in and fail-open: a provider that
 * fails or is slow never fails the turn, and the turn records what happened.
 *
 * The scope is chosen by the application and is never derived from anything
 * the model wrote. It has the same shape as the orchestration memory ports'
 * `MemoryScope`, so a port implementation can serve it directly.
 */
export interface AgentMemoryScope {
  readonly tenant: string;
  readonly namespace: string;
  readonly subject?: string;
}

/** What the provider is asked before one turn. */
export interface MemoryRecallRequest {
  readonly scope: AgentMemoryScope;
  /** The turn's user text (text items joined); never includes earlier recalled blocks. */
  readonly text: string;
  readonly provider: ProviderId;
  readonly transport: TransportKind;
  readonly cwd: string;
  /** Upper bound the SDK will carry; a provider may return fewer, never needs to return more. */
  readonly limit: number;
  /** Aborted when the recall deadline passes or the turn is cancelled. */
  readonly signal: AbortSignal;
}

/**
 * One recalled item. Its text is data the model may read, not an instruction it must follow.
 * The SDK drops (and counts in `omitted`) an item whose `id` or `source` is empty, longer than
 * 256 characters, or contains a line break, a control character or an invisible format
 * character (zero-width, bidi override, tag), and an `id` or `source` with any opening or closing
 * punctuation after NFKC normalization (Unicode `Ps`/`Pe`: square brackets and their fullwidth or
 * other look-alikes, parentheses, braces, and the square-bracket pieces U+23A1-U+23A6, U+23B4-U+23B5), since they sit between brackets on the SDK-owned item
 * header; whose `observedAt` is longer than 64 characters or is not a strict ISO-8601 date and
 * time with an offset (`YYYY-MM-DDTHH:MM[:SS[.fraction]]` then `Z` or `±HH:MM`); whose `text` is
 * empty, contains NUL or is only tag characters; or whose id repeats an earlier item's. A
 * `title` that breaks the `id` rules is left out and the item kept. Tag characters are removed
 * from the text, and `observedAt` is carried as `Date.prototype.toISOString()` gives it. The
 * exported `recallableMemory` applies exactly these rules.
 */
export interface RecalledMemory {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  /** Provenance label shown to the model and recorded on the turn, e.g. `sqlite-system-memory`. */
  readonly source: string;
  /** Strict ISO-8601 time the remembered fact was observed, when the provider knows it; carried in UTC. */
  readonly observedAt?: string;
}

/** What the provider receives after a completed turn, only when `MemoryOption.capture` is true. */
export interface MemoryCaptureRequest {
  readonly scope: AgentMemoryScope;
  /** The user text of the turn, without the recalled block the SDK prepended. */
  readonly input: string;
  readonly turn: Turn;
  /** ISO-8601 time the SDK delivered the completed turn; stable for a retried capture of the same request. */
  readonly completedAt: string;
  /** Aborted after `MEMORY_CAPTURE_TIMEOUT_MS`. */
  readonly signal: AbortSignal;
}

/**
 * An application's memory backend for agents. Every method is optional: a
 * read-only memory implements `recall`, a recorder implements `capture`.
 * `AgentOptions.memory` needs `recall`, `capture` or `profile` (a provider with
 * only `propose` is a TypeError there: it serves only the memory tools).
 * Implementations must be safe to share between agents and sessions; per-call
 * identity arrives in the request, never in the provider instance.
 */
export interface AgentMemoryProvider {
  /**
   * Stable label recorded on every turn note, e.g. `sqlite-system-memory` or `agentdb`. It is the
   * source on the `### Profile [source: <id>]` header, so `AgentOptions.memory` refuses an id that
   * breaks the item id rules (see `RecalledMemory`), brackets and other opening or closing punctuation included.
   */
  readonly id: string;
  recall?(request: MemoryRecallRequest): Promise<readonly RecalledMemory[]>;
  capture?(request: MemoryCaptureRequest): Promise<void>;
  /**
   * The scope's fixed profile: a short text the application maintains (who the user is, the
   * project's conventions). Carried on every turn before the recalled items, under its own
   * budget. Only the application writes it; nothing an agent does reaches it. Asked in parallel
   * with `recall`, under the same deadline and signal, and just as fail-open; undefined means the
   * scope has no profile. The exported `profileText` applies the SDK's rules to the text.
   */
  profile?(request: MemoryProfileRequest): Promise<string | undefined>;
  /**
   * Stores something the agent proposes to remember, through a memory tool. A proposal is a
   * candidate, never recallable until the application promotes it; the result names it. Throw a
   * `TypeError` to refuse a proposal as written (e.g. over the store's size bound): the tool
   * reports `INVALID_INPUT` with the SDK's own message; any other error is `PROVIDER_FAILED`.
   */
  propose?(request: MemoryProposeRequest): Promise<{ readonly id: string }>;
}

/** What the provider is asked for the scope's profile, once per turn. */
export interface MemoryProfileRequest {
  readonly scope: AgentMemoryScope;
  readonly provider: ProviderId;
  readonly transport: TransportKind;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

/** A memory the agent proposes through a memory tool; untrusted model output. */
export interface MemoryProposeRequest {
  readonly scope: AgentMemoryScope;
  readonly text: string;
  readonly title?: string;
  /** Where the proposal came from, e.g. `memory-tool` or `mcp:<server name>`. */
  readonly origin: string;
  readonly signal: AbortSignal;
}

/** Defaults and ceilings of the memory option. */
export const MEMORY_DEFAULT_MAX_ITEMS = 2;
export const MEMORY_MAX_ITEMS_CEILING = 8;
export const MEMORY_DEFAULT_MAX_BYTES = 8 * 1024;
export const MEMORY_MAX_BYTES_CEILING = 32 * 1024;
export const MEMORY_DEFAULT_RECALL_TIMEOUT_MS = 2_000;
/** Profile budget: UTF-8 bytes of the profile section as rendered (see `MemoryOption.maxProfileBytes`). */
export const MEMORY_DEFAULT_MAX_PROFILE_BYTES = 2 * 1024;
export const MEMORY_MAX_PROFILE_BYTES_CEILING = 8 * 1024;
/** Bound on one background capture, and on how long `close()` waits for pending captures. */
export const MEMORY_CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Opt-in per-agent memory, set on `AgentOptions.memory` (or as a Runtime
 * default). Its absence changes nothing.
 */
export interface MemoryOption {
  readonly provider: AgentMemoryProvider;
  readonly scope: AgentMemoryScope;
  /** Recalled items carried per turn: default 2, at most 8. */
  readonly maxItems?: number;
  /**
   * UTF-8 bytes of the recalled items carried per turn, as rendered: every kept item's header,
   * title line and indented text lines count, datamarked (each whitespace run inside a line is
   * U+02C6, 2 bytes); only the block's fixed heading, preamble and end
   * marker do not. Default 8 KiB, at least 256, at most 32 KiB. Items are whole or left out.
   */
  readonly maxBytes?: number;
  /**
   * Recall deadline; on expiry the turn runs without memory. Default 2000 ms. A turn with its own
   * `timeoutMs` gives recall at most a quarter of it, and keeps the rest for itself.
   */
  readonly recallTimeoutMs?: number;
  /**
   * UTF-8 bytes of the profile carried per turn (only read when the provider implements `profile`),
   * as rendered: its `### Profile [source: <provider id>]` header, every indented line and the
   * blank line after them. Default 2 KiB (`MEMORY_DEFAULT_MAX_PROFILE_BYTES`), at least 64, at most
   * 8 KiB (`MEMORY_MAX_PROFILE_BYTES_CEILING`). It is a budget of its own: the profile never takes
   * room from `maxBytes`. A profile that does not fit is left out whole, never truncated (a cut
   * could keep half a rule). To carry no profile, use a provider without `profile`.
   */
  readonly maxProfileBytes?: number;
  /**
   * Hand each completed turn to `provider.capture`, in the background, after the result is
   * delivered. Default false: recall-only; true needs a provider with `capture` (a TypeError
   * otherwise). `Session.close()` and `Agent.close()` wait for pending captures, each bounded by
   * `MEMORY_CAPTURE_TIMEOUT_MS`; an exec fork's first-turn capture belongs to the child session.
   */
  readonly capture?: boolean;
  /**
   * Receives capture failures, which never fail the turn. Without it a failure is a process
   * warning (code `OAR_MEMORY_CAPTURE_FAILED`), at most one a minute per Agent memory. The callback
   * receives the original error. Process warnings and recall/profile notes omit backend error text.
   */
  readonly onCaptureError?: (error: unknown) => void;
}

/** What a Runtime-wide default needs to pick a stable scope for each Agent it builds. */
export interface MemoryScopeContext {
  readonly model: ModelInfo;
  /** The cwd the Agent was given, before readiness resolves it; undefined means process.cwd(). */
  readonly cwd?: string;
}

/** Runtime-wide default: every Agent of the Runtime gets memory unless it sets `memory: false`. */
export interface RuntimeMemoryDefault extends Omit<MemoryOption, 'scope'> {
  readonly scope: (context: MemoryScopeContext) => AgentMemoryScope;
}

/**
 * What happened to the scope's profile on one turn; on the turn note only when the provider
 * implements `profile`. `carried`: in the block, `bytes` as rendered (never more than
 * `maxProfileBytes`). `absent`: the provider returned undefined. `omitted`: usable but over
 * `maxProfileBytes`, left out whole. `failed`: it threw, timed out (it shares the recall deadline
 * and signal) or returned something that is not a usable text: not a string, empty or only
 * whitespace once tag characters are removed, or containing NUL. `omitted` and `failed` also add
 * a `MEMORY_PROFILE_UNAVAILABLE` warning; neither changes what recall does or how it is recorded.
 */
export type MemoryProfileNote =
  | { status: 'carried'; bytes: number }
  | { status: 'absent' }
  | { status: 'omitted'; reason: string; bytes?: number }
  | { status: 'failed'; reason: string };

/**
 * What one turn did with memory; found in `Turn.providerMetadata.memory`, recorded before a
 * required log capture sees the turn, so the logged and the returned turn are the same. The
 * `profile` field is there only when the provider implements `profile`; when the profile is
 * carried the block exists even if no item was recalled.
 */
export type MemoryTurnNote =
  | {
      status: 'recalled';
      provider: string;
      /** The carried items; `bytes` is each one as rendered (header, title and indented text). */
      items: ReadonlyArray<{ id: string; source: string; bytes: number }>;
      /** Items the provider returned that were malformed, repeated, or did not fit the item or byte budget. */
      omitted: number;
      /** The items' rendered bytes together: never more than `maxBytes`. The profile is not counted here. */
      bytes: number;
      capture: boolean;
      profile?: MemoryProfileNote;
    }
  /** The provider returned no items, or has no `recall`. */
  | { status: 'empty'; provider: string; capture: boolean; profile?: MemoryProfileNote }
  /**
   * The turn ran without recalled items: the recall threw, timed out or returned something that
   * is not a list, or every returned item was malformed or over budget. Also a `MEMORY_UNAVAILABLE`
   * warning. A carried profile still reaches the turn. A turn cancelled while recall ran does not
   * run at all, so it has no note.
   */
  | { status: 'failed'; provider: string; reason: string; capture: boolean; profile?: MemoryProfileNote };
