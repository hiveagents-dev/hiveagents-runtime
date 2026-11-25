import type {
  AgentMemoryProvider, AgentMemoryScope, MemoryCaptureRequest, MemoryProfileRequest, MemoryProposeRequest,
  MemoryRecallRequest, RecalledMemory,
} from '../../public/memory-types.js';
import { recallableMemory } from '../../public/memory-items.js';
import type {
  EmbeddingIdentity, MemoryEmbedder, MemoryPersistencePort, MemoryQuery, MemoryQueryPort, MemoryScope,
  ScopedMemoryRecord,
} from './ports.js';

/**
 * Agent memory over the memory ports: the adapter an `Agent`'s `memory` option
 * takes. Pure (no Node imports): digests use Web Crypto, so it bundles for a
 * browser like the rest of this entry.
 *
 * Recall asks the query port for at most `limit` records in the exact scope of
 * the request and hands them to the agent as reference data. Capture is opt-in
 * twice: the application must pass a persistence port here AND set
 * `memory.capture: true` on the agent.
 *
 * Captured turns are episodes, not lessons. With `SqliteSystemMemory`, `query`
 * returns only lessons that passed the promotion gate, so a captured turn is NOT
 * recallable until the application measures it (`measureMemory`, with this
 * episode as the only candidate) and promotes it (`promote`) with that evidence.
 * Capture never promotes anything by itself. A proposal (`propose`, what an agent
 * asks to remember through a memory tool) is stored the same way: an episode.
 *
 * `propose` is offered only where a proposal is sure to stay out of recall until it is
 * promoted: when there is no `recall` port (this provider never reads what it stores), or when
 * `captureGate` is `'store-promotes'`. With `'none-acknowledged'` recall may return what
 * `persistence` stored, unreviewed, on the next turn: acceptable for the application's own
 * captured turns if it says so, but a proposal is model output that the tool tells the agent
 * is "not recallable until promoted", so the provider has no `propose` there.
 *
 * A store that returned what it was just given would recall a captured turn on
 * the very next turn: whatever a model was induced to write once would be read
 * back as memory on every later turn. So when both ports are given, the caller
 * must say how recall is gated (`captureGate`); the adapter refuses to guess.
 */
export type MemoryCaptureGate =
  /**
   * The recall port returns only records promoted through a measured gate, never a
   * stored episode as it is: `SqliteSystemMemory`, and the vector stores of
   * `hiveagents-runtime-agentdb-memory`.
   */
  | 'store-promotes'
  /**
   * The caller accepts that recall may return what capture stored, on the next
   * turn, unreviewed: for example when `recall` reads a curated store that
   * `persistence` never writes to. Never the right choice for one store that
   * returns everything it holds. Covers captured turns only: the provider then
   * has no `propose`, since a proposal must never be recalled before promotion.
   */
  | 'none-acknowledged';

export interface MemoryPortsProviderOptions {
  /** Recorded on every turn note. Default: `memory-ports`. */
  id?: string;
  /** Recall source. Without it the provider has no `recall`. */
  recall?: MemoryQueryPort;
  /** Capture target. Without it the provider has no `capture`. */
  persistence?: MemoryPersistencePort;
  /** Embeds the query text and, on capture, the stored text. Without it, recall is lexical only. */
  embedder?: MemoryEmbedder;
  /**
   * Builds the record to store for a completed turn, replacing the default
   * one-episode-per-turn record. Return undefined to store nothing. The record's
   * scope must be the request's scope.
   */
  toRecord?: (request: MemoryCaptureRequest) => ScopedMemoryRecord | undefined | Promise<ScopedMemoryRecord | undefined>;
  /** Clock for `provenance.observedAt`. Default: the system clock. */
  now?: () => Date;
  /**
   * Required when both `recall` and `persistence` are given, refused otherwise:
   * how a captured or proposed episode is kept out of recall until it is measured and promoted.
   */
  captureGate?: MemoryCaptureGate;
  /**
   * The scope's fixed profile, handed through as the provider's `profile` unchanged: the
   * application maintains it, nothing an agent does reaches it. Without it the provider has no
   * `profile`.
   */
  profile?: (request: MemoryProfileRequest) => Promise<string | undefined>;
}

/** `SqliteSystemMemory` refuses longer query texts. */
const MAX_QUERY_TEXT = 4096;
/**
 * UTF-8 bytes of a default episode as the agent renders it, every line indented by
 * `RENDERED_INDENT` spaces and every whitespace run inside a line datamarked (2 bytes). 6 KiB
 * fits the default recall budget (`MEMORY_DEFAULT_MAX_BYTES`,
 * 8 KiB) with room for the item header, and stays under the 8192 characters a store takes.
 */
export const EPISODE_MAX_BYTES = 6 * 1024;
const RENDERED_INDENT = 4;
/** What the agent counts as a line break when it indents recalled text. */
const LINE_BREAK = /^[\n\r\u000b\u000c\u0085\u2028\u2029]$/;
/** Whitespace; inside a line the agent datamarks each run of it as one U+02C6 (`MARK_BYTES`). */
const WHITESPACE = /^\s$/u, MARK_BYTES = 2;
const MAX_NAME = 128;
const SOURCE = 'agent-turn';
const PROPOSAL_SOURCE = 'agent-proposal';
/** Control, format and line-separator characters, which a store refuses in names. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Builds an `AgentMemoryProvider` from memory ports.
 *
 * ```ts
 * const store = new SqliteSystemMemory({ databasePath, systemId: 'acme' });
 * new Agent({ model, memory: {
 *   provider: memoryProviderFromPorts({ recall: store, persistence: store, captureGate: 'store-promotes' }),
 *   scope: { tenant: 'acme', namespace: 'support', subject: 'customer-42' },
 * } });
 * ```
 *
 * A caller can rely on:
 * - recall never returns more than `limit` items, nor a record of another scope,
 *   a revoked one or one whose `validUntil` has passed (by `now`), whatever the
 *   port returns; a record the agent would drop (`recallableMemory`) is dropped
 *   here and does not count against `limit`;
 * - both ports together are refused unless `captureGate` says how recall is gated;
 * - an embedder whose vectors do not match its identity is refused, never
 *   padded or compared;
 * - an aborted `signal` rejects recall and capture with its reason;
 * - the default capture stores one episode per completed turn under an id
 *   derived from the session and turn (from the session, the exchange and
 *   `completedAt` when the turn has no id), so capturing the same request again
 *   is a no-op for an idempotent store, and an exchange repeated later in the
 *   session is an episode of its own;
 * - recalled text is returned as data; this adapter adds no instruction to it;
 * - `propose` exists with `persistence` and either no `recall` or `captureGate:
 *   'store-promotes'`; it stores the agent's proposal, whole, as an episode under an id
 *   derived from the scope and the digest of the full text, so it is recallable only once
 *   promoted; a text that does not fit `EPISODE_MAX_BYTES` as rendered is refused (a
 *   TypeError), never cut; proposing the same text again in the scope names the same
 *   candidate, when the store can confirm it holds that text (`MemoryPersistencePort.get`);
 * - `profile` is the caller's function, called as given.
 */
export function memoryProviderFromPorts(options: MemoryPortsProviderOptions): AgentMemoryProvider {
  const config = captureProviderOptions(options);
  const provider: { -readonly [K in keyof AgentMemoryProvider]: AgentMemoryProvider[K] } = { id: config.id };
  const { recall: port, persistence } = config;
  if (port) provider.recall = request => recallThrough(port, config, request);
  if (persistence) {
    provider.capture = request => captureThrough(persistence, config, request);
    // Only where nothing recalls a proposal before promotion: see `MemoryCaptureGate`.
    if (!port || config.captureGate === 'store-promotes') provider.propose = request => proposeThrough(persistence, config, request);
  }
  const { profile } = config;
  if (profile) provider.profile = request => profile(request);
  return Object.freeze(provider);
}

interface CapturedProviderOptions {
  id: string;
  recall?: MemoryQueryPort;
  persistence?: MemoryPersistencePort;
  embedder?: MemoryEmbedder;
  toRecord?: MemoryPortsProviderOptions['toRecord'];
  profile?: MemoryPortsProviderOptions['profile'];
  captureGate?: MemoryCaptureGate;
  now: () => Date;
}

function captureProviderOptions(options: MemoryPortsProviderOptions): CapturedProviderOptions {
  if (!options || typeof options !== 'object') throw new TypeError('memoryProviderFromPorts needs an options object');
  const { id = 'memory-ports', recall, persistence, embedder, toRecord, now, captureGate, profile } = options;
  if (!isName(id)) throw new TypeError('id must be a nonblank printable string of at most 128 characters');
  if (recall === undefined && persistence === undefined) {
    throw new TypeError('memoryProviderFromPorts needs a recall port, a persistence port, or both');
  }
  if (recall !== undefined && persistence !== undefined) {
    if (captureGate !== 'store-promotes' && captureGate !== 'none-acknowledged') {
      throw new TypeError(
        "With both recall and persistence, captureGate must be 'store-promotes' (recall returns only promoted lessons) "
        + "or 'none-acknowledged' (a captured turn may be recalled unreviewed on the next turn)",
      );
    }
  } else if (captureGate !== undefined) {
    throw new TypeError('captureGate applies only when both recall and persistence are given');
  }
  if (recall !== undefined && typeof recall?.query !== 'function') throw new TypeError('recall must implement query()');
  if (persistence !== undefined && typeof persistence?.put !== 'function') throw new TypeError('persistence must implement put()');
  if (toRecord !== undefined && typeof toRecord !== 'function') throw new TypeError('toRecord must be a function');
  if (now !== undefined && typeof now !== 'function') throw new TypeError('now must be a function');
  if (profile !== undefined && typeof profile !== 'function') throw new TypeError('profile must be a function');
  const config: CapturedProviderOptions = { id, now: now ?? (() => new Date()) };
  if (recall) config.recall = recall;
  if (persistence) config.persistence = persistence;
  if (toRecord) config.toRecord = toRecord;
  if (profile) config.profile = profile;
  if (captureGate) config.captureGate = captureGate;
  if (embedder !== undefined) {
    if (typeof embedder?.embed !== 'function') throw new TypeError('embedder must implement embed()');
    assertIdentity(embedder.identity);
    config.embedder = embedder;
  }
  return config;
}

/** A plain copy with exactly the four fields a store checks. */
function identityOf({ identity }: MemoryEmbedder): EmbeddingIdentity {
  return { provider: identity.provider, model: identity.model, revision: identity.revision, dimensions: identity.dimensions };
}

function assertIdentity(identity: EmbeddingIdentity): void {
  const { provider, model, revision, dimensions } = identity ?? ({} as EmbeddingIdentity);
  if (![provider, model, revision].every(isName)) {
    throw new TypeError('embedder.identity needs provider, model and revision names');
  }
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new TypeError('embedder.identity.dimensions must be a positive integer');
  }
}

/** One vector per text, each of the identity's dimensions, finite numbers only. */
async function embed(embedder: MemoryEmbedder, text: string, signal?: AbortSignal): Promise<readonly number[]> {
  const vectors = await abortable(embedder.embed([text], signal), signal);
  const { dimensions } = embedder.identity;
  const vector = Array.isArray(vectors) && vectors.length === 1 ? vectors[0] : undefined;
  if (!Array.isArray(vector) || vector.length !== dimensions
    || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new RangeError(`The embedder must return one vector of ${dimensions} finite numbers per text`);
  }
  return Object.freeze([...vector]);
}

async function recallThrough(
  port: MemoryQueryPort, config: CapturedProviderOptions, request: MemoryRecallRequest,
): Promise<readonly RecalledMemory[]> {
  const { embedder } = config;
  const { signal } = request;
  signal?.throwIfAborted();
  const limit = request.limit;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a nonnegative integer');
  if (limit === 0) return [];
  const scope = scopeOf(request.scope);
  const text = clip(typeof request.text === 'string' ? request.text : '', MAX_QUERY_TEXT);
  const query: MemoryQuery = { scope, text, limit };
  if (signal) query.signal = signal;
  if (embedder) query.embedding = { identity: identityOf(embedder), values: await embed(embedder, text, signal) };
  const records = await abortable(port.query(query), signal);
  signal?.throwIfAborted();
  if (!Array.isArray(records)) throw new TypeError('The recall port must return an array of records');
  const now = config.now().getTime();
  const recalled: RecalledMemory[] = [];
  const seen = new Set<string>();
  for (const record of records as readonly ScopedMemoryRecord[]) {
    if (recalled.length === limit) break;
    const item = recalledOf(record, scope, now);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    recalled.push(item);
  }
  return Object.freeze(recalled);
}

/**
 * Defence in depth: whatever a port returns, only well-formed, live records of the asked scope come back,
 * held to the same rules the agent applies (`recallableMemory`), so an item the agent would drop never
 * takes the place of a usable one within `limit`. An unusable title is left out; the item stays.
 * A record past its `validUntil` at `now` (epoch ms) is dropped, and so is one whose `validUntil`
 * cannot be read: validity that cannot be checked is not assumed.
 */
function recalledOf(record: ScopedMemoryRecord, scope: MemoryScope, now: number): RecalledMemory | undefined {
  if (!record || typeof record !== 'object' || record.revokedAt !== undefined) return undefined;
  if (!sameScope(record.scope, scope) || expired(record.validUntil, now)) return undefined;
  const provenance: Partial<ScopedMemoryRecord['provenance']> = record.provenance ?? {};
  const metadata = record.metadata;
  const title = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.title : undefined;
  const base = { id: record.id, text: record.text, source: provenance.source, ...(title === undefined ? {} : { title }) };
  // A store may keep a looser timestamp than the agent carries (no offset, say): leave the time out, keep the item.
  const item = (provenance.observedAt === undefined ? undefined : recallableMemory({ ...base, observedAt: provenance.observedAt }))
    ?? recallableMemory(base);
  return item && Object.freeze(item);
}

async function captureThrough(
  persistence: MemoryPersistencePort, config: CapturedProviderOptions, request: MemoryCaptureRequest,
): Promise<void> {
  const { signal } = request;
  signal?.throwIfAborted();
  const scope = scopeOf(request.scope);
  const record = config.toRecord
    ? await abortable(Promise.resolve(config.toRecord(request)), signal)
    : await defaultRecord(config, request, scope);
  if (record === undefined) return;
  if (!record || typeof record !== 'object' || !sameScope(record.scope, scope)) {
    throw new TypeError('A captured record must belong to the scope of the capture request');
  }
  signal?.throwIfAborted();
  await abortable(persistence.put(record, signal), signal);
}

function expired(validUntil: unknown, now: number): boolean {
  if (validUntil === undefined) return false;
  const until = typeof validUntil === 'string' ? Date.parse(validUntil) : Number.NaN;
  return Number.isNaN(until) || until < now;
}

/**
 * A proposal is untrusted model output stored as an episode, never a lesson: recall returns
 * it only after the application measures and promotes it. Its text is held to the agent's item
 * rules and to the bound of a captured episode, and stored whole: one that does not fit is
 * refused, since a cut proposal would be reported as stored while losing its end, and two
 * long ones sharing a prefix would collapse into one. Its metadata is only `{ origin, title? }`.
 */
async function proposeThrough(
  persistence: MemoryPersistencePort, config: CapturedProviderOptions, request: MemoryProposeRequest,
): Promise<{ readonly id: string }> {
  const { signal } = request;
  signal?.throwIfAborted();
  const scope = scopeOf(request.scope);
  if (!isName(request.origin)) throw new TypeError('A proposal needs an origin of at most 128 printable characters');
  const text = typeof request.text === 'string' ? request.text : '';
  if (!text.trim() || !recallableMemory({ id: 'proposal', source: PROPOSAL_SOURCE, text })) {
    throw new TypeError('A proposal needs text the agent could recall');
  }
  if (renderedBytes(text) > EPISODE_MAX_BYTES - RENDERED_INDENT) {
    throw new TypeError(`A proposal must fit ${EPISODE_MAX_BYTES} bytes as the agent renders it; it is refused, never cut`);
  }
  const textHash = await sha256(text);
  const id = `${PROPOSAL_SOURCE}-${await sha256(JSON.stringify([scope.tenant, scope.namespace, scope.subject ?? null, textHash]))}`;
  signal?.throwIfAborted();
  const metadata: Record<string, string> = { origin: request.origin };
  if (isName(request.title)) metadata.title = request.title;
  const record: ScopedMemoryRecord = {
    id,
    scope,
    text,
    provenance: { source: PROPOSAL_SOURCE, sourceVersion: request.origin, observedAt: config.now().toISOString(), inputHash: textHash },
    metadata,
  };
  if (config.embedder) record.embedding = { identity: identityOf(config.embedder), values: await embed(config.embedder, text, signal) };
  signal?.throwIfAborted();
  try {
    await abortable(persistence.put(record, signal), signal);
  } catch (error) {
    // The same text proposed again in this scope (at another time, or with another title) lands
    // on this id, and an idempotent store refuses it as CONFLICT. It names the stored candidate
    // only when the store confirms that candidate holds this very text; otherwise the CONFLICT stands.
    if ((error as { code?: unknown } | null)?.code !== 'CONFLICT' || signal?.aborted) throw error;
    if (!await storedText(persistence, scope, id, text, signal)) throw error;
  }
  return Object.freeze({ id });
}

/** True when the port can read the record back and it is this scope's record with exactly `text`. */
async function storedText(
  persistence: MemoryPersistencePort, scope: MemoryScope, id: string, text: string, signal: AbortSignal | undefined,
): Promise<boolean> {
  if (typeof persistence.get !== 'function') return false;
  const stored = await abortable(persistence.get({ scope, id, ...(signal ? { signal } : {}) }), signal);
  signal?.throwIfAborted();
  return !!stored && typeof stored === 'object' && stored.id === id && sameScope(stored.scope, scope) && stored.text === text;
}

/** One episode per completed turn: what the user asked and what the agent answered, with its provenance. */
async function defaultRecord(
  config: CapturedProviderOptions, request: MemoryCaptureRequest, scope: MemoryScope,
): Promise<ScopedMemoryRecord | undefined> {
  const { turn, signal } = request;
  if (!turn || turn.status !== 'completed') return undefined;
  const input = typeof request.input === 'string' ? request.input : '';
  const answer = typeof turn.text === 'string' ? turn.text : '';
  if (!input.trim() && !answer.trim()) return undefined;
  const text = episodeText(input, answer);
  const session = turn.session;
  const provider = isName(session?.provider) ? session.provider : 'unknown';
  const model = isName(session?.model) ? session.model : undefined;
  const sessionId = [session?.sessionId, session?.id].find(isName);
  const turnId = isName(turn.id) ? turn.id : undefined;
  const inputHash = await sha256(JSON.stringify([input, answer]));
  signal?.throwIfAborted();
  const observedAt = typeof request.completedAt === 'string' ? request.completedAt : config.now().toISOString();
  // Without a turn id (Claude exec turns have none), the same exchange can repeat in one session:
  // the completion time keeps each repetition its own episode, while a retried capture of the same
  // request, which carries the same `completedAt`, still lands on the same id.
  const key = turnId ? ['turn', sessionId ?? '', turnId] : ['content', sessionId ?? '', inputHash, observedAt];
  const metadata: Record<string, string> = { provider };
  if (isName(session?.transport)) metadata.transport = session.transport;
  if (sessionId) metadata.sessionId = sessionId;
  if (turnId) metadata.turnId = turnId;
  const record: ScopedMemoryRecord = {
    id: `${SOURCE}-${await sha256(JSON.stringify(key))}`,
    scope,
    text,
    provenance: {
      source: SOURCE,
      sourceVersion: model && `${provider}/${model}`.length <= MAX_NAME ? `${provider}/${model}` : provider,
      observedAt,
      inputHash,
    },
    metadata,
  };
  if (config.embedder) record.embedding = { identity: identityOf(config.embedder), values: await embed(config.embedder, text, signal) };
  return record;
}

/**
 * At most `EPISODE_MAX_BYTES` as rendered. Both sides are kept when the turn is long: the input
 * keeps at least half the budget.
 */
function episodeText(input: string, answer: string): string {
  const head = 'User:\n';
  const middle = '\n\nAssistant:\n';
  const budget = EPISODE_MAX_BYTES - RENDERED_INDENT - renderedBytes(head) - renderedBytes(middle);
  const inputBudget = Math.max(budget - renderedBytes(answer), Math.floor(budget / 2));
  const asked = clipRendered(input, inputBudget);
  return `${head}${asked}${middle}${clipRendered(answer, budget - renderedBytes(asked))}`;
}

/** Rendered UTF-8 bytes of one code point: a line break adds the indent; a whitespace run is one 2-byte mark. */
function renderedCost(char: string, afterWhitespace: boolean): number {
  const point = char.codePointAt(0)!;
  const bytes = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  if (LINE_BREAK.test(char)) return bytes + RENDERED_INDENT;
  if (WHITESPACE.test(char)) return afterWhitespace ? 0 : MARK_BYTES;
  return bytes;
}

/** Each code point of `text` with its rendered cost; a whitespace run ends at a line break. */
function* renderedCosts(text: string): Generator<[string, number]> {
  let afterWhitespace = false;
  for (const char of text) {
    yield [char, renderedCost(char, afterWhitespace)];
    afterWhitespace = !LINE_BREAK.test(char) && WHITESPACE.test(char);
  }
}

function renderedBytes(text: string): number {
  let total = 0;
  for (const [, cost] of renderedCosts(text)) total += cost;
  return total;
}

/** The longest prefix whose rendered size is at most `maximum` bytes; never splits a code point. */
function clipRendered(text: string, maximum: number): string {
  let total = 0;
  let end = 0;
  for (const [char, cost] of renderedCosts(text)) {
    total += cost;
    if (total > maximum) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Cuts to at most `maximum` UTF-16 units without leaving half of a surrogate pair. */
function clip(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const cut = text.slice(0, maximum);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function scopeOf(scope: AgentMemoryScope): MemoryScope {
  if (!scope || typeof scope !== 'object') throw new TypeError('A memory request needs a scope');
  const result: MemoryScope = { tenant: scope.tenant, namespace: scope.namespace };
  if (scope.subject !== undefined) result.subject = scope.subject;
  return result;
}

function sameScope(candidate: unknown, scope: MemoryScope): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const other = candidate as Partial<MemoryScope>;
  return other.tenant === scope.tenant && other.namespace === scope.namespace && other.subject === scope.subject;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NAME && value.trim() === value && value !== ''
    && !UNPRINTABLE.test(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Settles with `work`, or rejects with the signal's reason as soon as it aborts. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
