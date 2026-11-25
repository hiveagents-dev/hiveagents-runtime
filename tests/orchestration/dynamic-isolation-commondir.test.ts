import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DynamicIsolationError, gitWorktreeIsolation } from '../../src/orchestration/dynamic/isolation.js';

// Regression tests for admin-directory files an agent rewrote (`<common>/worktrees/<name>/*`): the
// host-side git commands of `inspect` and `cleanupWorktrees` must never take configuration from them.

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

describe.skipIf(!hasGit)('gitWorktreeIsolation with an admin directory an agent rewrote', { timeout: 30_000 }, () => {
  let base: string;
  let repository: string;
  let root: string;
  let marker: string;
  let filter: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'oar-dw-commondir-')));
    repository = join(base, 'repo');
    root = join(base, 'worktrees');
    marker = join(base, 'PWNED');
    filter = join(base, 'filter.sh');
    writeFileSync(filter, `#!/bin/sh\necho ran >> '${marker}'\nexec cat\n`);
    chmodSync(filter, 0o755);
    mkdirSync(repository);
    sh(repository, 'init', '-q', '-b', 'main');
    writeFileSync(join(repository, 'a.txt'), 'hello world\n');
    sh(repository, 'add', '.');
    sh(repository, 'commit', '-q', '-m', 'initial');
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  const adminOf = (path: string) => readFileSync(join(path, '.git'), 'utf8').match(/^gitdir: (.+)\n$/)![1]!;
  /** Same size as the committed content: git re-hashes it, through the clean filter, to see the edit. */
  const touchTracked = (path: string) => writeFileSync(join(path, 'a.txt'), 'HELLO WORLD\n');

  it('refuses a worktree whose commondir points at a copy with a planted filter; nothing runs and cleanup keeps it', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-1', key: 'k', signal: signal() });
    const admin = adminOf(tree.path);
    const evil = join(base, 'evil-common');
    cpSync(resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim()), evil, { recursive: true });
    appendFileSync(join(evil, 'config'), `[filter "x"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n`);
    writeFileSync(join(admin, 'commondir'), `${evil}\n`);
    writeFileSync(join(tree.path, '.gitattributes'), '* filter=x\n');
    touchTracked(tree.path);

    expect(await codeOf(isolation.inspect(tree))).toBe('WORKTREE_UNTRUSTED');
    const report = await isolation.cleanupWorktrees({ runId: 'run-1' });

    expect(existsSync(marker)).toBe(false);
    expect(report).toEqual({ removed: [], kept: [{ path: tree.path, branch: tree.branch, changed: true, reason: 'untrusted' }] });
    expect(readFileSync(join(tree.path, 'a.txt'), 'utf8')).toBe('HELLO WORLD\n');
  });

  it('runs no filter from a config.worktree the agent wrote, even when the repository enables extensions.worktreeConfig', async () => {
    // A committed attribute naming a driver the repository leaves undefined (as an LFS setup without LFS installed).
    writeFileSync(join(repository, '.gitattributes'), 'a.txt filter=x\n');
    sh(repository, 'add', '.gitattributes');
    sh(repository, 'commit', '-q', '-m', 'attributes');
    sh(repository, 'config', 'extensions.worktreeConfig', 'true');
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string) => isolation.create({ runId: 'run-2', key, signal: signal() });
    const [edited, untouched] = await Promise.all([create('edited'), create('untouched')]);
    // The agent defines that driver in its per-worktree config: only the edited worktree has any other change.
    for (const tree of [edited!, untouched!]) {
      writeFileSync(join(adminOf(tree.path), 'config.worktree'), `[filter "x"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n`);
    }
    touchTracked(edited!.path);

    expect(await isolation.inspect(edited!)).toEqual({ changed: true });
    const report = await isolation.cleanupWorktrees({ runId: 'run-2' });

    expect(existsSync(marker)).toBe(false);
    expect(report.removed).toEqual([]);
    expect(report.kept.map(entry => entry.path).sort()).toEqual([edited!.path, untouched!.path].sort());
    expect(existsSync(untouched!.path)).toBe(true);
  });

  it('lists a worktree whose gitdir back-pointer was rewritten as kept, and leaves it on disk', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string) => isolation.create({ runId: 'run-3', key, signal: signal() });
    const [moved, gone, clean] = await Promise.all([create('moved'), create('gone'), create('clean')]);
    writeFileSync(join(adminOf(moved!.path), 'gitdir'), `${join(base, 'elsewhere', '.git')}\n`);
    writeFileSync(join(adminOf(gone!.path), 'gitdir'), `${join(clean!.path, '.git')}\n`);

    expect(await codeOf(isolation.inspect(moved!))).toBe('WORKTREE_UNTRUSTED');
    const report = await isolation.cleanupWorktrees({ runId: 'run-3' });

    const kept = report.kept.map(entry => entry.path);
    expect(kept).toContain(moved!.path);
    expect(kept).toContain(gone!.path);
    expect(report.kept.every(entry => entry.changed && entry.reason === 'untrusted')).toBe(true);
    // Two registrations claim the clean worktree: it is not trusted either, so nothing is removed.
    expect([...kept, ...report.removed.map(entry => entry.path)].sort()).toEqual([moved!.path, gone!.path, clean!.path].sort());
    for (const tree of [moved!, gone!]) expect(existsSync(join(tree.path, 'a.txt'))).toBe(true);
  });

  it('lists a worktree whose HEAD the agent moved to another branch as kept and changed', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-4', key: 'k', signal: signal() });
    sh(tree.path, 'checkout', '-q', '-b', 'agent-branch');

    expect(await isolation.inspect(tree)).toEqual({ changed: true });
    const report = await isolation.cleanupWorktrees({ runId: 'run-4' });

    expect(report).toEqual({ removed: [], kept: [{ path: tree.path, branch: tree.branch, changed: true }] });
  });

  it('reports a worktree whose inspection fails as kept and goes on with the others, run after run', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const created = await Promise.all(['k0', 'k1', 'k2', 'k3'].map(key => isolation.create({ runId: 'run-6', key, signal: signal() })));
    const [bad, ...clean] = created.sort((a, b) => (a.path < b.path ? -1 : 1));
    // A regular file, so the worktree is trusted; git cannot read it (diff-index exits 128).
    writeFileSync(join(adminOf(bad!.path), 'index'), 'garbage');

    await expect(isolation.inspect(bad!)).rejects.toBeInstanceOf(DynamicIsolationError);
    const report = await isolation.cleanupWorktrees({ runId: 'run-6' });

    expect(report.kept).toEqual([{ path: bad!.path, branch: bad!.branch, changed: true, reason: 'failed' }]);
    expect(report.removed.map(entry => entry.path).sort()).toEqual(clean.map(tree => tree!.path).sort());
    expect(await isolation.cleanupWorktrees({ runId: 'run-6' })).toEqual({ removed: [], kept: report.kept });
    expect(existsSync(join(bad!.path, 'a.txt'))).toBe(true);
  });

  it('counts files under a nested entry named .git as a change, which git status never lists', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string) => isolation.create({ runId: 'run-7', key, signal: signal() });
    const [directory, file, clean] = await Promise.all([create('dir'), create('file'), create('clean')]);
    mkdirSync(join(directory!.path, 'notes', '.git'), { recursive: true });
    writeFileSync(join(directory!.path, 'notes', '.git', 'work.md'), 'agent work\n');
    mkdirSync(join(file!.path, 'sub'));
    writeFileSync(join(file!.path, 'sub', '.GIT'), 'agent content\n');

    for (const tree of [directory!, file!]) expect(await isolation.inspect(tree), tree.path).toEqual({ changed: true });
    expect(await isolation.inspect(clean!)).toEqual({ changed: false });
    const report = await isolation.cleanupWorktrees({ runId: 'run-7' });

    expect(report.removed.map(entry => entry.path)).toEqual([clean!.path]);
    expect(existsSync(join(directory!.path, 'notes', '.git', 'work.md'))).toBe(true);
    expect(existsSync(join(file!.path, 'sub', '.GIT'))).toBe(true);
  });

  it('still inspects and removes untouched worktrees, with git’s own relative commondir', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const tree = await isolation.create({ runId: 'run-5', key: 'k', signal: signal() });
    expect(readFileSync(join(adminOf(tree.path), 'commondir'), 'utf8')).toBe('../..\n');
    touchTracked(tree.path);
    writeFileSync(join(tree.path, 'a.txt'), 'hello world\n'); // back to the committed content: only the stat changed

    expect(await isolation.inspect(tree)).toEqual({ changed: false });
    const report = await isolation.cleanupWorktrees({ runId: 'run-5' });
    expect(report).toEqual({ removed: [{ path: tree.path, branch: tree.branch, branchDeleted: true }], kept: [] });
  });
});
