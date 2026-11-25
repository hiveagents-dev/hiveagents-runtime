import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { checksum, nonempty } from './checkpoint.js';
import type { WorkflowCheckpoint, WorkflowLease, WorkflowStore } from './types.js';

export interface WorkflowOwnership {
  runId: string;
  token: string;
  pid: number;
  host: string;
}

export class WorkflowRunLockedError extends Error {
  constructor(readonly runId: string, readonly lockPath: string) {
    super(`Workflow run ${runId} is already owned; inspect ${lockPath}`);
    this.name = 'WorkflowRunLockedError';
  }
}

const codeIs = (error: unknown, ...codes: string[]): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && codes.includes(String(error.code));

/** Local private-directory store; no network filesystem, distributed fencing or automatic expiry. */
export class FileWorkflowStore implements WorkflowStore {
  readonly directory: string;
  constructor(directory: string) {
    nonempty(directory, 'Workflow directory');
    this.directory = resolve(directory);
  }

  private paths(runId: string) {
    nonempty(runId, 'Run id');
    const base = join(this.directory, checksum(runId));
    return { checkpoint: `${base}.json`, lock: `${base}.lock` };
  }

  async inspectOwnership(runId: string): Promise<WorkflowOwnership | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.paths(runId).lock, 'owner.json'), 'utf8'));
      if (typeof value !== 'object' || value === null) throw new Error('Invalid workflow ownership');
      const owner = value as WorkflowOwnership;
      if (owner.runId !== runId || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.token)
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.host !== 'string') {
        throw new Error('Invalid workflow ownership');
      }
      return owner;
    } catch (error) {
      if (codeIs(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  /**
   * Explicit local crash recovery, never based on age. Refuses a live/reused PID,
   * foreign host or changed token. Caller must ensure orphan external work has stopped.
   * A nonempty tombstone is retained so concurrent recovery cannot move a new owner's lock.
   */
  async recoverAbandoned(runId: string, expectedToken: string, acknowledgement: { ownerStopped: true }): Promise<void> {
    if (acknowledgement?.ownerStopped !== true) throw new Error('Explicitly acknowledge that the owner and its work have stopped');
    const owner = await this.inspectOwnership(runId);
    if (!owner || owner.token !== expectedToken) throw new Error('Workflow ownership token changed');
    if (owner.host !== hostname()) throw new Error('Cannot recover ownership from another host');
    try {
      process.kill(owner.pid, 0);
      throw new Error('Cannot recover workflow ownership while its process is alive');
    } catch (error) {
      if (!codeIs(error, 'ESRCH')) throw error;
    }
    const { lock } = this.paths(runId);
    // A directory rename cannot replace an existing NONEMPTY directory. Retain it:
    // a second recovery with the same token must never move a later owner's lock.
    await rename(lock, `${lock}.recovered-${owner.token}`);
    await this.syncDirectory();
  }

  async acquire(runId: string): Promise<WorkflowLease> {
    const paths = this.paths(runId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const owner: WorkflowOwnership = { runId, token: randomUUID(), pid: process.pid, host: hostname() };
    const prepared = `${paths.lock}.prepare-${owner.token}`;
    await mkdir(prepared, { mode: 0o700 });
    try {
      await this.writeSynced(join(prepared, 'owner.json'), JSON.stringify(owner));
      // The prepared directory is nonempty before it becomes visible as a lock.
      // Existing owners also have nonempty directories, so rename cannot replace one.
      await rename(prepared, paths.lock);
    } catch (error) {
      await rm(prepared, { recursive: true, force: true });
      if (codeIs(error, 'EEXIST', 'ENOTEMPTY')) throw new WorkflowRunLockedError(runId, paths.lock);
      throw error;
    }
    let released = false;
    let operations: Promise<unknown> = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const pending = operations.then(operation);
      operations = pending.catch(() => undefined);
      return pending;
    };
    const assertOwner = async () => {
      if (released || (await this.inspectOwnership(runId))?.token !== owner.token) {
        throw new Error('Workflow ownership lost');
      }
    };
    return {
      load: () => serial(async () => {
        await assertOwner();
        let text: string;
        try { text = await readFile(paths.checkpoint, 'utf8'); }
        catch (error) { if (codeIs(error, 'ENOENT')) return undefined; throw error; }
        const envelope: unknown = JSON.parse(text);
        if (typeof envelope !== 'object' || envelope === null || !('checkpoint' in envelope)
          || !('checksum' in envelope) || envelope.checksum !== checksum(JSON.stringify(envelope.checkpoint))) {
          throw new Error('Corrupt workflow checkpoint checksum');
        }
        return envelope.checkpoint;
      }),
      save: (checkpoint: WorkflowCheckpoint) => {
        // Serializing captures the caller's value now; the envelope embeds that exact text, so
        // load's JSON.stringify(envelope.checkpoint) reproduces it for the checksum.
        const serialized = JSON.stringify(checkpoint);
        const envelope = `{"checksum":${JSON.stringify(checksum(serialized))},"checkpoint":${serialized}}`;
        return serial(async () => {
          await assertOwner();
          const temp = `${paths.checkpoint}.${owner.token}.${randomUUID()}.tmp`;
          try {
            await this.writeSynced(temp, envelope);
            await assertOwner();
            await rename(temp, paths.checkpoint);
            await this.syncDirectory();
          } finally { await rm(temp, { force: true }); }
        });
      },
      release: () => serial(async () => {
        await assertOwner();
        const retired = `${paths.lock}.released-${owner.token}`;
        await rename(paths.lock, retired);
        released = true;
        await rm(retired, { recursive: true });
        await this.syncDirectory();
      }),
    };
  }

  private async writeSynced(path: string, text: string): Promise<void> {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  }
}
