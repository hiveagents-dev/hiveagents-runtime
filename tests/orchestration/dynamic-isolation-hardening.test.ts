import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DynamicIsolationError, gitWorktreeIsolation } from '../../src/orchestration/dynamic/isolation.js';

// Regression tests for worktrees an agent wrote to: planted git metadata, ignored and hidden files.

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DynamicIsolationError);
  return (error as DynamicIsolationError).code;
}

const signal = () => new AbortController().signal;

describe.skipIf(!hasGit)('gitWorktreeIsolation with files an agent wrote', { timeout: 30_000 }, () => {
  let base: string;
  let repository: string;
  let root: string;
  let marker: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'oar-dw-hardening-')));
    repository = join(base, 'repo');
    root = join(base, 'worktrees');
    marker = join(base, 'PWNED');
    mkdirSync(repository);
    sh(repository, 'init', '-q', '-b', 'main');
    writeFileSync(join(repository, 'a.txt'), 'one\n');
    writeFileSync(join(repository, '.gitignore'), 'out/\n');
    sh(repository, 'add', '.');
    sh(repository, 'commit', '-q', '-m', 'initial');
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  /** A gitdir of the agent's own, whose config defines a clean filter that creates the marker. */
  function plantGitdir(at: string): void {
    const scratch = join(base, 'scratch');
    mkdirSync(scratch);
    sh(scratch, 'init', '-q', '-b', 'main');
    writeFileSync(join(scratch, 'a.txt'), 'x\n');
    sh(scratch, 'add', 'a.txt');
    sh(scratch, 'commit', '-q', '-m', 'x');
    cpSync(join(scratch, '.git'), at, { recursive: true });
    appendFileSync(join(at, 'config'), `[filter "pwn"]\n\tclean = touch ${marker}; cat\n`);
  }

  it('never follows a .git pointer the agent rewrote: untrusted, the planted filter does not run, cleanup keeps it', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-1', key: 'k', signal: signal() });
    // Only files written inside the worktree, as an 'edit' agent may: a gitdir, a `.git` pointer to it, attributes.
    plantGitdir(join(tree.path, 'evil'));
    writeFileSync(join(tree.path, '.gitattributes'), 'a.txt filter=pwn\n');
    writeFileSync(join(tree.path, '.git'), 'gitdir: evil\n');
    writeFileSync(join(tree.path, 'a.txt'), 'y\n'); // same size: git would hash it through the clean filter

    expect(await codeOf(isolation.inspect(tree))).toBe('WORKTREE_UNTRUSTED');
    const report = await isolation.cleanupWorktrees({ runId: 'run-1' });

    expect(existsSync(marker)).toBe(false);
    expect(report).toEqual({ removed: [], kept: [{ path: tree.path, branch: tree.branch, changed: true, reason: 'untrusted' }] });
    expect(existsSync(join(tree.path, 'a.txt'))).toBe(true);
    expect(sh(repository, 'branch', '--list', tree.branch)).not.toBe('');
  });

  it('refuses a .git directory, a symlinked .git and a missing .git, and accepts a relative pointer to the right admin directory', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string) => isolation.create({ runId: 'run-2', key, signal: signal() });
    const [directory, symlinked, missing, relativePointer] = await Promise.all([create('dir'), create('link'), create('missing'), create('rel')]);

    rmSync(join(directory!.path, '.git'));
    plantGitdir(join(directory!.path, '.git'));
    writeFileSync(join(directory!.path, '.gitattributes'), 'a.txt filter=pwn\n');
    writeFileSync(join(directory!.path, 'a.txt'), 'y\n');

    const pointer = readFileSync(join(symlinked!.path, '.git'), 'utf8');
    writeFileSync(join(base, 'pointer'), pointer);
    rmSync(join(symlinked!.path, '.git'));
    symlinkSync(join(base, 'pointer'), join(symlinked!.path, '.git'));

    rmSync(join(missing!.path, '.git'));

    const admin = readFileSync(join(relativePointer!.path, '.git'), 'utf8').replace(/^gitdir: /, '').trim();
    writeFileSync(join(relativePointer!.path, '.git'), `gitdir: ${relative(relativePointer!.path, admin)}\n`);

    for (const tree of [directory!, symlinked!, missing!]) expect(await codeOf(isolation.inspect(tree)), tree.path).toBe('WORKTREE_UNTRUSTED');
    expect(await isolation.inspect(relativePointer!)).toEqual({ changed: false });
    const report = await isolation.cleanupWorktrees({ runId: 'run-2' });
    expect(existsSync(marker)).toBe(false);
    expect(report.kept.map(entry => entry.path).sort()).toEqual([directory!.path, symlinked!.path, missing!.path].sort());
    expect(report.kept.every(entry => entry.changed)).toBe(true);
    expect(report.removed.map(entry => entry.path)).toEqual([relativePointer!.path]);
  });

  it('runs no filter that attributes written in the worktree name, with the pointer intact', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-3', key: 'k', signal: signal() });
    plantGitdir(join(tree.path, 'evil'));
    writeFileSync(join(tree.path, '.gitattributes'), '* filter=pwn diff=pwn\n');
    writeFileSync(join(tree.path, 'a.txt'), 'y\n');

    expect(await isolation.inspect(tree)).toEqual({ changed: true });
    expect((await isolation.cleanupWorktrees({ runId: 'run-3' })).kept).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports ignored files as changed and cleanup keeps them', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-4', key: 'k', signal: signal() });
    mkdirSync(join(tree.path, 'out'));
    writeFileSync(join(tree.path, 'out', 'report.md'), 'the agent deliverable\n');

    const inspected = await isolation.inspect(tree);
    const cleanup = await isolation.cleanupWorktrees({ runId: 'run-4' });

    expect({ deliverableKept: existsSync(join(tree.path, 'out', 'report.md')), removed: cleanup.removed.length, changed: inspected.changed })
      .toEqual({ deliverableKept: true, removed: 0, changed: true });
  });

  it('sees untracked files in new directories when the repository sets status.showUntrackedFiles=no', async () => {
    sh(repository, 'config', 'status.showUntrackedFiles', 'no');
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-5', key: 'k', signal: signal() });
    mkdirSync(join(tree.path, 'src', 'deep'), { recursive: true });
    writeFileSync(join(tree.path, 'src', 'deep', 'new-module.ts'), 'export const work = 1;\n');

    const inspected = await isolation.inspect(tree);
    const cleanup = await isolation.cleanupWorktrees({ runId: 'run-5' });

    expect({ kept: existsSync(join(tree.path, 'src', 'deep', 'new-module.ts')), removed: cleanup.removed.length, changed: inspected.changed })
      .toEqual({ kept: true, removed: 0, changed: true });
  });

  it('sees edits hidden by core.ignoreStat or assume-unchanged, and files inside a submodule directory', async () => {
    sh(repository, 'update-index', '--add', '--cacheinfo', `160000,${sh(repository, 'rev-parse', 'HEAD')},sub`);
    sh(repository, 'commit', '-q', '-m', 'submodule');
    sh(repository, 'config', 'core.ignoreStat', 'true');
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string) => isolation.create({ runId: 'run-6', key, signal: signal() });
    const [clean, ignoreStat, assumed, submodule] = await Promise.all([create('clean'), create('stat'), create('assumed'), create('sub')]);

    writeFileSync(join(ignoreStat!.path, 'a.txt'), 'two\n');
    sh(assumed!.path, 'update-index', '--assume-unchanged', 'a.txt');
    writeFileSync(join(assumed!.path, 'a.txt'), 'two\n');
    writeFileSync(join(submodule!.path, 'sub', 'work.md'), 'inside the submodule directory\n');

    expect(await isolation.inspect(clean!)).toEqual({ changed: false });
    for (const tree of [ignoreStat!, assumed!, submodule!]) expect(await isolation.inspect(tree), tree.path).toEqual({ changed: true });
    const report = await isolation.cleanupWorktrees({ runId: 'run-6' });
    expect(report.removed.map(entry => entry.path)).toEqual([clean!.path]);
    expect(existsSync(join(submodule!.path, 'sub', 'work.md'))).toBe(true);
    expect(readFileSync(join(assumed!.path, 'a.txt'), 'utf8')).toBe('two\n');
  });
});
