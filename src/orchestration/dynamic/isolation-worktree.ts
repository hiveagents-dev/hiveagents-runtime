import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DynamicIsolationError, git, parseWorktrees, type GitOptions } from './isolation-git.js';

/**
 * How `gitWorktreeIsolation` inspects a worktree an agent may have written to.
 *
 * Git never discovers the repository from inside the worktree, and never takes configuration from the
 * worktree's admin directory (`<common dir>/worktrees/<name>`), which the agent's own git commands
 * write to: a planted `.git`, a rewritten `commondir` (naming a copy of the common directory with a
 * filter driver added) or a `config.worktree` would otherwise choose what git runs.
 *
 * - Trust: the worktree must be a real directory (no symlink) whose `.git` is a regular file holding
 *   exactly the pointer git wrote to its admin directory; that admin directory is found from the
 *   repository (the one `worktrees/*` entry whose `gitdir` points back at `<worktree>/.git`), must be
 *   a real directory, its `commondir` must lead back to the common directory the SDK resolved from the
 *   repository, and its `index`, when present, must be a regular file (a missing index reads as an
 *   empty one, so every tracked file shows as deleted: changed). Otherwise WORKTREE_UNTRUSTED:
 *   nothing more runs there, and the worktree is kept.
 * - Inspection runs `git --git-dir=<verified common dir> --work-tree=<worktree>` with
 *   `GIT_INDEX_FILE=<admin>/index`: the index is the only file of the admin directory git reads, as
 *   data. The worktree's HEAD comes from `git worktree list` in the repository and is compared with the
 *   branch tip the repository holds.
 * - Removal (`git worktree remove`, which itself runs `git status` in the worktree) gets
 *   `GIT_COMMON_DIR=<verified common dir>`, and is skipped (the worktree kept) when the repository
 *   enables `extensions.worktreeConfig` and the admin directory has a `config.worktree`.
 *
 * What can still run: a clean filter (`filter.<driver>.clean`/`.process`, for example LFS) that the
 * repository's own configuration, or the user's global or system git configuration, defines; a
 * `.gitattributes` written in the worktree can assign it to any file there. Driver definitions only
 * come from that trusted configuration. Hooks, fsmonitor, system and global attribute files and diff
 * drivers are never used, and submodule directories are never entered. The checks run just before the
 * commands they guard: an agent process still running at that moment races them.
 */

export interface InspectedRepository {
  /** Realpath of the main working tree. */
  readonly top: string;
  /** Realpath of the repository's common git directory, resolved from the repository itself. */
  readonly common: string;
  /** The commit the worktrees branch from. */
  readonly base: string;
  readonly timeoutMs: number;
}

export interface TrustedWorktree { readonly gitDir: string; readonly workTree: string; readonly index: string }

const POINTER_LIMIT = 4096;
// Everything the listings may print: beyond it, the worktree counts as changed rather than unknown.
const LISTING_LIMIT = 128 * 1024 * 1024;

/** A small regular file, read without following a symlink; undefined when it is anything else. */
async function readPointer(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > POINTER_LIMIT) return undefined;
    return await handle.readFile('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Resolves the admin directory of the worktree at `path` from the repository and checks each of its files git would follow. */
export async function trustedWorktree(common: string, path: string): Promise<TrustedWorktree> {
  const untrusted = (reason: string) => new DynamicIsolationError('WORKTREE_UNTRUSTED', { reason });
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory() || await realpath(path).catch(() => undefined) !== path) throw untrusted('worktree directory');
  const pointer = join(path, '.git');
  const admins = join(common, 'worktrees');
  const claiming: string[] = [];
  for (const name of await readdir(admins).catch(() => [] as string[])) {
    const back = await readPointer(join(admins, name, 'gitdir'));
    if (back !== undefined && resolve(admins, name, back.replace(/\r?\n$/, '')) === pointer) claiming.push(join(admins, name));
  }
  if (claiming.length === 0) throw untrusted('not a registered worktree');
  // Two registrations for one directory: one was rewritten, and either could be the one git follows.
  if (claiming.length > 1) throw untrusted('registration');
  const gitDir = claiming[0]!;
  if (!(await lstat(gitDir)).isDirectory() || await realpath(gitDir) !== gitDir) throw untrusted('admin directory');
  const content = await readPointer(pointer);
  const target = content === undefined ? undefined : /^gitdir: ([^\r\n]+)\n$/.exec(content)?.[1];
  // Absolute as git writes it by default, or relative to the worktree (`worktree.useRelativePaths`).
  if (target === undefined || resolve(path, target) !== gitDir) throw untrusted('.git pointer');
  // Git takes the common directory, and with it the configuration, from this file: it must lead back to ours.
  const commondir = await readPointer(join(gitDir, 'commondir'));
  const line = commondir === undefined ? undefined : /^([^\r\n]+)\r?\n?$/.exec(commondir)?.[1];
  const shared = line === undefined ? undefined : await realpath(resolve(gitDir, line)).catch(() => undefined);
  if (shared !== common) throw untrusted('commondir');
  const index = join(gitDir, 'index');
  const indexInfo = await lstat(index).catch(() => undefined);
  if (indexInfo && !indexInfo.isFile()) throw untrusted('index');
  return { gitDir, workTree: path, index };
}

/** Configuration of the inspection commands only: no untracked cache, every untracked file listed. */
const INSPECTION_CONFIG = ['-c', 'core.untrackedCache=false', '-c', 'status.showUntrackedFiles=all'] as const;

function gitOptions(repo: InspectedRepository, subcommand: string, signal?: AbortSignal, accept?: readonly number[], extra?: Partial<GitOptions>): GitOptions {
  return { cwd: repo.top, subcommand, timeoutMs: repo.timeoutMs, signal, ...(accept ? { accept } : {}), ...extra };
}

/**
 * Whether the agent changed anything in the worktree: a HEAD on another branch or off the tip,
 * commits beyond the base, staged changes, index entries flagged assume-unchanged or skip-worktree
 * (with a file present), files inside a submodule directory, any modified, untracked or ignored file,
 * or an entry named `.git` below the top level.
 */
export async function worktreeChanged(repo: InspectedRepository, path: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  const tree = await trustedWorktree(repo.common, path);
  const inRepository = (subcommand: string, args: readonly string[], accept?: readonly number[]) =>
    git(args, gitOptions(repo, subcommand, signal, accept));
  // The verified common directory and the worktree's index: nothing else of the admin directory is read.
  const inWorktree = (subcommand: string, args: readonly string[], accept?: readonly number[], maxOutputBytes?: number) =>
    git([...INSPECTION_CONFIG, `--git-dir=${repo.common}`, `--work-tree=${tree.workTree}`, ...args],
      gitOptions(repo, subcommand, signal, accept, { env: { GIT_INDEX_FILE: tree.index }, ...(maxOutputBytes ? { maxOutputBytes } : {}) }));

  const tip = await inRepository('rev-parse', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], [1]);
  if (tip.code !== 0) return true;
  const commit = tip.stdout.trim();
  const registered = parseWorktrees((await inRepository('worktree list', ['worktree', 'list', '--porcelain', '-z'])).stdout)
    .filter(entry => resolve(entry.path) === path);
  if (registered.length !== 1) throw new DynamicIsolationError('WORKTREE_UNTRUSTED', { reason: 'registration' });
  // On the branch, or detached at its tip; another branch, even at the same commit, is a change.
  const head = registered[0]!;
  if (head.branch !== undefined ? head.branch !== `refs/heads/${branch}` : head.head !== commit) return true;
  const ahead = await inRepository('rev-list', ['rev-list', '--count', `${repo.base}..refs/heads/${branch}`]);
  if (Number.parseInt(ahead.stdout.trim(), 10) !== 0) return true;
  // Index against the tip, submodule commits included: compares object ids, reads no file of the worktree.
  const staged = await inWorktree('diff-index', ['diff-index', '--cached', '--quiet', '--ignore-submodules=none', '--no-ext-diff', commit, '--'], [1]);
  if (staged.code !== 0) return true;
  try {
    const entries = await inWorktree('ls-files', ['ls-files', '-s', '-v', '-z'], undefined, LISTING_LIMIT);
    if (await hiddenEntries(path, entries.stdout)) return true;
    // Submodules are never entered (their `.git` is the agent's too); their directories were checked above.
    const status = await inWorktree('status', [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=all', '--no-renames',
    ], undefined, LISTING_LIMIT);
    return worktreeDiffers(status.stdout) || await nestedGitEntry(path, signal);
  } catch (error) {
    // More output than the limit is certainly a change.
    if (error instanceof DynamicIsolationError && error.code === 'OUTPUT_LIMIT') return true;
    throw error;
  }
}

/**
 * Status records other than an index-only difference. The HEAD git compares the index with here is
 * the repository's, not the worktree's, so the index column of `1 XY ...` says nothing (the index was
 * compared with the tip above); a worktree column, an unmerged, untracked or ignored entry is a change.
 */
function worktreeDiffers(status: string): boolean {
  return status.split('\0').some(record => record.length > 0 && !(record.startsWith('1 ') && record[3] === '.'));
}

// Entries the walk below visits at most: beyond it, the worktree counts as changed.
const WALK_LIMIT = 1_000_000;

/**
 * Whether any entry below the top level is named `.git` (in any case): git never lists such an
 * entry or anything inside it as untracked, and `worktree remove` would delete it with the worktree.
 * Runs only once everything else found no change, so it walks little more than the tracked files.
 * Symlinks are not followed; an unreadable directory throws.
 */
async function nestedGitEntry(top: string, signal?: AbortSignal): Promise<boolean> {
  const pending = [top];
  let seen = 0;
  while (pending.length > 0) {
    if (signal?.aborted) throw new DynamicIsolationError('ABORTED');
    const directory = pending.pop()!;
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (++seen > WALK_LIMIT) return true;
      if (child.name.toLowerCase() === '.git') {
        if (directory === top && child.name === '.git') continue; // the worktree's own pointer, checked above
        return true;
      }
      if (child.isDirectory()) pending.push(join(directory, child.name));
    }
  }
  return false;
}

/**
 * Whether `git worktree remove` may run on the worktree: it must be trusted, and since that command
 * starts `git status` in the worktree, which reads `<admin>/config.worktree` when the repository
 * enables `extensions.worktreeConfig`, there must be no such file then. Throws WORKTREE_UNTRUSTED.
 */
export async function removableWorktree(repo: InspectedRepository, path: string, signal?: AbortSignal): Promise<boolean> {
  const tree = await trustedWorktree(repo.common, path);
  if (!await lstat(join(tree.gitDir, 'config.worktree')).then(() => true, () => false)) return true;
  const enabled = await git(['config', '--type=bool', '--get', 'extensions.worktreeConfig'], gitOptions(repo, 'config', signal, [1]));
  return enabled.code !== 0 || enabled.stdout.trim() !== 'true';
}

/**
 * Entries `git status` would not report: assume-unchanged (lowercase tag), skip-worktree (`S`) with
 * a file present, and submodules (mode 160000) whose directory is not an empty directory. A new
 * worktree checks submodules out as empty directories and sets none of those flags.
 */
async function hiddenEntries(path: string, listing: string): Promise<boolean> {
  for (const record of listing.split('\0')) {
    if (!record) continue;
    // `<tag> <mode> <object> <stage>\t<path>`
    const tab = record.indexOf('\t');
    const [tag = '', mode = ''] = record.slice(0, tab).split(' ');
    const file = join(path, record.slice(tab + 1));
    if (tab < 0 || tag !== tag.toUpperCase()) return true;
    if (tag === 'S' && await lstat(file).then(() => true, () => false)) return true;
    if (mode === '160000') {
      const info = await lstat(file).catch(() => undefined);
      if (info && (!info.isDirectory() || (await readdir(file).catch(() => ['?'])).length > 0)) return true;
    }
  }
  return false;
}
