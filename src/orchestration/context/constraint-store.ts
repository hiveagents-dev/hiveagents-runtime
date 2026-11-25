import { randomUUID, type KeyObject } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../shared/json.js';
import { busyTimeout } from '../budget/validation.ts';
import { assertAuthority, publicKeyOf, readPublicKey, signAs, verifies, type ConstraintAuthority } from './authority.ts';
import {
  ConstraintConflictError,
  ConstraintIntegrityError,
  type ConstraintRef,
  type ConstraintRevocation,
  type ConstraintStoreCreateOptions,
  type ConstraintStoreOptions,
  type ConstraintVersion,
  type ConstraintWrite,
  type PinnedConstraint,
} from './types.ts';
import * as check from './validation.ts';

/**
 * `node:sqlite` loads only when a store is opened or created, never when this module is imported:
 * the core imports this module for the Agent `pinned` option and must not load SQLite (or print
 * its experimental warning) for an application that never uses it.
 */
function openDatabase(path: string): DatabaseSync {
  return new (process.getBuiltinModule('node:sqlite').DatabaseSync)(path);
}

/** Reads through the private reader; assigned once by the class's static block. */
let readLatest: (store: ConstraintStore, scopes: readonly string[]) => ConstraintVersion[];

const SCHEMA = `
CREATE TABLE context_constraint_store (
  name TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE context_constraints (
  scope TEXT NOT NULL,
  constraint_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  text TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL CHECK(set_at BETWEEN 0 AND 9007199254740991),
  reason TEXT,
  signature BLOB NOT NULL,
  PRIMARY KEY (scope, constraint_id, version)
) STRICT;
CREATE TRIGGER context_constraints_no_update BEFORE UPDATE ON context_constraints
BEGIN SELECT RAISE(ABORT, 'context_constraints is append-only'); END;
CREATE TRIGGER context_constraints_no_delete BEFORE DELETE ON context_constraints
BEGIN SELECT RAISE(ABORT, 'context_constraints is append-only'); END;
`;

interface Row {
  scope: string;
  constraint_id: string;
  version: number;
  status: string;
  text: string;
  set_by: string;
  set_at: number;
  reason: string | null;
  signature: Uint8Array;
}

/**
 * The exact bytes the owner signs: the store the version belongs to and every field of it,
 * in canonical JSON. A row copied into another store of the same owner does not verify there.
 */
function signedBytes(storeId: string, entry: ConstraintVersion): Buffer {
  return Buffer.from(canonical({
    format: 2,
    store: storeId,
    scope: entry.scope,
    id: entry.id,
    version: entry.version,
    status: entry.status,
    text: entry.text,
    setBy: entry.setBy,
    setAt: entry.setAt,
    reason: entry.reason ?? null,
  }), 'utf8');
}

function pinnedOf(entry: ConstraintVersion): PinnedConstraint {
  const { status: _status, reason: _reason, ...pinned } = entry;
  return pinned;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function setting(db: DatabaseSync, name: string): string | undefined {
  const row = db.prepare('SELECT value FROM context_constraint_store WHERE name = ?').get(name) as { value: string } | undefined;
  return row?.value;
}

/**
 * Durable, append-only constraints for one owner.
 *
 * The owner makes the file once with `ConstraintStore.create`, which needs the
 * `ConstraintAuthority`. `new ConstraintStore` only opens a file that is already a store of
 * that owner: a missing, empty or foreign file throws `ConstraintIntegrityError`, and nothing
 * is created. Never fall back to `create` when opening fails; that would replace the owner's
 * constraints with an empty set.
 *
 * Reading needs only the owner's public key. Writing needs the authority object: there is no
 * method that turns text into a constraint without it. Every version is signed together with
 * the id of its store, and every read verifies the signature, so a row rewritten, inserted or
 * copied from another store by any other path makes the read throw `ConstraintIntegrityError`.
 *
 * Not covered by the store alone: removing the newest versions of a constraint, removing a
 * constraint whole, or putting back an older copy of the file. What is left is a valid signed
 * history. A caller detects that by stating what it last saw (`require` in `compileContext`).
 */
export class ConstraintStore {
  readonly #db: DatabaseSync;
  readonly #id: string;
  readonly #publicKeyText: string;
  readonly #publicKey: KeyObject;
  readonly #now: () => number;

  /** Opens an existing store. It never creates the file, its directory or the schema. */
  constructor(options: ConstraintStoreOptions) {
    check.closed(options, ['databasePath', 'publicKey', 'storeId', 'busyTimeoutMs', 'now'], ['storeId', 'busyTimeoutMs', 'now'], 'ConstraintStore options');
    check.databasePath(options.databasePath);
    busyTimeout(options.busyTimeoutMs);
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (options.storeId !== undefined) {
      check.storeId(options.storeId);
    }
    this.#publicKey = readPublicKey(options.publicKey);
    this.#publicKeyText = options.publicKey;
    this.#now = options.now ?? Date.now;
    if (!isFile(options.databasePath)) {
      throw new ConstraintIntegrityError(`There is no constraint store at ${options.databasePath}; opening never creates one`);
    }
    this.#db = openDatabase(options.databasePath);
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
      this.#id = this.#adopt(options.storeId);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  static {
    readLatest = (store, scopes) => store.#latest(scopes);
  }

  /**
   * Makes a new, empty store for the holder of `authority` and opens it. Refuses a path where
   * any file already exists, so it can never stand in for a store that was lost.
   */
  static create(authority: ConstraintAuthority, options: ConstraintStoreCreateOptions): ConstraintStore {
    check.closed(options, ['databasePath', 'busyTimeoutMs', 'now'], ['busyTimeoutMs', 'now'], 'ConstraintStore.create options');
    check.databasePath(options.databasePath);
    const publicKey = publicKeyOf(authority);
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    try {
      // Exclusive: fails when the path exists, whoever put the file there.
      closeSync(openSync(options.databasePath, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConstraintConflictError(`${options.databasePath} already exists; create never replaces a file`);
      }
      throw error;
    }
    const storeId = randomUUID();
    try {
      const db = openDatabase(options.databasePath);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(SCHEMA);
        const insert = db.prepare('INSERT INTO context_constraint_store(name, value) VALUES (?, ?)');
        insert.run('public_key', publicKey);
        insert.run('store_id', storeId);
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      return new ConstraintStore({ ...options, publicKey, storeId });
    } catch (error) {
      rmSync(options.databasePath, { force: true });
      throw error;
    }
  }

  /** Checks that the file is a store of this owner, and of the expected id when one was given. */
  #adopt(expectedId: string | undefined): string {
    let publicKey: string | undefined;
    let storeId: string | undefined;
    try {
      publicKey = setting(this.#db, 'public_key');
      storeId = setting(this.#db, 'store_id');
    } catch {
      throw new ConstraintIntegrityError('The file is not a constraint store');
    }
    if (publicKey !== this.#publicKeyText) {
      throw new ConstraintIntegrityError('The constraint store belongs to another authority');
    }
    if (storeId === undefined || (expectedId !== undefined && storeId !== expectedId)) {
      throw new ConstraintIntegrityError('The file is not the constraint store the caller expects');
    }
    return storeId;
  }

  /**
   * Identifies this file among the stores of one owner. Keep it next to the public key and pass
   * it as `storeId` when opening, so another store's file cannot be put in its place.
   */
  get id(): string {
    return this.#id;
  }

  /** True only for a real store: not a subclass stand-in, a look-alike object or a proxy. */
  static is(value: unknown): value is ConstraintStore {
    return typeof value === 'object' && value !== null && #db in value;
  }

  /** Sets a constraint or replaces its text. The new version is `expectedVersion + 1`. */
  pin(authority: ConstraintAuthority, write: ConstraintWrite): PinnedConstraint {
    check.closed(write, ['scope', 'id', 'text', 'setBy', 'expectedVersion'], [], 'A constraint write');
    check.name(write.scope, 'scope');
    check.name(write.id, 'id');
    check.text(write.text, 'text', check.MAX_CONSTRAINT_BYTES);
    check.label(write.setBy, 'setBy');
    check.version(write.expectedVersion, 'expectedVersion');
    assertAuthority(authority, this.#publicKeyText);
    const entry = this.#append(authority, write.scope, write.id, write.expectedVersion, () => ({
      status: 'active',
      text: write.text,
      setBy: write.setBy,
    }));
    return pinnedOf(entry);
  }

  /** Ends a constraint. The revocation is a signed version like any other. */
  revoke(authority: ConstraintAuthority, revocation: ConstraintRevocation): ConstraintRef {
    check.closed(revocation, ['scope', 'id', 'setBy', 'reason', 'expectedVersion'], [], 'A constraint revocation');
    check.name(revocation.scope, 'scope');
    check.name(revocation.id, 'id');
    check.label(revocation.setBy, 'setBy');
    check.text(revocation.reason, 'reason', 1024);
    check.version(revocation.expectedVersion, 'expectedVersion');
    assertAuthority(authority, this.#publicKeyText);
    const entry = this.#append(authority, revocation.scope, revocation.id, revocation.expectedVersion, (current) => {
      if (current?.status !== 'active') {
        throw new ConstraintConflictError(`${revocation.scope}/${revocation.id} is not active`);
      }
      return { status: 'revoked', text: current.text, setBy: revocation.setBy, reason: revocation.reason };
    });
    return { scope: entry.scope, id: entry.id, version: entry.version };
  }

  /** Verified active constraints, in the order of `scopes`, then by id. */
  active(scopes: readonly string[]): readonly PinnedConstraint[] {
    return this.#latest(scopes).filter((entry) => entry.status === 'active').map(pinnedOf);
  }

  /**
   * The verified newest version of every constraint in `scopes`, revoked ones included, in the
   * order of `scopes`, then by id. This is what a caller remembers to detect a rollback later.
   */
  latest(scopes: readonly string[]): readonly ConstraintVersion[] {
    return this.#latest(scopes);
  }

  #latest(scopes: readonly string[]): ConstraintVersion[] {
    check.scopes(scopes);
    const newest = this.#db.prepare(`
      SELECT c.*, s.total FROM context_constraints c
      JOIN (SELECT constraint_id, MAX(version) AS latest, COUNT(*) AS total
            FROM context_constraints WHERE scope = ? GROUP BY constraint_id) s
        ON s.constraint_id = c.constraint_id AND s.latest = c.version
      WHERE c.scope = ? ORDER BY c.constraint_id`);
    const result: ConstraintVersion[] = [];
    for (const scope of scopes) {
      for (const row of newest.all(scope, scope) as unknown as Array<Row & { total: number }>) {
        if (row.total !== row.version) {
          throw new ConstraintIntegrityError(`${scope}/${row.constraint_id} is missing versions`);
        }
        result.push(this.#verified(row));
      }
    }
    return result;
  }

  /** Every version of one constraint, oldest first, each verified. */
  history(scope: string, id: string): readonly ConstraintVersion[] {
    check.name(scope, 'scope');
    check.name(id, 'id');
    const rows = this.#db.prepare('SELECT * FROM context_constraints WHERE scope = ? AND constraint_id = ? ORDER BY version')
      .all(scope, id) as unknown as Row[];
    return rows.map((row, index) => {
      if (row.version !== index + 1) {
        throw new ConstraintIntegrityError(`${scope}/${id} is missing versions`);
      }
      return this.#verified(row);
    });
  }

  /** Safe to call more than once. */
  close(): void {
    if (this.#db.isOpen) {
      this.#db.close();
    }
  }

  #append(
    authority: ConstraintAuthority,
    scope: string,
    id: string,
    expectedVersion: number,
    next: (current: ConstraintVersion | undefined) => Pick<ConstraintVersion, 'status' | 'text' | 'setBy' | 'reason'>,
  ): ConstraintVersion {
    const setAt = this.#now();
    check.version(setAt, 'now()');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM context_constraints WHERE scope = ? AND constraint_id = ? ORDER BY version DESC LIMIT 1')
        .get(scope, id) as unknown as Row | undefined;
      const current = row === undefined ? undefined : this.#verified(row);
      if ((current?.version ?? 0) !== expectedVersion) {
        throw new ConstraintConflictError(`${scope}/${id} is at version ${current?.version ?? 0}, not ${expectedVersion}`);
      }
      const entry: ConstraintVersion = { scope, id, version: expectedVersion + 1, setAt, ...next(current) };
      const signature = signAs(authority, this.#publicKeyText, signedBytes(this.#id, entry));
      this.#db.prepare(`INSERT INTO context_constraints(scope, constraint_id, version, status, text, set_by, set_at, reason, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope, id, entry.version, entry.status, entry.text, entry.setBy, setAt, entry.reason ?? null, signature);
      return entry;
    });
  }

  #verified(row: Row): ConstraintVersion {
    const entry: ConstraintVersion = {
      scope: row.scope,
      id: row.constraint_id,
      version: row.version,
      text: row.text,
      setBy: row.set_by,
      setAt: row.set_at,
      status: row.status === 'revoked' ? 'revoked' : 'active',
      ...(row.reason === null ? {} : { reason: row.reason }),
    };
    if (!verifies(this.#publicKey, signedBytes(this.#id, entry), row.signature)) {
      throw new ConstraintIntegrityError(`${row.scope}/${row.constraint_id} v${row.version} was not written by the owner's authority`);
    }
    return entry;
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** True only for a real store: not a subclass stand-in, a look-alike object or a proxy. */
export function isConstraintStore(value: unknown): value is ConstraintStore {
  return ConstraintStore.is(value);
}

/**
 * The verified newest versions, read through the store's private reader: a `latest` replaced on
 * the instance, a subclass or the prototype is never what the caller gets.
 */
export function latestOf(store: unknown, scopes: readonly string[]): readonly ConstraintVersion[] {
  if (!ConstraintStore.is(store)) throw new TypeError('constraints must be a ConstraintStore');
  return readLatest(store, scopes);
}
