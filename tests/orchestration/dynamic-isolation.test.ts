import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DynamicIsolationError, gitWorktreeIsolation } from '../../src/orchestration/dynamic/isolation.js';
import { isSafeRefPath, parseWorktrees, shortKey } from '../../src/orchestration/dynamic/isolation-git.js';

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
  expect((error as Error).message).not.toMatch(/fatal|error:/);
  return (error as DynamicIsolationError).code;
}

const signal = () => new AbortController().signal;

describe('worktree isolation names', () => {
  it('accepts plain ref paths and refuses traversal, options and git-invalid names', () => {
    for (const ok of ['run-1', 'HEAD', 'main', 'origin/main', 'a.b_c/d-e', 'abc123']) expect(isSafeRefPath(ok), ok).toBe(true);
    for (const bad of ['', '..', 'a/../b', 'a..b', '-rf', '/abs', 'a/', 'a//b', '.hidden', 'a/.b', 'x.lock', 'a.', 'a b', 'a~1', 'a^', 'a:b', 'a\nb', 'x'.repeat(201)]) {
      expect(isSafeRefPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('derives a stable leaf from the key, with a cosmetic label slug', () => {
    expect(shortKey('k1')).toMatch(/^[0-9a-f]{12}$/);
    expect(shortKey('k1', 'Review a.ts / step 2')).toBe(`Review-a.ts-step-2-${shortKey('k1')}`);
    expect(shortKey('k1', '../../etc')).toBe(`etc-${shortKey('k1')}`);
    expect(isSafeRefPath(`oar/dw/run/${shortKey('k', '..a..b..')}`)).toBe(true);
    expect(shortKey('k1')).not.toBe(shortKey('k2'));
  });

  it('parses porcelain -z worktree listings', () => {
    const output = 'worktree /r\0HEAD 1\0branch refs/heads/main\0\0worktree /w\0HEAD 2\0detached\0prunable gitdir file points to non-existent location\0\0';
    expect(parseWorktrees(output)).toEqual([
      { path: '/r', branch: 'refs/heads/main', head: '1', prunable: false },
      { path: '/w', head: '2', prunable: true },
    ]);
  });

  it('refuses relative paths and unsafe refs when built', () => {
    expect(() => gitWorktreeIsolation({ repository: 'repo', root: '/tmp/x' })).toThrow(TypeError);
    expect(() => gitWorktreeIsolation({ repository: '/repo', root: 'x' })).toThrow(TypeError);
    expect(() => gitWorktreeIsolation({ repository: '/repo', root: '/x', baseRef: 'HEAD~1' })).toThrow(TypeError);
    expect(() => gitWorktreeIsolation({ repository: '/repo', root: '/x', baseRef: '--output=/etc/x' })).toThrow(TypeError);
    expect(() => gitWorktreeIsolation({ repository: '/repo', root: '/x', branchPrefix: '../' })).toThrow(TypeError);
  });
});

// Each git process costs tens of milliseconds; a loaded machine needs more than the default 5 s per test.
describe.skipIf(!hasGit)('gitWorktreeIsolation with a real repository', { timeout: 30_000 }, () => {
  let base: string;
  let repository: string;
  let root: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'oar-dw-isolation-')));
    repository = join(base, 'repo');
    root = join(base, 'worktrees');
    mkdirSync(repository);
    sh(repository, 'init', '-q', '-b', 'main');
    writeFileSync(join(repository, 'a.txt'), 'one\n');
    writeFileSync(join(repository, '.gitignore'), '.worktrees/\n');
    sh(repository, 'add', '.');
    sh(repository, 'commit', '-q', '-m', 'initial');
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('creates a worktree on its own branch from the base, and reuses it for the same key', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const created = await isolation.create({ runId: 'run-1', key: 'step/a#0', label: 'review', signal: signal() });

    expect(created.path).toBe(join(root, 'run-1', shortKey('step/a#0', 'review')));
    expect(created.branch).toBe(`oar/dw/run-1/${shortKey('step/a#0', 'review')}`);
    expect(existsSync(join(created.path, 'a.txt'))).toBe(true);
    expect(sh(created.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(created.branch);
    expect(sh(created.path, 'rev-parse', 'HEAD')).toBe(sh(repository, 'rev-parse', 'HEAD'));

    // A resumed run (a new isolation, same run and key) gets the same worktree, with what was there.
    writeFileSync(join(created.path, 'b.txt'), 'partial\n');
    const again = await gitWorktreeIsolation({ repository, root }).create({ runId: 'run-1', key: 'step/a#0', label: 'review', signal: signal() });
    expect(again).toEqual(created);
    expect(existsSync(join(again.path, 'b.txt'))).toBe(true);
    expect(sh(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
  });

  it('re-adds a worktree whose directory vanished, or whose branch outlived it, on the same branch', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const first = await isolation.create({ runId: 'run-1', key: 'k', signal: signal() });
    writeFileSync(join(first.path, 'c.txt'), 'c\n');
    sh(first.path, 'add', 'c.txt');
    sh(first.path, 'commit', '-q', '-m', 'agent change');
    rmSync(first.path, { recursive: true, force: true });

    const vanished = await isolation.create({ runId: 'run-1', key: 'k', signal: signal() });
    expect(vanished).toEqual(first);
    expect(existsSync(join(vanished.path, 'c.txt'))).toBe(true);

    sh(repository, 'worktree', 'remove', '--force', first.path);
    const outlived = await isolation.create({ runId: 'run-1', key: 'k', signal: signal() });
    expect(outlived).toEqual(first);
    expect(existsSync(join(outlived.path, 'c.txt'))).toBe(true);
  });

  it('creates distinct worktrees concurrently', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const created = await Promise.all(['a', 'b', 'c', 'd'].map(key => isolation.create({ runId: 'run-2', key, signal: signal() })));
    expect(new Set(created.map(worktree => worktree.path)).size).toBe(4);
    for (const worktree of created) expect(existsSync(join(worktree.path, 'a.txt'))).toBe(true);
  });

  it('reports unchanged, edited, untracked and committed worktrees', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string) => isolation.create({ runId: 'run-3', key, signal: signal() });
    const [clean, edited, untracked, committed] = await Promise.all([create('clean'), create('edited'), create('untracked'), create('committed')]);

    writeFileSync(join(edited!.path, 'a.txt'), 'two\n');
    writeFileSync(join(untracked!.path, 'new.txt'), 'new\n');
    writeFileSync(join(committed!.path, 'a.txt'), 'three\n');
    sh(committed!.path, 'commit', '-q', '-am', 'agent change');

    expect(await isolation.inspect(clean!)).toEqual({ changed: false });
    expect(await isolation.inspect(edited!)).toEqual({ changed: true });
    expect(await isolation.inspect(untracked!)).toEqual({ changed: true });
    expect(await isolation.inspect(committed!)).toEqual({ changed: true });
    // A HEAD moved off the branch counts as a change too.
    sh(clean!.path, 'checkout', '-q', '--detach');
    writeFileSync(join(clean!.path, 'a.txt'), 'x\n');
    sh(clean!.path, 'commit', '-q', '-am', 'detached');
    expect(await isolation.inspect(clean!)).toEqual({ changed: true });
  });

  it('cleans up unchanged worktrees and their branches, keeps changed ones, never forces', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const create = (key: string, runId = 'run-4') => isolation.create({ runId, key, signal: signal() });
    const [clean, edited, committed] = await Promise.all([create('clean'), create('edited'), create('committed')]);
    const other = await create('clean', 'run-5');
    const nested = await create('clean', 'run-4/sub');
    writeFileSync(join(edited!.path, 'a.txt'), 'two\n');
    writeFileSync(join(committed!.path, 'c.txt'), 'c\n');
    sh(committed!.path, 'add', 'c.txt');
    sh(committed!.path, 'commit', '-q', '-m', 'agent change');

    const kept = await isolation.cleanupWorktrees({ runId: 'run-4', keep: 'always' });
    expect(kept.removed).toEqual([]);
    expect(kept.kept).toHaveLength(3);

    const report = await isolation.cleanupWorktrees({ runId: 'run-4' });

    expect(report.removed).toEqual([{ path: clean!.path, branch: clean!.branch, branchDeleted: true }]);
    expect(report.kept.map(entry => entry.path).sort()).toEqual([edited!.path, committed!.path].sort());
    expect(report.kept.every(entry => entry.changed)).toBe(true);
    expect(existsSync(clean!.path)).toBe(false);
    expect(sh(repository, 'branch', '--list', clean!.branch)).toBe('');
    expect(existsSync(join(edited!.path, 'a.txt'))).toBe(true);
    expect(sh(repository, 'branch', '--list', committed!.branch)).not.toBe('');
    // Another run's worktree is not touched, even one whose id extends this one.
    expect(existsSync(other.path)).toBe(true);
    expect(existsSync(nested.path)).toBe(true);
    expect((await isolation.cleanupWorktrees({ runId: 'run-4/sub' })).removed.map(entry => entry.path)).toEqual([nested.path]);
  });

  it('accepts a root inside the repository only where git ignores it', async () => {
    const ignored = gitWorktreeIsolation({ repository, root: join(repository, '.worktrees') });
    const created = await ignored.create({ runId: 'run-6', key: 'k', signal: signal() });
    expect(created.path.startsWith(join(repository, '.worktrees'))).toBe(true);
    expect(sh(repository, 'status', '--porcelain')).toBe('');

    const tracked = gitWorktreeIsolation({ repository, root: join(repository, 'trees') });
    expect(await codeOf(tracked.create({ runId: 'run-6', key: 'k', signal: signal() }))).toBe('ROOT_INSIDE_REPOSITORY');
    const top = gitWorktreeIsolation({ repository, root: repository });
    expect(await codeOf(top.create({ runId: 'run-6', key: 'k', signal: signal() }))).toBe('ROOT_INSIDE_REPOSITORY');
    const gitDir = gitWorktreeIsolation({ repository, root: join(repository, '.git', 'trees') });
    expect(await codeOf(gitDir.create({ runId: 'run-6', key: 'k', signal: signal() }))).toBe('ROOT_INSIDE_REPOSITORY');
    expect(existsSync(join(repository, 'trees'))).toBe(false);
  });

  it('refuses bad run ids, keys, foreign paths and branches, a missing base and a non-repository', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    for (const runId of ['../escape', 'a/../../b', '-x', '/abs', 'a b', '']) {
      expect(await codeOf(isolation.create({ runId, key: 'k', signal: signal() })), runId).toBe('INVALID_INPUT');
    }
    expect(await codeOf(isolation.create({ runId: 'r', key: '', signal: signal() }))).toBe('INVALID_INPUT');
    expect(await codeOf(isolation.cleanupWorktrees({ runId: '..' }))).toBe('INVALID_INPUT');
    expect(await codeOf(isolation.inspect({ path: repository, branch: 'oar/dw/r/x' }))).toBe('INVALID_INPUT');
    expect(await codeOf(isolation.inspect({ path: join(root, 'r', 'x'), branch: 'main' }))).toBe('INVALID_INPUT');

    const missingBase = gitWorktreeIsolation({ repository, root, baseRef: 'no-such-branch' });
    expect(await codeOf(missingBase.create({ runId: 'r', key: 'k', signal: signal() }))).toBe('INVALID_INPUT');
    const notRepo = gitWorktreeIsolation({ repository: base, root });
    expect(await codeOf(notRepo.create({ runId: 'r', key: 'k', signal: signal() }))).toBe('NOT_A_REPOSITORY');
  });

  it('refuses a path or branch taken by something it did not create, and honours an aborted signal', async () => {
    const isolation = gitWorktreeIsolation({ repository, root });
    const leaf = shortKey('k');
    mkdirSync(join(root, 'run-7', leaf), { recursive: true });
    expect(await codeOf(isolation.create({ runId: 'run-7', key: 'k', signal: signal() }))).toBe('WORKTREE_CONFLICT');

    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(isolation.create({ runId: 'run-8', key: 'k', signal: controller.signal }))).toBe('ABORTED');
  });

  it('branches from the given baseRef', async () => {
    sh(repository, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repository, 'f.txt'), 'f\n');
    sh(repository, 'add', 'f.txt');
    sh(repository, 'commit', '-q', '-m', 'feature');
    sh(repository, 'checkout', '-q', 'main');
    const isolation = gitWorktreeIsolation({ repository, root, baseRef: 'feature', branchPrefix: 'wf-' });
    const created = await isolation.create({ runId: 'run-9', key: 'k', signal: signal() });
    expect(created.branch).toBe(`wf-run-9/${shortKey('k')}`);
    expect(existsSync(join(created.path, 'f.txt'))).toBe(true);
    expect(await isolation.inspect(created)).toEqual({ changed: false });
  });
});
