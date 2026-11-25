import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { digest } from '../../shared/json.js';
import { boundedInteger } from './curation-support.js';
import { corrupt, isKey, journalEntry } from './curator-journal-entry.js';
import type { CuratorJournalEntry } from './curator-journal-entry.js';
import type { MemoryScope } from './ports.js';

export { MAX_CONFIRM_WITHIN_MS, MAX_MEASURED_TASKS, MAX_REJECTED, journalEntry } from './curator-journal-entry.js';
export type { CuratorJournalEntry, CuratorPendingTally } from './curator-journal-entry.js';

/**
 * The curator's journal: what earlier passes decided, so a later pass does not retry it.
 *
 * Seven kinds of key, none holding text: a candidate (`candidate:<candidate id>`, which already
 * binds scope and text), a source episode by id (`episode:<digest of scope and episode id>`), a
 * source episode by content (`content:<digest of scope and normalized text>`), shared by every
 * episode of that text, a scope's promotion budget (`promotions:<digest of scope>`), its
 * measurement budget (`measurements:<digest of scope>`), its pending candidates
 * (`pending:<digest of scope>`) and its recent rejections (`rejected:<digest of scope>`), kept as
 * sketches: sorted, truncated hashes of the normalized words of each text, salted by the scope.
 * A sketch, like a candidate id, holds no text, but a dictionary of likely words can be tested
 * against it: keep the journal as private as the store.
 * A journal lost or reset only loses retry protection; it never promotes anything by itself.
 *
 * File format 2 adds the pending, measurement and rejection entries; format 1 files are read as they are.
 */

export interface CuratorJournal {
  get(key: string): Promise<CuratorJournalEntry | undefined>;
  set(key: string, entry: CuratorJournalEntry): Promise<void>;
  /**
   * Optional: replaces the entry with `change(current entry)` as one step. The curator uses it for
   * the scope-wide entries (budgets, pending and rejection indexes) when present; a file journal
   * applies it under its lock on the entry it has just re-read, so passes in separate processes
   * do not lose each other's reservations. Without it the curator reads, then sets.
   */
  update?(key: string, change: (entry: CuratorJournalEntry | undefined) => CuratorJournalEntry): Promise<CuratorJournalEntry>;
}

export interface CuratorJournalOptions {
  /**
   * Entries kept; past it the least recently written go first. Default 10 000, at most 200 000. A file journal
   * also drops its least recently written entries while the file would exceed 64 MiB, the most it reads back.
   */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
/** About 30 MiB of typical entries: comfortably under the file cap, which eviction enforces anyway. */
const MAX_ENTRIES_CEILING = 200_000;
const FORMATS = new Set([1, 2]);

export function candidateJournalKey(candidateId: string): string {
  return `candidate:${candidateId}`;
}

export function episodeJournalKey(scope: MemoryScope, episodeId: string): string {
  return `episode:${digest([scope.tenant, scope.namespace, scope.subject ?? null, episodeId])}`;
}

function checkedKey(key: unknown): string {
  if (!isKey(key)) throw new TypeError('A journal key must be a printable string of 1 to 256 characters');
  return key;
}

/** Map order is write order, so the first entries are the least recently written. */
function write(entries: Map<string, CuratorJournalEntry>, key: string, entry: CuratorJournalEntry, maxEntries: number): void {
  entries.delete(key);
  entries.set(key, entry);
  for (const oldest of entries.keys()) {
    if (entries.size <= maxEntries) break;
    entries.delete(oldest);
  }
}

/** A journal held in memory: it lasts as long as the object. */
export function memoryCuratorJournal(options: CuratorJournalOptions = {}): CuratorJournal {
  const maxEntries = boundedInteger(options.maxEntries, 'maxEntries', 1, MAX_ENTRIES_CEILING, DEFAULT_MAX_ENTRIES);
  const entries = new Map<string, CuratorJournalEntry>();
  return Object.freeze({
    async get(key: string) {
      const entry = entries.get(checkedKey(key));
      return entry && journalEntry(entry);
    },
    async set(key: string, entry: CuratorJournalEntry) {
      write(entries, checkedKey(key), journalEntry(entry), maxEntries);
    },
    async update(key: string, change: (entry: CuratorJournalEntry | undefined) => CuratorJournalEntry) {
      const name = checkedKey(key);
      const current = entries.get(name);
      const next = journalEntry(change(current && journalEntry(current)));
      write(entries, name, next, maxEntries);
      return journalEntry(next);
    },
  });
}

/**
 * The journal as the curator uses it: every entry read back is checked like a stored one, so an
 * application's own journal cannot hand the curator an entry the SDK's journals would refuse
 * (JOURNAL_INVALID, fail-closed).
 */
export function checkedJournal(journal: CuratorJournal): CuratorJournal {
  const { update } = journal;
  return Object.freeze({
    get: async (key: string) => {
      const entry = await journal.get(key);
      return entry === undefined ? undefined : journalEntry(entry);
    },
    set: (key: string, entry: CuratorJournalEntry) => journal.set(key, journalEntry(entry)),
    ...(update ? {
      update: async (key: string, change: (entry: CuratorJournalEntry | undefined) => CuratorJournalEntry) =>
        journalEntry(await update.call(journal, key, entry => journalEntry(change(entry === undefined ? undefined : journalEntry(entry))))),
    } : {}),
  });
}

const processJournals = new WeakMap<object, CuratorJournal>();

/** The default journal: one per store object, for the life of this process. */
export function processCuratorJournal(store: object): CuratorJournal {
  let journal = processJournals.get(store);
  if (!journal) {
    journal = memoryCuratorJournal();
    processJournals.set(store, journal);
  }
  return journal;
}

/**
 * A journal kept in one JSON file, so retry protections survive restarts. Every `set` rewrites
 * the file atomically (a temporary file in the same directory, then a rename) with mode 0600,
 * dropping the least recently written entries while the file would exceed 64 MiB (the most a
 * read accepts). An unreadable or invalid file fails every call with JOURNAL_INVALID
 * (fail-closed: fix or delete it).
 *
 * Journals opened on one path in one process share one state (keyed by the resolved path) and
 * one write queue. Every `set` takes an advisory lock file (`<path>.lock`, created exclusively),
 * re-reads the file if anything else wrote it, applies its entry and writes the result, so
 * writers in separate processes merge instead of overwriting each other. A lock older than 30 s
 * is taken as abandoned and broken; a `set` that cannot take the lock within 5 s fails with
 * JOURNAL_LOCKED and changes nothing, and so at once does one that finds anything but a regular
 * file at `<path>.lock` (a symlink, even a dangling one, is refused, never followed or broken). `get` re-reads the file when its identity, size or mtime
 * changed. The lock is advisory: a writer that ignores it can still lose entries.
 */
export function fileCuratorJournal(path: string, options: CuratorJournalOptions = {}): CuratorJournal {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new TypeError('path must be a file path');
  const maxEntries = boundedInteger(options.maxEntries, 'maxEntries', 1, MAX_ENTRIES_CEILING, DEFAULT_MAX_ENTRIES);
  const file = journalFile(path);
  return Object.freeze({
    async get(key: string) {
      const name = checkedKey(key);
      const entry = (await current(file)).get(name);
      return entry && journalEntry(entry);
    },
    set(key: string, entry: CuratorJournalEntry) {
      const checked = journalEntry(entry);
      return writeEntry(file, checkedKey(key), () => checked, maxEntries).then(() => undefined);
    },
    update(key: string, change: (entry: CuratorJournalEntry | undefined) => CuratorJournalEntry) {
      return writeEntry(file, checkedKey(key), entry => journalEntry(change(entry && journalEntry(entry))), maxEntries);
    },
  });
}

/**
 * Under the lock: re-reads the file if anything else wrote it, applies `next` to the entry found
 * there and writes the result. One queue per path, so this process's writers never interleave.
 */
function writeEntry(
  file: JournalFile, name: string, next: (entry: CuratorJournalEntry | undefined) => CuratorJournalEntry, maxEntries: number,
): Promise<CuratorJournalEntry> {
  const run = file.queue.then(() => locked(file.path, async () => {
    const entries = new Map(await current(file));
    const entry = next(entries.get(name));
    write(entries, name, entry, maxEntries);
    await writeAtomically(file.path, serializedWithinCap(entries));
    // Only a written file changes what this journal answers.
    file.cache = { stamp: await stampOf(file.path), entries };
    return journalEntry(entry);
  }));
  file.queue = run.catch(() => undefined);
  return run;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

interface JournalFile {
  path: string;
  queue: Promise<unknown>;
  cache?: { stamp: string; entries: Map<string, CuratorJournalEntry> };
}

/** One state per resolved path, for the life of the process. */
const journalFiles = new Map<string, JournalFile>();

function journalFile(path: string): JournalFile {
  const absolute = resolve(path);
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    try {
      resolved = join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      // Neither exists yet: the plain resolved path names it.
    }
  }
  let file = journalFiles.get(resolved);
  if (!file) {
    file = { path: resolved, queue: Promise.resolve() };
    journalFiles.set(resolved, file);
  }
  return file;
}

/** Identity, size and modification time of the file, or `absent`. */
async function stampOf(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/** The file's entries, read again only when the file changed since they were cached. */
async function current(file: JournalFile): Promise<Map<string, CuratorJournalEntry>> {
  const stamp = await stampOf(file.path);
  if (file.cache?.stamp === stamp) return file.cache.entries;
  const entries = stamp === 'absent' ? new Map<string, CuratorJournalEntry>() : await readJournal(file.path);
  // Cached only when the file did not change while it was read.
  if (await stampOf(file.path) === stamp) file.cache = { stamp, entries };
  return entries;
}

/** The file text, after dropping the least recently written entries until it fits the read cap. */
function serializedWithinCap(entries: Map<string, CuratorJournalEntry>): string {
  const parts = [...entries].map(pair => JSON.stringify(pair));
  const head = '{"format":2,"entries":[';
  const tail = ']}';
  let bytes = Buffer.byteLength(head) + Buffer.byteLength(tail) + parts.reduce((total, part) => total + Buffer.byteLength(part) + 1, 0);
  let first = 0;
  const keys = [...entries.keys()];
  // The newest entry, the one being written, is always kept: a single entry is far below the cap.
  while (bytes > MAX_FILE_BYTES && first < parts.length - 1) {
    bytes -= Buffer.byteLength(parts[first]!) + 1;
    entries.delete(keys[first]!);
    first += 1;
  }
  return `${head}${parts.slice(first).join(',')}${tail}`;
}

function lockError(): Error {
  return Object.assign(new Error('The curator journal is locked by another writer'), { name: 'CuratorJournalError', code: 'JOURNAL_LOCKED' });
}

/** Runs `work` holding `<path>.lock`, created exclusively; breaks a lock older than LOCK_STALE_MS. */
async function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'EEXIST') throw error;
      const gone = await brokeStale(lock);
      // Every attempt checks the deadline and waits a little, so the wait is bounded and never spins.
      if (Date.now() - started >= LOCK_WAIT_MS) throw lockError();
      await new Promise(done => setTimeout(done, gone ? 1 : LOCK_RETRY_MS));
    }
  }
  try {
    return await work();
  } finally {
    // Removed only while it is still ours: a lock broken as stale may belong to another writer now.
    const holder = await readFile(lock, 'utf8').catch(() => undefined);
    if (holder === token) await rm(lock, { force: true }).catch(() => undefined);
  }
}

/**
 * True when the lock is gone or was stale and is now removed: the caller tries again soon. The lock
 * path itself is examined, never followed: anything there but a regular file (a symlink, dangling
 * or not, a directory) is not a lock this journal writes, is never broken, and fails JOURNAL_LOCKED.
 */
async function brokeStale(lock: string): Promise<boolean> {
  let age: number;
  try {
    const info = await lstat(lock);
    if (!info.isFile()) throw lockError();
    age = Date.now() - info.mtimeMs;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return true;
    throw error;
  }
  if (age <= LOCK_STALE_MS) return false;
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await rename(lock, aside);
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return true;
    throw error;
  }
  // Another breaker may have replaced the stale lock with a fresh one just before the rename: put a fresh one back.
  const fresh = await lstat(aside).then(info => Date.now() - info.mtimeMs <= LOCK_STALE_MS, () => false);
  if (fresh) await link(aside, lock).catch(() => undefined);
  await rm(aside, { force: true }).catch(() => undefined);
  return !fresh;
}

async function readJournal(path: string): Promise<Map<string, CuratorJournalEntry>> {
  let text: string;
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw corrupt();
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ENOENT') return new Map();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  const body = parsed as { format?: unknown; entries?: unknown };
  // Format 1 entries are valid format 2 entries: the migration is reading them as they are.
  if (!body || typeof body !== 'object' || !FORMATS.has(body.format as number) || !Array.isArray(body.entries)) throw corrupt();
  const entries = new Map<string, CuratorJournalEntry>();
  for (const pair of body.entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isKey(pair[0])) throw corrupt();
    entries.set(pair[0], journalEntry(pair[1]));
  }
  return entries;
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
