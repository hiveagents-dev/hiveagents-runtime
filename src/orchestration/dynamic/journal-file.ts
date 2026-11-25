/**
 * File journal for dynamic workflows: one JSONL file per run (`<runId>.jsonl`) in a private directory.
 *
 * - Every line is `{"checksum","format":1,"record","runId"}` in canonical JSON, where `checksum` is the
 *   SHA-256 of the canonical `{format, record, runId}`. Appends are fsync'd before `put` resolves.
 * - A corrupt or unterminated LAST line is a torn write: it is ignored and truncated away when the run
 *   opens (its `put` never resolved, so that agent call simply runs again). A corrupt line followed by
 *   more data is real corruption: `DynamicJournalCorruptError`, and the run is refused.
 * - One writer per run: `<runId>.lock` is created exclusively (a fully written owner file hard-linked
 *   into place, which fails with EEXIST exactly like O_EXCL but can never leave an empty lock behind).
 *   The lock is released on `close`. There is no TTL: a lock left by a crash refuses the run until an
 *   operator inspects it (`inspectOwner`) and calls `recoverAbandoned`, which refuses a live PID, another
 *   host or a changed token — the same "inspect first, never by age" stance as the workflow file store.
 *   A recovery cut short by a crash is finished by retrying it with the same token.
 * - A failed append (ENOSPC, EIO) may leave part of a line behind. Before each append the file size is
 *   read; on failure the file is truncated back to it and fsync'd, so the next record never glues onto
 *   a fragment. If that undo also fails the session is poisoned: every later `put` rejects with
 *   `DynamicJournalWriteError`, and reopening the run drops the fragment as a torn write.
 * - `get` serves from an in-memory index loaded once when the run opens.
 *
 * Local filesystems only: no network filesystem, distributed fencing or automatic expiry.
 */
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { canonical, checksum } from '../../shared/json.js';
import type { DynamicAgentResult } from './types.js';
import {
  DynamicJournalCorruptError, DynamicJournalLockedError, DynamicJournalWriteError, validateDynamicAgentResult,
  validateDynamicRunId, type ManagedDynamicJournal,
} from './journal-records.js';

export interface DynamicJournalOwner {
  readonly format: 1;
  readonly runId: string;
  readonly token: string;
  readonly pid: number;
  readonly host: string;
}

export interface FileDynamicJournal extends ManagedDynamicJournal {
  readonly directory: string;
  /** The writer that holds the run, if any (read-only; never changes the lock). */
  inspectOwner(runId: string): Promise<DynamicJournalOwner | undefined>;
  /**
   * Explicit crash recovery, never based on age: removes a lock whose owner process is gone. Refuses a
   * live PID, another host or a changed token. The caller asserts the owner's agents have stopped.
   * Recoverers of one token are serialized by a claim file (`<runId>.lock.recovering-<token>.<n>`),
   * and the lock is re-read under it, so a new owner's lock is never removed and only one recoverer
   * succeeds; a concurrent one is refused ("in progress"). A recovery interrupted at any point (its
   * process killed) is completed by calling this again with the same token: the dead recoverer's
   * claim is stepped over, and if it had already removed the lock the call just resolves. A tombstone
   * (`<runId>.lock.recovered-<token>`) is kept as a record. Once the recovery finished cleanly, or a
   * new owner holds the run, the old token is refused ("token changed").
   */
  recoverAbandoned(runId: string, expectedToken: string, acknowledgement: { ownerStopped: true }): Promise<void>;
}

interface Session {
  readonly owner: DynamicJournalOwner;
  readonly handle: FileHandle;
  readonly index: Map<string, DynamicAgentResult>;
  queue: Promise<unknown>;
  /** Set when a failed append could not be undone: the file may end in a fragment. */
  poisoned: boolean;
}

const FORMAT = 1;
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const codeIs = (error: unknown, ...codes: string[]): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && codes.includes(String(error.code));

function encode(runId: string, record: DynamicAgentResult): string {
  const body = { format: FORMAT, record, runId };
  return `${canonical({ checksum: checksum(canonical(body)), ...body })}\n`;
}

function decode(runId: string, line: string): DynamicAgentResult | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'checksum,format,record,runId') return undefined;
    if (entry.format !== FORMAT || entry.runId !== runId) return undefined;
    if (entry.checksum !== checksum(canonical({ format: entry.format, record: entry.record, runId: entry.runId }))) return undefined;
    return validateDynamicAgentResult(entry.record);
  } catch { return undefined; }
}

/** Whether a process of this host is running (or exists but belongs to another user). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !codeIs(error, 'ESRCH'); }
}

/**
 * Recovery claims: `<lock>.recovering-<token>.<generation>`, each `{format, pid, host, nonce}` written
 * in full before it is linked into place. The recoverer that created the highest generation holds the
 * claim. Generation g+1 is only created (exclusively) after generation g was found to belong to a dead
 * process of this host, and a claim is only ever removed by its own holder, so two live recoverers
 * never both hold one; a recoverer killed while holding it leaves a claim the next attempt steps over.
 */
interface RecoveryClaim { readonly format: 1; readonly pid: number; readonly host: string; readonly nonce: string }

const CLAIM_GENERATIONS = 64;
/** Nonces of the claims this process holds right now, whatever journal instance took them. */
const heldClaims = new Set<string>();

async function readClaim(path: string): Promise<RecoveryClaim | 'missing' | undefined> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (codeIs(error, 'ENOENT')) return 'missing'; throw error; }
  try {
    const value = JSON.parse(text) as Partial<RecoveryClaim> | null;
    if (value?.format === FORMAT && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
      && typeof value.host === 'string' && typeof value.nonce === 'string') return value as RecoveryClaim;
  } catch { /* invalid below */ }
  return undefined;
}

async function claimRecovery(lock: string, token: string): Promise<{ readonly path: string; readonly nonce: string }> {
  const claim: RecoveryClaim = { format: FORMAT, pid: process.pid, host: hostname(), nonce: randomUUID() };
  let generation = 0;
  for (let attempt = 0; attempt < CLAIM_GENERATIONS * 2 && generation < CLAIM_GENERATIONS; attempt++) {
    const path = `${lock}.recovering-${token}.${generation}`;
    const prepared = `${path}.${claim.nonce}.tmp`;
    const file = await open(prepared, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(claim)); await file.sync(); }
    finally { await file.close(); }
    try {
      await link(prepared, path);
      heldClaims.add(claim.nonce);
      return { path, nonce: claim.nonce };
    } catch (error) {
      if (!codeIs(error, 'EEXIST')) throw error;
    } finally { await rm(prepared, { force: true }); }
    const other = await readClaim(path);
    if (other === 'missing') continue; // its holder just finished: try this generation again
    assertAbandonedClaim(path, other);
    generation++; // left by a recoverer that died: step over it
  }
  throw new Error(`Too many abandoned dynamic journal recovery claims; inspect ${lock}.recovering-${token}.*`);
}

/** Throws unless the claim at `path` was left by a recoverer of this host that is gone. */
function assertAbandonedClaim(path: string, claim: RecoveryClaim | undefined): void {
  if (claim === undefined) throw new Error(`Invalid dynamic journal recovery claim; inspect ${path}`);
  if (claim.host !== hostname()) throw new Error(`Dynamic journal recovery is claimed from another host; inspect ${path}`);
  if (claim.pid === process.pid ? heldClaims.has(claim.nonce) : alive(claim.pid)) {
    throw new Error(`Dynamic journal recovery already in progress; inspect ${path}`);
  }
}

/**
 * Whether the recovery of `token` already removed the lock and its recoverer died before releasing
 * its claim: the tombstone exists and so does a claim of a dead recoverer (none of a live one). A
 * recovery that finished cleanly leaves no claim, so its token is then simply no longer the owner's.
 */
async function interruptedAfterUnlink(lock: string, token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  try { await lstat(`${lock}.recovered-${token}`); }
  catch (error) { if (codeIs(error, 'ENOENT')) return false; throw error; }
  let abandoned = false;
  for (let generation = 0; generation < CLAIM_GENERATIONS; generation++) {
    const path = `${lock}.recovering-${token}.${generation}`;
    const claim = await readClaim(path);
    if (claim === 'missing') break;
    assertAbandonedClaim(path, claim);
    abandoned = true;
  }
  return abandoned;
}

async function releaseClaim(claim: { readonly path: string; readonly nonce: string }): Promise<void> {
  // Left in place if this fails: a later attempt sees a claim of a process that holds nothing and steps over it.
  try { await unlink(claim.path); } catch { /* stale claim */ }
  heldClaims.delete(claim.nonce);
}

class FileJournal implements FileDynamicJournal {
  readonly directory: string;
  readonly #sessions = new Map<string, Promise<Session>>();

  constructor(directory: string) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Journal directory must be a nonempty string');
    this.directory = resolve(directory);
  }

  #paths(runId: string) {
    validateDynamicRunId(runId);
    return { journal: join(this.directory, `${runId}.jsonl`), lock: join(this.directory, `${runId}.lock`) };
  }

  async open(runId: string): Promise<void> {
    const { lock } = this.#paths(runId);
    if (this.#sessions.has(runId)) throw new DynamicJournalLockedError(runId, lock);
    await this.#session(runId);
  }

  async close(runId: string): Promise<void> {
    const paths = this.#paths(runId);
    const pending = this.#sessions.get(runId);
    if (!pending) return;
    let session: Session;
    try { session = await pending; } catch { return; }
    try {
      await session.queue;
      await session.handle.close();
      await this.#release(paths.lock, session.owner);
    } finally { this.#sessions.delete(runId); }
  }

  async get(runId: string, key: string): Promise<DynamicAgentResult | undefined> {
    const record = (await this.#session(runId)).index.get(key);
    return record === undefined ? undefined : validateDynamicAgentResult(record);
  }

  async put(runId: string, result: DynamicAgentResult): Promise<void> {
    const record = validateDynamicAgentResult(result);
    const { lock } = this.#paths(runId);
    const session = await this.#session(runId);
    const line = encode(runId, record);
    const write = session.queue.then(async () => {
      if (session.poisoned) throw new DynamicJournalWriteError(runId);
      await this.#assertOwner(runId, lock, session.owner);
      const { size } = await session.handle.stat();
      try {
        await session.handle.writeFile(line);
        await session.handle.sync();
      } catch (error) {
        // Cut back any fragment of this line, so the next record starts on a line of its own.
        try { await session.handle.truncate(size); await session.handle.sync(); }
        catch { session.poisoned = true; }
        throw error;
      }
      session.index.set(record.key, record);
    });
    session.queue = write.catch(() => undefined);
    return write;
  }

  async inspectOwner(runId: string): Promise<DynamicJournalOwner | undefined> {
    const { lock } = this.#paths(runId);
    let text: string;
    try { text = await readFile(lock, 'utf8'); }
    catch (error) { if (codeIs(error, 'ENOENT')) return undefined; throw error; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    const owner = value as Partial<DynamicJournalOwner> | undefined;
    if (typeof owner !== 'object' || owner === null || owner.format !== FORMAT || owner.runId !== runId
      || typeof owner.token !== 'string' || !TOKEN.test(owner.token) || !Number.isSafeInteger(owner.pid)
      || (owner.pid as number) <= 0 || typeof owner.host !== 'string') {
      throw new Error(`Invalid dynamic journal lock; inspect ${lock}`);
    }
    return owner as DynamicJournalOwner;
  }

  async recoverAbandoned(runId: string, expectedToken: string, acknowledgement: { ownerStopped: true }): Promise<void> {
    if (acknowledgement?.ownerStopped !== true) throw new Error('Explicitly acknowledge that the owner and its agents have stopped');
    const { lock } = this.#paths(runId);
    if (this.#sessions.has(runId)) throw new Error('Cannot recover a run this journal has open');
    const owner = await this.inspectOwner(runId);
    if (!owner && await interruptedAfterUnlink(lock, expectedToken)) {
      // The lock is already gone: only make that durable (the dead recoverer may not have synced it).
      await this.#syncDirectory();
      return;
    }
    if (!owner || owner.token !== expectedToken) throw new Error('Dynamic journal ownership token changed');
    if (owner.host !== hostname()) throw new Error('Cannot recover dynamic journal ownership from another host');
    if (alive(owner.pid)) throw new Error('Cannot recover dynamic journal ownership while its process is alive');
    const claim = await claimRecovery(lock, owner.token);
    try {
      // Under the claim nothing else removes this lock: its owner is gone, every other recoverer of this
      // token is refused, and a recoverer of another token reads a lock that is not its own.
      if ((await this.inspectOwner(runId))?.token !== owner.token) throw new Error('Dynamic journal ownership token changed');
      // An audit record; an interrupted recovery may have linked it already.
      try { await link(lock, `${lock}.recovered-${owner.token}`); }
      catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
      await unlink(lock);
      await this.#syncDirectory();
    } finally {
      await releaseClaim(claim);
    }
  }

  #session(runId: string): Promise<Session> {
    let pending = this.#sessions.get(runId);
    if (!pending) {
      pending = this.#openSession(runId);
      this.#sessions.set(runId, pending);
      pending.catch(() => { if (this.#sessions.get(runId) === pending) this.#sessions.delete(runId); });
    }
    return pending;
  }

  async #openSession(runId: string): Promise<Session> {
    const paths = this.#paths(runId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const owner = await this.#acquire(runId, paths.lock);
    try {
      let data: Buffer | undefined;
      try { data = await readFile(paths.journal); }
      catch (error) { if (!codeIs(error, 'ENOENT')) throw error; }
      const { index, validBytes } = this.#load(runId, data ?? Buffer.alloc(0));
      if (data !== undefined && validBytes < data.length) {
        const torn = await open(paths.journal, 'r+');
        try { await torn.truncate(validBytes); await torn.sync(); } finally { await torn.close(); }
      }
      const handle = await open(paths.journal, 'a', 0o600);
      if (data === undefined) {
        try { await handle.sync(); await this.#syncDirectory(); }
        catch (error) { await handle.close(); throw error; }
      }
      return { owner, handle, index, queue: Promise.resolve(), poisoned: false };
    } catch (error) {
      await this.#release(paths.lock, owner).catch(() => undefined);
      throw error;
    }
  }

  #load(runId: string, data: Buffer): { index: Map<string, DynamicAgentResult>; validBytes: number } {
    const index = new Map<string, DynamicAgentResult>();
    let offset = 0, line = 0;
    while (offset < data.length) {
      line++;
      const end = data.indexOf(0x0a, offset);
      if (end === -1) break; // unterminated tail: a torn append
      const record = decode(runId, data.subarray(offset, end).toString('utf8'));
      if (!record) {
        if (end + 1 < data.length) throw new DynamicJournalCorruptError(runId, line);
        break; // corrupt last line: a torn append
      }
      index.set(record.key, record);
      offset = end + 1;
    }
    return { index, validBytes: offset };
  }

  async #acquire(runId: string, lock: string): Promise<DynamicJournalOwner> {
    const owner: DynamicJournalOwner = { format: FORMAT, runId, token: randomUUID(), pid: process.pid, host: hostname() };
    const prepared = `${lock}.${owner.token}.tmp`;
    const file = await open(prepared, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(owner)); await file.sync(); }
    finally { await file.close(); }
    try { await link(prepared, lock); }
    catch (error) {
      if (codeIs(error, 'EEXIST')) throw new DynamicJournalLockedError(runId, lock);
      throw error;
    } finally { await rm(prepared, { force: true }); }
    await this.#syncDirectory();
    return owner;
  }

  async #assertOwner(runId: string, lock: string, owner: DynamicJournalOwner): Promise<void> {
    if ((await this.inspectOwner(runId))?.token !== owner.token) throw new Error(`Dynamic journal ownership lost; inspect ${lock}`);
  }

  async #release(lock: string, owner: DynamicJournalOwner): Promise<void> {
    await this.#assertOwner(owner.runId, lock, owner);
    await unlink(lock);
    await this.#syncDirectory();
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

/** A durable, single-writer journal in `directory` (created 0700 when missing). */
export function fileDynamicJournal(directory: string): FileDynamicJournal {
  return new FileJournal(directory);
}
