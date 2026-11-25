import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { DynamicIsolation } from './types.js';
import {
  DynamicIsolationError, git, isInside, isLeafName, isSafeRefPath, parseWorktrees, realpathNearest, requireSafe, shortKey,
  type WorktreeEntry,
} from './isolation-git.js';
import { removableWorktree, worktreeChanged } from './isolation-worktree.js';

export { DynamicIsolationError, type DynamicIsolationErrorCode } from './isolation-git.js';

/**
 * Per-agent git worktrees for dynamic workflows.
 *
 * `create` adds `<root>/<runId>/<leaf>` on a new branch `<branchPrefix><runId>/<leaf>` from
 * `baseRef`, where `<leaf>` is a slug of the call's label plus a digest of its key; calling it again
 * for the same run and key (a resumed run) reuses that worktree. `inspect` reports whether the agent
 * changed anything there: modified, staged, untracked or ignored files, commits beyond `baseRef`, or
 * a HEAD moved off the branch. `cleanupWorktrees` removes a run's unchanged worktrees and their
 * branches; a changed or untrusted one is never removed and nothing is ever forced. Every worktree
 * directory of the run whose branch still exists is in its report, including one whose registration
 * the agent rewrote (kept, as changed).
 *
 * A worktree is a separate working tree of the same repository, not a sandbox: the agent runs as the
 * user and can reach anything the user can, within what its permissions allow. The application
 * reviews, merges or discards each changed worktree; nothing here merges.
 *
 * `root` must be outside the repository's working tree, or inside it only where git ignores it (for
 * example a `.worktrees/` line in `.gitignore`): otherwise every worktree would show up as untracked
 * files of the main checkout. That is checked on first use (ROOT_INSIDE_REPOSITORY). The SDK's git
 * commands run without a shell, with the repository's hooks and fsmonitor disabled, without system
 * or global attribute files, without any inherited `GIT_*` variable and under a deadline. Git never
 * discovers the repository from inside a worktree: see `isolation-worktree.ts` for how a worktree is
 * trusted (WORKTREE_UNTRUSTED otherwise) and which filters configured outside it can still run.
 */
export interface GitWorktreeIsolationOptions {
  /** Absolute path of a git repository (any directory of its working tree). */
  repository: string;
  /** Absolute directory the worktrees go under; created when missing. */
  root: string;
  /** Commit the worktrees branch from. Default 'HEAD', resolved once per isolation. */
  baseRef?: string;
  /** Default 'oar/dw/'. */
  branchPrefix?: string;
  /** What `cleanupWorktrees` keeps by default: 'changed' (default) removes unchanged ones; 'always' removes nothing. */
  keep?: 'changed' | 'always';
  /** Deadline of each git command. Default 60 000 ms. */
  gitTimeoutMs?: number;
}

/**
 * Why a worktree was kept without a verdict on its contents (it then reports `changed: true`):
 * - `untrusted`: its `.git`, registration or admin directory is not what git wrote (WORKTREE_UNTRUSTED),
 *   or git would read a per-worktree configuration of it to remove it;
 * - `missing`: registered but its directory is gone (or not registered there at all);
 * - `failed`: a git command or file check on it failed (an unreadable index, a deadline, ...).
 */
export type WorktreeKeptReason = 'untrusted' | 'missing' | 'failed';

export interface WorktreeCleanupReport {
  /** `branchDeleted` is false when the branch moved after it was inspected (or could not be deleted): it is then left in place. */
  readonly removed: ReadonlyArray<{ readonly path: string; readonly branch: string; readonly branchDeleted: boolean }>;
  readonly kept: ReadonlyArray<{ readonly path: string; readonly branch: string; readonly changed: boolean; readonly reason?: WorktreeKeptReason }>;
}

export interface GitWorktreeIsolation extends DynamicIsolation {
  /** Removes the run's unchanged worktrees and branches (keep 'changed'); never a changed one. */
  cleanupWorktrees(options: { runId: string; keep?: 'changed' | 'always'; signal?: AbortSignal }): Promise<WorktreeCleanupReport>;
}

interface Setup { readonly top: string; readonly common: string; readonly root: string; readonly base: string; readonly timeoutMs: number }

export function gitWorktreeIsolation(options: GitWorktreeIsolationOptions): GitWorktreeIsolation {
  if (!options || typeof options !== 'object') throw new TypeError('gitWorktreeIsolation needs an options object');
  const { repository, root } = options;
  if (typeof repository !== 'string' || !isAbsolute(repository)) throw new TypeError('repository must be an absolute path');
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('root must be an absolute path');
  const baseRef = options.baseRef ?? 'HEAD';
  if (!isSafeRefPath(baseRef)) throw new TypeError('baseRef must be a plain ref name ([A-Za-z0-9._/-], no "..")');
  const prefix = options.branchPrefix ?? 'oar/dw/';
  if (typeof prefix !== 'string' || !isSafeRefPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix, 64)) {
    throw new TypeError('branchPrefix must be a plain ref prefix such as "oar/dw/"');
  }
  const defaultKeep = options.keep ?? 'changed';
  if (defaultKeep !== 'changed' && defaultKeep !== 'always') throw new TypeError("keep must be 'changed' or 'always'");
  const timeoutMs = options.gitTimeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) throw new TypeError('gitTimeoutMs must be a positive integer');

  const run = (cwd: string, subcommand: string, args: readonly string[], signal?: AbortSignal, accept?: readonly number[]) =>
    git(args, { cwd, subcommand, timeoutMs, signal, ...(accept ? { accept } : {}) });

  // Resolved once and shared: not tied to the signal of whichever call came first (each git step has its deadline).
  let setup: Promise<Setup> | undefined;
  const ready = async (signal?: AbortSignal): Promise<Setup> => {
    if (signal?.aborted) throw new DynamicIsolationError('ABORTED');
    setup ??= prepare().catch((error: unknown) => { setup = undefined; throw error; });
    return setup;
  };
  async function prepare(): Promise<Setup> {
    const directory = await realpath(repository).catch(() => { throw new DynamicIsolationError('NOT_A_REPOSITORY'); });
    const { code, stdout } = await run(directory, 'rev-parse', ['rev-parse', '--show-toplevel'], undefined, [128]).catch((error: unknown) => {
      if (error instanceof DynamicIsolationError && error.code === 'GIT_FAILED') throw new DynamicIsolationError('NOT_A_REPOSITORY');
      throw error;
    });
    if (code !== 0 || !stdout.trim()) throw new DynamicIsolationError('NOT_A_REPOSITORY');
    const top = await realpath(stdout.trim());
    const wanted = await realpathNearest(resolve(root));
    if (isInside(top, wanted)) {
      if (wanted === top || isInside(join(top, '.git'), wanted)) throw new DynamicIsolationError('ROOT_INSIDE_REPOSITORY');
      // Exit 0: ignored. 1: not ignored. The trailing separator makes a `dir/` pattern match a missing directory.
      const ignored = await run(top, 'check-ignore', ['check-ignore', '-q', `${wanted}${sep}`], undefined, [1]);
      if (ignored.code !== 0) throw new DynamicIsolationError('ROOT_INSIDE_REPOSITORY');
    }
    await mkdir(wanted, { recursive: true });
    const resolved = await run(top, 'rev-parse', ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`], undefined, [1]);
    if (resolved.code !== 0) throw new DynamicIsolationError('INVALID_INPUT', { reason: 'baseRef does not name a commit' });
    // The admin directories of the worktrees live here; found from the repository, never from a worktree.
    const common = (await run(top, 'rev-parse', ['rev-parse', '--git-common-dir'])).stdout.trim();
    if (!common) throw new DynamicIsolationError('NOT_A_REPOSITORY');
    return { top, common: await realpath(resolve(top, common)), root: await realpath(wanted), base: resolved.stdout.trim(), timeoutMs };
  }

  // Worktree and ref mutations of this isolation run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const list = async (top: string, signal?: AbortSignal): Promise<WorktreeEntry[]> =>
    parseWorktrees((await run(top, 'worktree list', ['worktree', 'list', '--porcelain', '-z'], signal)).stdout);

  const tip = async (top: string, branch: string, signal?: AbortSignal): Promise<string | undefined> => {
    const { code, stdout } = await run(top, 'rev-parse', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], signal, [1]);
    return code === 0 ? stdout.trim() : undefined;
  };

  const untrusted = (error: unknown) => error instanceof DynamicIsolationError && error.code === 'WORKTREE_UNTRUSTED';

  const ownWorktree = (state: Setup, path: unknown, branch: unknown): { path: string; branch: string } => {
    if (typeof path !== 'string' || !isAbsolute(path) || !isInside(state.root, resolve(path)) || resolve(path) === state.root) {
      throw new DynamicIsolationError('INVALID_INPUT', { reason: 'path is not under the worktree root' });
    }
    if (!isSafeRefPath(branch, 400) || !branch.startsWith(prefix)) {
      throw new DynamicIsolationError('INVALID_INPUT', { reason: 'branch is not one of this isolation' });
    }
    return { path: resolve(path), branch };
  };

  return {
    async create(request) {
      const runId = requireSafe(request?.runId, 'runId', 128);
      const key = request.key;
      if (typeof key !== 'string' || key.length === 0 || key.length > 4096) throw new DynamicIsolationError('INVALID_INPUT', { reason: 'key' });
      if (request.label !== undefined && typeof request.label !== 'string') throw new DynamicIsolationError('INVALID_INPUT', { reason: 'label' });
      const { signal } = request;
      const state = await ready(signal);
      const leaf = shortKey(key, request.label);
      const path = join(state.root, ...runId.split('/'), leaf);
      const branch = requireSafe(`${prefix}${runId}/${leaf}`, 'branch', 400);
      return exclusive(async () => {
        if (signal?.aborted) throw new DynamicIsolationError('ABORTED');
        const entries = await list(state.top, signal);
        const here = entries.find(entry => resolve(entry.path) === path);
        if (here) {
          if (here.branch !== `refs/heads/${branch}`) throw new DynamicIsolationError('WORKTREE_CONFLICT', { reason: 'path' });
          if (!here.prunable && existsSync(path)) return { path, branch };
          // Registered but its directory is gone: drop the stale registration and add it again.
          await run(state.top, 'worktree prune', ['worktree', 'prune']);
        } else if (entries.some(entry => entry.branch === `refs/heads/${branch}`)) {
          throw new DynamicIsolationError('WORKTREE_CONFLICT', { reason: 'branch' });
        }
        if (existsSync(path)) throw new DynamicIsolationError('WORKTREE_CONFLICT', { reason: 'path' });
        await mkdir(dirname(path), { recursive: true });
        const existing = await tip(state.top, branch, signal);
        // Not abortable once started (only its deadline applies): a checkout killed half-way would
        // leave a registered worktree with part of the files, which a resumed run would then reuse.
        await run(state.top, 'worktree add', existing === undefined
          ? ['worktree', 'add', '-b', branch, path, state.base]
          : ['worktree', 'add', path, branch]);
        return { path, branch };
      });
    },

    async inspect(worktree) {
      const state = await ready();
      const { path, branch } = ownWorktree(state, worktree?.path, worktree?.branch);
      return { changed: await worktreeChanged(state, path, branch) };
    },

    async cleanupWorktrees(request) {
      const runId = requireSafe(request?.runId, 'runId', 128);
      const { keep = defaultKeep, signal } = request;
      if (keep !== 'changed' && keep !== 'always') throw new DynamicIsolationError('INVALID_INPUT', { reason: 'keep' });
      const state = await ready(signal);
      const runRoot = join(state.root, ...runId.split('/'));
      return exclusive(async () => {
        const removed: Array<{ path: string; branch: string; branchDeleted: boolean }> = [];
        const kept: Array<{ path: string; branch: string; changed: boolean; reason?: WorktreeKeptReason }> = [];
        const entries = await list(state.top, signal);
        const keepFor = (path: string, branch: string, reason: WorktreeKeptReason) => kept.push({ path, branch, changed: true, reason });
        // Every leaf directory of this run, registered or not: a worktree whose registration the agent
        // rewrote (its `gitdir` pointing elsewhere) or whose HEAD it moved is still reported. Not the
        // directory of a run whose id extends this one (`run` vs `run/sub`), which is no leaf.
        const names = new Set<string>();
        for (const entry of entries) if (dirname(resolve(entry.path)) === runRoot) names.add(basename(resolve(entry.path)));
        for (const name of await readdir(runRoot).catch(() => [] as string[])) names.add(name);
        // One worktree's failure is reported (kept, `failed`) and the others are still cleaned; only an abort stops the run.
        const settle = async (path: string, branch: string, work: () => Promise<void>) => {
          try { await work(); } catch (error) {
            if (signal?.aborted || (error instanceof DynamicIsolationError && error.code === 'ABORTED')) throw error;
            keepFor(path, branch, untrusted(error) ? 'untrusted' : 'failed');
          }
        };
        for (const leaf of names) {
          if (!isLeafName(leaf) || !isSafeRefPath(`${prefix}${runId}/${leaf}`, 400)) continue;
          const path = join(runRoot, leaf);
          const branch = `${prefix}${runId}/${leaf}`;
          const here = entries.filter(entry => resolve(entry.path) === path);
          await settle(path, branch, async () => {
            // This isolation's: its branch exists or is checked out there (not another prefix's leaf under the same root).
            if (await tip(state.top, branch, signal) === undefined && !here.some(entry => entry.branch === `refs/heads/${branch}`)) return;
            if (here.length > 1) { keepFor(path, branch, 'untrusted'); return; }
            if (here.length === 0) { keepFor(path, branch, existsSync(path) ? 'untrusted' : 'missing'); return; }
            if (here[0]!.prunable || !existsSync(path)) { keepFor(path, branch, 'missing'); return; }
            // A rewritten `.git`, `gitdir` or `commondir` throws WORKTREE_UNTRUSTED: nothing more runs there, and it is kept.
            const isChanged = await worktreeChanged(state, path, branch, signal);
            if (isChanged || keep === 'always') { kept.push({ path, branch, changed: isChanged }); return; }
            const branchTip = await tip(state.top, branch, signal);
            // `worktree remove` reads `<path>/.git` and the admin directory itself: checked again just before it runs.
            if (!await removableWorktree(state, path, signal)) { keepFor(path, branch, 'untrusted'); return; }
            // No --force: git itself refuses a worktree with modified or untracked files (listed whatever
            // the repository's status.showUntrackedFiles) or with a populated submodule. The `git status`
            // it starts in the worktree takes the verified common directory, not the admin `commondir`.
            const removal = await git(['-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', path], {
              cwd: state.top, subcommand: 'worktree remove', timeoutMs, accept: [128], env: { GIT_COMMON_DIR: state.common },
            });
            if (removal.code !== 0 || branchTip === undefined) { kept.push({ path, branch, changed: false }); return; }
            // Deleted only if the branch still points where it was inspected; the worktree is gone either way.
            const deleted = await run(state.top, 'update-ref', ['update-ref', '-d', `refs/heads/${branch}`, branchTip], undefined, [128])
              .catch(() => ({ code: -1 }));
            removed.push({ path, branch, branchDeleted: deleted.code === 0 });
          });
        }
        await removeEmptyParents(runRoot, state.root);
        return { removed, kept };
      });
    },
  };
}

async function removeEmptyParents(directory: string, stop: string): Promise<void> {
  for (let current = directory; current !== stop && isInside(stop, current); current = dirname(current)) {
    try { await rmdir(current); } catch { return; }
  }
}
