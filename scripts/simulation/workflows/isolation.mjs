/**
 * W5 — git worktree isolation against adversarial agents.
 *
 * Each trial makes a real temporary repository and runs a workflow with the REAL `gitWorktreeIsolation`
 * on the REAL engine. The first agent call is the adversary (lib-adversary.mjs): in the worktree it was
 * given it plants a random subset of vectors, every planted program writing a sentinel outside the repo
 * when executed. Then every host-side operation the SDK offers runs: the engine's `create` + `inspect`
 * of that call and of a second (benign) call created after the plants, direct `inspect` calls,
 * `cleanupWorktrees` (keep 'changed', twice), a resumed run with the same runId (create reuses the
 * worktrees, inspect again), and `cleanupWorktrees` with keep 'always' and 'changed'.
 *
 * Invariants: no sentinel appears; every file the agent wrote is still on disk with its content
 * (files in a worktree's admin dir removed together with an unchanged worktree are reported apart, as
 * git documents that removal); a tampered `.git` pointer is never trusted and its worktree is kept.
 * Hermetic: HOME/XDG_CONFIG_HOME point at an empty temp home, so the user's global git config (and its
 * documented trusted-filter residual, e.g. git-lfs) is out of the picture.
 *
 * Usage: node scripts/simulation/workflows/isolation.mjs [--seed 1] [--trials 240] [--width 4]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, hypothesis, judgeInvariant, rng, sdk } from '../lib/sim.mjs';
import { adversary, VECTORS } from './lib-adversary.mjs';
import { flags, pool } from './lib-twin.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'oar-w5-home-'));
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, '.config');
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=twin', '-c', 'user.email=twin@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(base) {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'hello world\n');
  writeFileSync(join(repo, 'src', 'b.txt'), 'body of b\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n*.log\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

function lostFiles(writes, removedPaths) {
  const last = new Map();
  for (const entry of writes) last.set(entry.path, entry);
  const lost = [], adminRemoved = [];
  for (const entry of last.values()) {
    let ok;
    try {
      ok = entry.kind === 'symlink' ? lstatSync(entry.path).isSymbolicLink() && readlinkSync(entry.path) === entry.target
        : readFileSync(entry.path, 'utf8') === entry.content;
    } catch { ok = false; }
    if (ok) continue;
    if (entry.where === 'admin' && removedPaths.length > 0) adminRemoved.push(entry.path);
    else lost.push({ path: entry.path, where: entry.where });
  }
  return { lost, adminRemoved };
}

async function trial(index, opts, dynamic) {
  const r = rng(opts.seed * 6_151 + index);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oar-w5-')));
  const sentinel = join(base, 'sentinel');
  const out = { index, chosen: [], violations: [], escapes: [], operations: {}, notes: [] };
  try {
    const repo = makeRepo(base);
    const isolation = dynamic.gitWorktreeIsolation({ repository: repo, root: join(base, 'worktrees') });
    const names = Object.keys(VECTORS);
    // Even trials: one vector alone (round-robin), so no plant masks another; odd trials: a random subset.
    const chosen = index % 2 === 0 ? [names[(index / 2) % names.length]] : names.filter(() => r.bernoulli(0.35));
    if (chosen.length === 0) chosen.push(r.pick(names));
    out.single = index % 2 === 0;
    out.chosen = chosen;
    let attack;
    const runner = {
      async run(request) {
        if (request.prompt.startsWith('Attack') && !attack) attack = adversary({ worktree: request.cwd, base, sentinel, chosen });
        return { text: 'done', usage: { inputTokens: 1, outputTokens: 1, costMeaning: 'estimate' } };
      },
    };
    const runId = `w5-${index}`;
    const script = async ctx => {
      const first = await ctx.agentResult('Attack the host.', { isolation: 'worktree', label: 'attacker', permissions: 'edit' });
      const second = await ctx.agentResult('Benign follow-up.', { isolation: 'worktree', label: 'second', permissions: 'edit' });
      return [first.status, second.status];
    };
    const options = { runId, runner, isolation, limits: { permissions: 'edit' } };
    const count = name => { out.operations[name] = (out.operations[name] ?? 0) + 1; };
    const fired = () => {
      const lines = {};
      if (existsSync(sentinel)) for (const file of readdirSync(sentinel)) lines[file.replace(/\.log$/, '')] = readFileSync(join(sentinel, file), 'utf8').trim().split('\n').length;
      return lines;
    };
    out.firedBy = {};
    const step = async (name, fn) => {
      count(name);
      const before = fired();
      let value;
      try { value = await fn(); } catch (error) { out.notes.push(`${name}: ${error?.code ?? error?.name}`); }
      for (const [vector, n] of Object.entries(fired())) if (n > (before[vector] ?? 0)) (out.firedBy[vector] ??= []).push(name);
      return value;
    };

    const report = await step('run (create+inspect x2)', () => dynamic.runWorkflowScript({ name: 'w5', description: 'Adversarial agent.' }, script, options));
    const attacker = report?.agents.find(a => a.label === 'attacker');
    const second = report?.agents.find(a => a.label === 'second');
    for (const agent of [attacker, second]) if (agent?.worktree) await step('inspect', () => isolation.inspect({ path: agent.worktree.path, branch: agent.worktree.branch }));
    const cleanup1 = await step('cleanup keep=changed', () => isolation.cleanupWorktrees({ runId }));
    await step('cleanup keep=changed (again)', () => isolation.cleanupWorktrees({ runId, keep: 'changed' }));
    const resumed = await step('resumed run (create reuse+inspect)', () => dynamic.runWorkflowScript({ name: 'w5', description: 'Adversarial agent.' }, script, options));
    await step('cleanup keep=always', () => isolation.cleanupWorktrees({ runId, keep: 'always' }));
    const cleanup2 = await step('cleanup keep=changed (final)', () => isolation.cleanupWorktrees({ runId }));

    // Sentinels: any planted program that ran.
    if (existsSync(sentinel)) {
      for (const file of readdirSync(sentinel)) {
        const vector = file.replace(/\.log$/, '');
        out.escapes.push({ vector, class: VECTORS[vector], single: out.single, hostOperations: out.firedBy[vector] ?? ['(agent side?)'], executions: readFileSync(join(sentinel, file), 'utf8').trim().split('\n').length });
      }
    }
    // Lost files.
    const removed = [...(cleanup1?.removed ?? []), ...(cleanup2?.removed ?? [])].map(entry => entry.path);
    const { lost, adminRemoved } = lostFiles(attack?.writes ?? [], removed);
    for (const file of lost) out.violations.push({ kind: 'lost-file', ...file });
    out.adminFilesRemovedWithWorktree = adminRemoved.length;
    // Tampered pointer: never trusted, worktree kept.
    if (chosen.includes('pointer') && attacker?.worktree) {
      const path = attacker.worktree.path;
      if (!attacker.worktree.changed) out.violations.push({ kind: 'pointer-reported-unchanged' });
      if (removed.includes(path) || !existsSync(path)) out.violations.push({ kind: 'pointer-worktree-removed' });
      const kept = [...(cleanup1?.kept ?? []), ...(cleanup2?.kept ?? [])].some(entry => entry.path === path);
      if (!kept) out.pointerMissingFromCleanupReport = true;
      out.pointerError = attacker.error?.code ?? null;
    }
    out.attackerStatus = attacker ? `${attacker.status}${attacker.error ? `:${attacker.error.code}` : ''}` : 'missing';
    out.attackerChanged = attacker?.worktree?.changed;
    out.resumedStatus = resumed?.status ?? 'threw';
  } catch (error) {
    out.violations.push({ kind: 'harness-error', message: String(error?.message).slice(0, 200) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  const h = hypothesis('W5');
  const opts = flags({ seed: 1, trials: 240, width: 8 });
  const dynamic = await sdk('orchestration/dynamic');
  const started = Date.now();
  const trials = await pool(opts.trials, opts.width, index => trial(index, opts, dynamic));
  rmSync(HOME, { recursive: true, force: true });
  const escapes = trials.flatMap(t => t.escapes.map(e => ({ trial: t.index, chosen: t.chosen, ...e })));
  const escapesByVector = {}, escapesByClass = { worktree: 0, admin: 0, common: 0 };
  for (const e of escapes) { escapesByVector[e.vector] = (escapesByVector[e.vector] ?? 0) + 1; escapesByClass[e.class]++; }
  const exposure = {};
  for (const name of Object.keys(VECTORS)) exposure[name] = trials.filter(t => t.chosen.includes(name)).length;
  const violations = trials.reduce((sum, t) => sum + t.violations.length, 0);
  const operations = {};
  for (const t of trials) for (const [name, n] of Object.entries(t.operations)) operations[name] = (operations[name] ?? 0) + n;
  const notes = {};
  for (const t of trials) for (const note of t.notes) notes[note] = (notes[note] ?? 0) + 1;
  const trialsWithEscape = new Set(escapes.map(e => e.trial)).size;
  const documentedResidual = escapes.filter(e => e.class === 'common' && /^filter/.test(e.vector)).length;
  emit('workflows/isolation', [{
    id: 'W5', claim: h.claim,
    ...judgeInvariant(escapes.length + violations, opts.trials),
    counts: {
      trials: opts.trials, escapes: escapes.length, trialsWithEscape, lostFilesAndPointerViolations: violations,
      escapesByClass, escapesByVector, vectorExposure: exposure,
      singleVectorTrials: Object.fromEntries(Object.keys(VECTORS).map(name => [name, {
        trials: trials.filter(t => t.single && t.chosen[0] === name).length,
        escaped: trials.filter(t => t.single && t.chosen[0] === name && t.escapes.length).length,
        operations: [...new Set(trials.filter(t => t.single && t.chosen[0] === name).flatMap(t => t.escapes.flatMap(e => e.hostOperations)))],
      }])),
      escapingHostOperations: [...new Set(escapes.flatMap(e => e.hostOperations))],
      pointerWorktreeMissingFromCleanupReport: trials.filter(t => t.pointerMissingFromCleanupReport).length,
      verdictExcludingSdkDocumentedRepoConfigFilters: judgeInvariant(escapes.length - documentedResidual + violations, opts.trials).verdict,
      adminFilesRemovedWithUnchangedWorktree: trials.reduce((sum, t) => sum + (t.adminFilesRemovedWithWorktree ?? 0), 0),
      hostOperations: operations, operationErrors: notes,
      attackerStatuses: Object.fromEntries([...new Set(trials.map(t => t.attackerStatus))].map(s => [s, trials.filter(t => t.attackerStatus === s).length])),
    },
    escapeExamples: escapes.slice(0, 8),
    violationExamples: trials.filter(t => t.violations.length).slice(0, 5).map(t => ({ trial: t.index, chosen: t.chosen, violations: t.violations })),
    assumptions: {
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      hermetic: 'empty HOME and XDG_CONFIG_HOME; no GIT_* variables; system git config as installed',
      vectors: 'each of 15 vectors chosen with p=0.35 (at least one); classes: worktree-only, admin dir (<common>/worktrees/<name>), repository common dir',
      sentinel: 'planted hooks/fsmonitor/filters/diff drivers append to <tmp>/sentinel/<vector>.log; filters pass data through (exec cat)',
      residual: 'SDK docs (isolation-worktree.ts): clean filters defined by the repository\'s own configuration or the user\'s global/system config can still run; this simulation counts repo-local planted ones as escapes (task definition) and also reports the verdict without them',
    },
    crossCheck: 'none: real git, real worktrees, real engine; only the agent is simulated',
  }], { seed: opts.seed, wallMs: Date.now() - started });
}

await main();
