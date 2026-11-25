import { TimeoutError } from '../public/errors.js';
import {
  MEMORY_CAPTURE_TIMEOUT_MS, MEMORY_DEFAULT_MAX_BYTES, MEMORY_DEFAULT_MAX_ITEMS, MEMORY_DEFAULT_MAX_PROFILE_BYTES,
  MEMORY_DEFAULT_RECALL_TIMEOUT_MS, MEMORY_MAX_BYTES_CEILING, MEMORY_MAX_ITEMS_CEILING, MEMORY_MAX_PROFILE_BYTES_CEILING,
  type AgentMemoryProvider, type AgentMemoryScope, type MemoryOption, type MemoryProfileNote, type MemoryScopeContext,
  type MemoryTurnNote, type RecalledMemory, type RuntimeMemoryDefault,
} from '../public/memory-types.js';
import { isMemoryHeaderLabel, isMemoryLabel, profileText, recallableMemory } from '../public/memory-items.js';
import type { AgentInput, ProviderId, RuntimeWarning, TransportKind, Turn } from '../public/types.js';
import { renderItem, renderMemoryBlock, renderProfile, withBlock, type CarriedProfile } from './memory-block.js';

export { MEMORY_CAPTURE_TIMEOUT_MS };
export { MEMORY_BLOCK_END, renderMemoryBlock } from './memory-block.js';
const MAX_RECALL_TIMEOUT_MS = 60_000;
const MIN_MAX_BYTES = 256;
const MIN_MAX_PROFILE_BYTES = 64;
const LABEL_MAX = 256;
const KEYS = ['provider', 'scope', 'maxItems', 'maxBytes', 'maxProfileBytes', 'recallTimeoutMs', 'capture', 'onCaptureError'];
/** A turn with its own deadline lends recall at most this share of it, and keeps the rest. */
const RECALL_SHARE_OF_TURN = 0.25;
/** Without `onCaptureError`, at most one process warning per Agent memory in this interval. */
const CAPTURE_WARNING_INTERVAL_MS = 60_000;

/** Where the turn runs, as the recall request reports it. */
export interface MemoryTurnContext {
  provider: ProviderId;
  transport: TransportKind;
  cwd: string;
}

/** One turn's recall: the input the CLI receives and what memory did, for the session to record. */
export interface RecalledTurn {
  /** The turn input with the recalled block prepended, or the original input when nothing was recalled. */
  readonly input: AgentInput;
  /** Recorded on the turn by the session that completes it, before any log capture sees the turn. */
  readonly note: MemoryTurnNote;
  /**
   * Schedules the capture of a completed turn once, owned by `owner` (the session whose `close()`
   * waits for it), and returns the turn unchanged.
   */
  finish(turn: Turn, owner: object): Turn;
}

interface Kept { item: RecalledMemory; bytes: number }
/** A provider call that settled: its value, or why there is none. Never a rejection. */
type Settled = { value: unknown } | { reason: string };
/** What the profile read gave: the note's `profile` field and, when carried, the profile itself. */
interface ProfileRead { note: MemoryProfileNote; profile?: CarriedProfile }

/** The share of a turn's own deadline that recall may use; undefined when the turn has none. */
export function recallShare(turnTimeoutMs: number | undefined): number | undefined {
  return turnTimeoutMs === undefined ? undefined : Math.max(1, Math.floor(turnTimeoutMs * RECALL_SHARE_OF_TURN));
}

function invalid(message: string): never { throw new TypeError(message); }

function closed(value: unknown, keys: readonly string[], field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`);
  const unknown = Reflect.ownKeys(value).find((key) => typeof key !== 'string' || !keys.includes(key));
  if (unknown !== undefined) invalid(`${field} has an unknown field ${String(unknown)}`);
}

function isLabel(value: unknown, max = LABEL_MAX): value is string { return isMemoryLabel(value, max); }

function label(value: unknown, field: string): asserts value is string {
  if (!isLabel(value)) invalid(`${field} must be a non-empty single-line string of at most ${LABEL_MAX} characters`);
}

function bounded(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function scopeOf(value: unknown): AgentMemoryScope {
  closed(value, ['tenant', 'namespace', 'subject'], 'memory.scope');
  label(value.tenant, 'memory.scope.tenant');
  label(value.namespace, 'memory.scope.namespace');
  if (value.subject !== undefined) label(value.subject, 'memory.scope.subject');
  return Object.freeze({ tenant: value.tenant, namespace: value.namespace, ...(value.subject === undefined ? {} : { subject: value.subject }) });
}

function providerOf(value: unknown): AgentMemoryProvider {
  if (typeof value !== 'object' || value === null) invalid('memory.provider must be an object');
  const provider = value as Partial<Record<keyof AgentMemoryProvider, unknown>>;
  label(provider.id, 'memory.provider.id');
  // The id is the source on the SDK-owned `### Profile [source: <id>]` header: the item id and source rule applies.
  if (!isMemoryHeaderLabel(provider.id)) invalid('memory.provider.id must not contain brackets or other opening or closing punctuation');
  for (const method of ['recall', 'capture', 'profile', 'propose'] as const) {
    if (provider[method] !== undefined && typeof provider[method] !== 'function') invalid(`memory.provider.${method} must be a function`);
  }
  if (provider.recall === undefined && provider.capture === undefined && provider.profile === undefined) {
    // `propose` serves only the memory tools (memoryTools, serveMemoryMcp); alone it does nothing for a turn.
    invalid(provider.propose === undefined
      ? 'memory.provider needs a recall, a capture or a profile function'
      : 'memory.provider needs a recall, a capture or a profile function: propose alone serves only the memory tools (memoryTools, serveMemoryMcp), not AgentOptions.memory');
  }
  return value as AgentMemoryProvider;
}

/** The turn's user text: a string, or its text items joined. Never includes a recalled block. */
export function userText(input: AgentInput): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.flatMap((part) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n');
}

/** Rejects as soon as `signal` aborts, whether or not `work` honours it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** Asks the provider once, bounded by `signal`; a throw, a timeout or a cancellation becomes the reason there is no value. */
async function settle(work: () => Promise<unknown>, signal: AbortSignal, expired: Error, timeoutMs: number, what: 'recall' | 'profile'): Promise<Settled> {
  try {
    return { value: await untilAborted(Promise.resolve().then(work), signal) };
  } catch {
    const reason = signal.aborted && signal.reason === expired ? `${what} timed out after ${timeoutMs} ms`
      : signal.aborted ? `the turn was cancelled during ${what === 'recall' ? 'recall' : 'the profile read'}` : `${what} failed`;
    return { reason };
  }
}

function profileFailed(reason: string): ProfileRead { return { note: { status: 'failed', reason } }; }

/** The turn as it left, with what memory did recorded in warnings and `providerMetadata.memory`. */
export function annotateMemory<T extends { warnings: RuntimeWarning[]; providerMetadata: unknown }>(turn: T, note: MemoryTurnNote | undefined): T {
  if (note === undefined) return turn;
  const metadata = typeof turn.providerMetadata === 'object' && turn.providerMetadata !== null ? turn.providerMetadata : {};
  const added: RuntimeWarning[] = [];
  if (note.status === 'failed') added.push({ code: 'MEMORY_UNAVAILABLE', message: `This turn ran without recalled memory: ${note.reason}` });
  const profile = note.profile;
  if (profile?.status === 'failed' || profile?.status === 'omitted') {
    added.push({ code: 'MEMORY_PROFILE_UNAVAILABLE', message: `This turn ran without its memory profile: ${profile.reason}` });
  }
  const warnings = added.length === 0 ? turn.warnings : [...turn.warnings, ...added];
  return { ...turn, warnings, providerMetadata: { ...metadata, memory: note } };
}

/**
 * The memory option of one Agent, shared by its sessions. Before a turn it asks the provider for
 * a few items (and, alongside, for the scope's profile when it has one) and carries what fits as
 * one reference block prepended to the input; after
 * a completed turn, when asked, it hands the turn to the provider without delaying its result.
 * Every failure is fail-open and recorded on the turn.
 */
export class MemoryTurns {
  readonly #provider: AgentMemoryProvider;
  readonly #scope: AgentMemoryScope;
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #maxProfileBytes: number;
  readonly #timeoutMs: number;
  readonly #capture: boolean;
  readonly #onCaptureError: ((error: unknown) => void) | undefined;
  readonly #pending = new Set<Promise<void>>();
  readonly #owned = new WeakMap<object, Set<Promise<void>>>();
  /** The deadline timer of each pending capture. */
  readonly #deadlines = new Map<Promise<void>, ReturnType<typeof setTimeout>>();
  #warnedAt: number | undefined;

  constructor(option: MemoryOption) {
    closed(option, KEYS, 'The memory option');
    this.#provider = providerOf(option.provider);
    this.#scope = scopeOf(option.scope);
    this.#maxItems = bounded(option.maxItems, 'memory.maxItems', 1, MEMORY_MAX_ITEMS_CEILING, MEMORY_DEFAULT_MAX_ITEMS);
    this.#maxBytes = bounded(option.maxBytes, 'memory.maxBytes', MIN_MAX_BYTES, MEMORY_MAX_BYTES_CEILING, MEMORY_DEFAULT_MAX_BYTES);
    this.#maxProfileBytes = bounded(
      option.maxProfileBytes, 'memory.maxProfileBytes', MIN_MAX_PROFILE_BYTES, MEMORY_MAX_PROFILE_BYTES_CEILING, MEMORY_DEFAULT_MAX_PROFILE_BYTES,
    );
    this.#timeoutMs = bounded(option.recallTimeoutMs, 'memory.recallTimeoutMs', 1, MAX_RECALL_TIMEOUT_MS, MEMORY_DEFAULT_RECALL_TIMEOUT_MS);
    if (option.capture !== undefined && typeof option.capture !== 'boolean') invalid('memory.capture must be true or false');
    if (option.onCaptureError !== undefined && typeof option.onCaptureError !== 'function') invalid('memory.onCaptureError must be a function');
    if (option.capture === true && this.#provider.capture === undefined) invalid('memory.capture needs a provider with a capture function');
    this.#capture = option.capture === true;
    this.#onCaptureError = option.onCaptureError;
  }

  /**
   * Recalls for one turn, and reads the scope's profile alongside when the provider has one: both
   * run at once, under one deadline and one signal. Never rejects: a provider that throws, times
   * out, is cancelled or answers malformed data leaves the turn without what it failed to give and
   * a note that says why. `capMs` bounds both below `recallTimeoutMs` (a share of the turn's own deadline).
   */
  async recall(input: AgentInput, context: MemoryTurnContext, signal: AbortSignal | undefined, capMs?: number): Promise<RecalledTurn> {
    const text = userText(input);
    const { recall, profile } = this.#provider;
    if (!recall && !profile) return this.#turn(input, text, { status: 'empty', provider: this.#provider.id, capture: this.#capture });
    if (signal?.aborted) {
      return this.#select(input, text, recall && { reason: 'the turn was cancelled before recall' },
        profile && profileFailed('the turn was cancelled before the profile read'));
    }
    const timeoutMs = Math.max(1, Math.min(this.#timeoutMs, capMs ?? this.#timeoutMs));
    const deadline = new AbortController();
    const expired = new Error('memory recall deadline');
    const timer = setTimeout(() => deadline.abort(expired), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const { provider, transport, cwd } = context;
      const [recalled, read] = await Promise.all([
        recall && settle(() => recall.call(this.#provider, {
          scope: this.#scope, text, provider, transport, cwd, limit: this.#maxItems, signal: combined,
        }), combined, expired, timeoutMs, 'recall'),
        profile && settle(() => profile.call(this.#provider, { scope: this.#scope, provider, transport, cwd, signal: combined }), combined, expired, timeoutMs, 'profile')
          .then((settled) => ('reason' in settled ? profileFailed(settled.reason) : this.#profileOf(settled.value))),
      ]);
      return this.#select(input, text, recalled, read);
    } finally { clearTimeout(timer); }
  }

  /**
   * Waits for the pending captures of `owner`, or of every session when omitted; each is bounded.
   * A capture nobody waits for never keeps the process alive; one that `close()` waits for does,
   * until it settles or its own deadline passes, so the process cannot exit before `close()` returns.
   */
  async drain(owner?: object): Promise<void> {
    const pending = owner === undefined ? this.#pending : this.#owned.get(owner);
    while (pending?.size) {
      for (const tracked of pending) this.#deadlines.get(tracked)?.ref?.();
      await Promise.allSettled([...pending]);
    }
  }

  /** What a digest may record of this memory: the provider's id and the scope, never a function. */
  get identity(): { provider: string; scope: AgentMemoryScope } { return { provider: this.#provider.id, scope: this.#scope }; }

  /** Leaves `owner`'s pending captures to `drain()` without an owner (the Agent's close). */
  forget(owner: object): void { this.#owned.delete(owner); }

  /** The profile as the block carries it, when it is usable text that fits `maxProfileBytes` as rendered; never truncated. */
  #profileOf(value: unknown): ProfileRead {
    if (value === undefined) return { note: { status: 'absent' } };
    if (typeof value !== 'string') return profileFailed('profile did not return a string');
    const text = profileText(value);
    if (text === undefined) return profileFailed(value.includes('\0') ? 'the profile contains NUL' : 'the profile has no visible text');
    const profile: CarriedProfile = { source: this.#provider.id, text };
    const bytes = Buffer.byteLength(renderProfile(profile), 'utf8');
    if (bytes > this.#maxProfileBytes) {
      return { note: { status: 'omitted', reason: `over budget (${bytes} bytes as rendered, maxProfileBytes is ${this.#maxProfileBytes})`, bytes } };
    }
    return { note: { status: 'carried', bytes }, profile };
  }

  /**
   * The turn's input and note from what recall and the profile read gave (either undefined when
   * the provider lacks it). The block is there when an item or the profile is carried.
   */
  #select(input: AgentInput, text: string, recalled: Settled | undefined, read: ProfileRead | undefined): RecalledTurn {
    const { kept, note } = this.#items(recalled);
    const profile = read?.profile;
    const noted: MemoryTurnNote = read === undefined ? note : { ...note, profile: read.note };
    if (kept.length === 0 && profile === undefined) return this.#turn(input, text, noted);
    return this.#turn(withBlock(input, renderMemoryBlock(kept.map(({ item }) => item), profile)), text, noted);
  }

  /** Keeps whole items while they fit: `maxBytes` bounds each kept item as rendered (header, title and indented text). */
  #items(recalled: Settled | undefined): { kept: Kept[]; note: MemoryTurnNote } {
    const provider = this.#provider.id;
    const capture = this.#capture;
    const failed = (reason: string) => ({ kept: [], note: { status: 'failed', provider, reason, capture } as const });
    if (recalled === undefined) return { kept: [], note: { status: 'empty', provider, capture } };
    if ('reason' in recalled) return failed(recalled.reason);
    const { value } = recalled;
    if (!Array.isArray(value)) return failed('recall did not return an array');
    const kept: Kept[] = [];
    const ids = new Set<string>();
    let malformed = 0, omitted = 0, bytes = 0;
    for (const entry of value as unknown[]) {
      const item = recallableMemory(entry);
      if (!item) { malformed += 1; continue; }
      const size = Buffer.byteLength(renderItem(item, kept.length), 'utf8');
      if (ids.has(item.id) || kept.length >= this.#maxItems || bytes + size > this.#maxBytes) { omitted += 1; continue; }
      ids.add(item.id);
      kept.push({ item, bytes: size });
      bytes += size;
    }
    if (value.length === 0) return { kept, note: { status: 'empty', provider, capture } };
    if (kept.length === 0) return failed(`none of the ${value.length} recalled items was usable (${malformed} malformed, ${omitted} over budget)`);
    return {
      kept,
      note: {
        status: 'recalled', provider, omitted: omitted + malformed, bytes, capture,
        items: kept.map(({ item, bytes: size }) => ({ id: item.id, source: item.source, bytes: size })),
      },
    };
  }

  #turn(input: AgentInput, text: string, note: MemoryTurnNote): RecalledTurn {
    let scheduled = false;
    return {
      input,
      note,
      finish: (turn, owner) => {
        if (!scheduled && turn.status === 'completed') {
          scheduled = true;
          this.#schedule(text, turn, owner);
        }
        return turn;
      },
    };
  }

  /** Captures in the background: bounded, never rejecting, tracked for `drain`. */
  #schedule(input: string, turn: Turn, owner: object): void {
    const capture = this.#provider.capture;
    if (!this.#capture || !capture) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutError({ retryable: true }, `Memory capture did not finish within ${MEMORY_CAPTURE_TIMEOUT_MS} ms`);
        controller.abort(error);
        reject(error);
      }, MEMORY_CAPTURE_TIMEOUT_MS);
      // The result is already delivered: a hung capture must not keep the process alive, unless `drain` waits for it.
      timer.unref?.();
    });
    const completedAt = new Date().toISOString();
    const work = Promise.resolve().then(() => capture.call(this.#provider, { scope: this.#scope, input, turn, completedAt, signal: controller.signal }));
    let owned = this.#owned.get(owner);
    if (!owned) { owned = new Set(); this.#owned.set(owner, owned); }
    const set = owned;
    const tracked: Promise<void> = Promise.race([work, deadline]).then(() => undefined, (error: unknown) => this.#report(error, controller.signal.aborted)).finally(() => {
      clearTimeout(timer);
      this.#deadlines.delete(tracked);
      this.#pending.delete(tracked);
      set.delete(tracked);
    });
    if (timer !== undefined) this.#deadlines.set(tracked, timer);
    this.#pending.add(tracked);
    set.add(tracked);
  }

  #report(error: unknown, timedOut: boolean): void {
    if (!this.#onCaptureError) { this.#warn(timedOut); return; }
    try {
      const reported: unknown = this.#onCaptureError(error);
      if (reported instanceof Promise) reported.catch(() => undefined);
    } catch { /* a failing error handler must not fail anything else */ }
  }

  /** Without a handler a capture failure is still visible: one process warning per interval, never more. */
  #warn(timedOut: boolean): void {
    const now = Date.now();
    if (this.#warnedAt !== undefined && now - this.#warnedAt < CAPTURE_WARNING_INTERVAL_MS) return;
    this.#warnedAt = now;
    try {
      process.emitWarning(`Memory capture ${timedOut ? 'timed out' : 'failed'}. Set memory.onCaptureError to receive every capture failure.`, {
        type: 'MemoryCaptureWarning', code: 'OAR_MEMORY_CAPTURE_FAILED',
      });
    } catch { /* a warning listener that throws must not fail anything else */ }
  }
}

/** The Agent's memory: its own option, the Runtime default with its scope for this Agent, or none. */
export function agentMemory(option: MemoryOption | false | undefined, fallback: RuntimeMemoryDefault | undefined, context: MemoryScopeContext): MemoryTurns | undefined {
  if (option === false) return undefined;
  if (option !== undefined) return new MemoryTurns(option);
  if (fallback === undefined) return undefined;
  const { scope, ...rest } = fallback;
  return new MemoryTurns({ ...rest, scope: scope(context) });
}
