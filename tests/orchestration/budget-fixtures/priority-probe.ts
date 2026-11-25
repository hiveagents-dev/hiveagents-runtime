import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WAITERS_SCHEMA } from '../../../src/orchestration/budget/priority.ts';

/**
 * Test instruments for the priority rule. They make a test independent of which waiter happens to
 * wake first: the production waiter is held still at a safe point while the canary is made to try.
 */

export interface DeclaredWaiter {
  /** 0 is `low`, 1 is `normal`. */
  priority: number;
  /** When this waiter last attempted admission: it is renewed on every refused attempt. */
  seenAt: number;
}

function raw(file: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Who is declared as waiting, read through an independent read-only connection. */
export function waiting(file: string): DeclaredWaiter[] {
  const db = raw(file, true);
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'budget_waiters'").get();
    if (!exists) return [];
    return db.prepare('SELECT priority, seen_at AS seenAt FROM budget_waiters ORDER BY priority').all() as unknown as DeclaredWaiter[];
  } finally {
    db.close();
  }
}

/** The last attempt of the one waiting canary, or undefined once it is no longer waiting. */
export function canaryLastAttempt(file: string): number | undefined {
  return waiting(file).find(waiter => waiter.priority === 0)?.seenAt;
}

export async function until(condition: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** True when the promise has not settled after `ms`. */
export async function stillPending(promise: Promise<unknown>, ms = 150): Promise<boolean> {
  const pending = Symbol('pending');
  const winner = await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(pending), ms))]);
  return winner === pending;
}

/** Frees a slot behind the ledger's back. No bell rings, so every waiter stays asleep. */
export function freeSilently(file: string, token: string): void {
  const db = raw(file);
  try {
    db.prepare('UPDATE budget_reservations SET released = 1 WHERE token = ?').run(token);
  } finally {
    db.close();
  }
}

/** Wakes every waiter of this ledger file, as a release does. */
export function ring(file: string): void {
  writeFileSync(`${file}.bell`, String(process.hrtime.bigint()));
}

/**
 * Installs a witness inside the ledger file: SQLite itself records, within the admitting
 * transaction of whichever process commits it, every canary admitted while a production launch is
 * declared waiting. Canary owners are recognised by the word `canary` in their owner name.
 */
export function witnessJumps(file: string): void {
  const db = raw(file);
  try {
    db.exec(`${WAITERS_SCHEMA}
      CREATE TABLE test_canary_jumps (owner TEXT NOT NULL) STRICT;
      CREATE TRIGGER test_canary_jump AFTER INSERT ON budget_reservations
      WHEN NEW.owner LIKE '%canary%' AND EXISTS (
        SELECT 1 FROM budget_waiters WHERE provider_key = NEW.provider_key AND priority > 0)
      BEGIN
        INSERT INTO test_canary_jumps(owner) VALUES (NEW.owner);
      END;`);
  } finally {
    db.close();
  }
}

/** Owners of the canaries the witness saw jump ahead of a waiting production launch. */
export function jumps(file: string): string[] {
  const db = raw(file, true);
  try {
    return db.prepare('SELECT owner FROM test_canary_jumps').all().map(row => String(row.owner));
  } finally {
    db.close();
  }
}

/** One independent process that waits for a slot of `claude` and reports when it is admitted. */
export interface LedgerProcess {
  child: ChildProcess;
  owner: string;
  admitted(): boolean;
  /** Throws if the process exited with an error. */
  check(): true;
  /**
   * Blocks the process's event loop between two of its own steps, so it holds no transaction and
   * cannot attempt admission. Its declaration stays in the file. Resolves once it is blocked.
   */
  stall(): Promise<void>;
  resume(): void;
  /** Releases its slot and lets the process exit. */
  finish(): void;
}

export function ledgerProcess(file: string, owner: string, priority: 'low' | 'normal', children: ChildProcess[]): LedgerProcess {
  const child = fork(fileURLToPath(new URL('./priority-worker.ts', import.meta.url)), [file, owner, priority], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let admitted = false;
  let stderr = '';
  let failure: string | undefined;
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('message', (message: { event: string }) => { if (message.event === 'admitted') admitted = true; });
  child.on('exit', code => { if (code !== 0 && code !== null) failure = `${owner} exited ${code}: ${stderr}`; });
  const check = (): true => {
    if (failure !== undefined) throw new Error(failure);
    return true;
  };
  return {
    child,
    owner,
    admitted: () => admitted,
    check,
    async stall() {
      child.send('stall');
      await until(() => check() && existsSync(`${file}.${owner}.stalled`), `${owner} to be stalled`);
    },
    resume() {
      writeFileSync(`${file}.${owner}.resume`, '');
    },
    finish() {
      child.send('release');
    },
  };
}
