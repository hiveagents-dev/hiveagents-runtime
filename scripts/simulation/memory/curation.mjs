/**
 * M1, M2 (with power curve) and M3: the curator's acceptance rule, run through the real
 * `curateMemory` against the real `SqliteSystemMemory`. One trial = one candidate in a fresh scope
 * (so promotion budgets and cooldowns never interfere): an episode is stored, the simulated
 * distiller proposes one lesson citing it, and the simulated runner decides each task. Under the
 * curator's defaults (two-stage confirmation, alpha 0.01) a candidate the first pass leaves
 * `pending` is measured again by a second pass an hour later, with fresh runs on the same tasks;
 * a trial counts as promoted only when that confirmation promotes it. `--legacy` runs the old
 * single-stage rule (confirm false, alpha 0.05) for comparison.
 *
 * Environment: each task has a latent success probability shared by every condition (Beta with
 * mean `base` and concentration `kappa`), every run draws its own Bernoulli; the lesson moves each
 * task's probability by its true effect, proportionally (see lib-env `withEffect`). Full history
 * runs like no memory (it is the ceiling reference and does not enter the decision).
 *
 *   node scripts/simulation/memory/curation.mjs [--seed N] [--trials N] [--cell-trials N]
 */
import { join } from 'node:path';
import { emit, hypothesis, judgeProportion, rng, sdk } from '../lib/sim.mjs';
import { cli, pct, scratchDir, stopwatch, storeClock, taskDifficulties, uniform, withEffect } from './lib-env.mjs';

const args = cli({ 'cell-trials': { type: 'string', default: '500' }, legacy: { type: 'boolean', default: false } });
/** The acceptance rule under test, mirrored by the twin's own cross-check below. */
const RULE = args.legacy
  ? { confirm: false, alpha: 0.05, pendingAlpha: 0.05, minMargin: 2, label: 'legacy: confirm false, alpha 0.05' }
  : { confirm: true, alpha: 0.01, pendingAlpha: 0.25, minMargin: 2, label: 'defaults: confirm true, pendingAlpha 0.25, pooled alpha 0.01' };
const CURATOR_OPTIONS = args.legacy ? { confirm: false, alpha: 0.05 } : {};
const seed = args.seed;
const cellTrials = Number(args['cell-trials']);
const elapsed = stopwatch();
const { SqliteSystemMemory, curateMemory } = await sdk('orchestration/index');

const TASK_COUNTS = [5, 8, 12, 20, 40];
const KAPPAS = [1, 4, 20, Infinity];
const SIM_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const clock = { ms: SIM_NOW };
const storeTime = storeClock(clock);
const dir = scratchDir();
const store = new SqliteSystemMemory({ databasePath: join(dir, 'memory.sqlite'), systemId: 'twin', now: storeTime.now });
await store.enable({ by: 'twin' });

let scopeSeq = 0;
/** Independent one-sided exact sign test, in doubles (n <= 40 here). */
function signP(m, k) {
  const n = m + k;
  if (m === 0) return 1;
  let total = 0, c = 1;
  for (let i = 0; i <= n; i += 1) {
    if (i >= m) total += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, total / 2 ** n);
}

/**
 * One trial: returns { status, reason, discordant, pValue, mismatch }. `mismatch` is set when the
 * twin's own reading of the reported measurement disagrees with the curator's decision.
 */
async function trial(r, { base, tasks, kappa, uplift }) {
  const p = taskDifficulties(r, base, tasks, kappa);
  const q = p.map(pi => withEffect(pi, uplift, base));
  const scope = { tenant: 'twin', namespace: `trial-${scopeSeq++}` };
  const episodeId = `ep-${scopeSeq}`;
  await store.put({
    id: episodeId, scope, text: `Observation ${scopeSeq}: the user asked about invoices.`,
    provenance: { source: 'agent-turn', sourceVersion: 'twin', observedAt: new Date(SIM_NOW - 3_600_000).toISOString(), inputHash: 'a'.repeat(64) },
  });
  const lesson = `Lesson ${scopeSeq}: when invoicing this client, confirm the currency first.`;
  const taskList = p.map((_, i) => ({ id: `task-${i}`, input: i }));
  const shared = {
    store, scope, distillerId: 'twin/distiller@1', tasks: taskList, ...CURATOR_OPTIONS,
    run: (task, { condition, context }) => {
      const i = task.input;
      if (condition === 'memory') {
        if (context.length !== 1 || context[0] !== lesson) throw new Error('unexpected memory context');
        return { passed: r.next() < q[i] };
      }
      return { passed: r.next() < p[i] };
    },
    history: () => ['the whole history'],
    now: () => new Date(clock.ms),
  };
  const report = await curateMemory({
    ...shared, distill: async episodes => (episodes.some(e => e.id === episodeId) ? [{ text: lesson, sources: [episodeId] }] : []),
  });
  const outcome = report.candidates[0];
  if (!outcome) return { status: 'none', failure: report.failure };
  const result = { status: outcome.status, reason: outcome.reason, measurements: report.measured };
  const first = outcome.measurement;
  if (first) {
    result.discordant = first.discordant;
    result.pValue = first.pValue;
    const pass1 = accepts(first, first.discordant, RULE.confirm ? RULE.pendingAlpha : RULE.alpha);
    const expected1 = pass1 ? (RULE.confirm ? 'pending' : 'promoted') : 'refused';
    if (expected1 !== outcome.status || Math.abs(signP(first.discordant.memoryOnly, first.discordant.noMemoryOnly) - first.pValue) > 1e-12) {
      result.mismatch = { stage: 1, expected: expected1, status: outcome.status, m: first };
    }
  }
  if (outcome.status !== 'pending') return result;
  // The confirming pass: an hour later, the distiller has nothing new.
  clock.ms += 3_600_000;
  storeTime.set(clock.ms);
  // The clock only moves forward (the store's record times stay increasing); every trial has its own scope.
  const second = await curateMemory({ ...shared, distill: async () => [] });
  const confirmation = second.candidates[0];
  if (!confirmation) return { ...result, status: 'none', failure: second.failure };
  Object.assign(result, { status: confirmation.status, reason: confirmation.reason, measurements: 2, pooled: confirmation.pooled });
  if (confirmation.pooled && first) {
    const m2 = confirmation.measurement;
    const pooledTally = {
      memory: { passed: first.memory.passed + m2.memory.passed }, noMemory: { passed: first.noMemory.passed + m2.noMemory.passed },
    };
    const d = {
      memoryOnly: first.discordant.memoryOnly + m2.discordant.memoryOnly, noMemoryOnly: first.discordant.noMemoryOnly + m2.discordant.noMemoryOnly,
    };
    const expected = accepts(pooledTally, d, RULE.alpha);
    const twinP = signP(d.memoryOnly, d.noMemoryOnly);
    if (expected !== (confirmation.status === 'promoted') || Math.abs(twinP - confirmation.pooled.pValue) > 1e-12) {
      result.mismatch = { stage: 2, expected, status: confirmation.status, twinP, sdkP: confirmation.pooled.pValue };
    }
  }
  return result;
}

/** The twin's own reading of the acceptance rule: store gate, margin, sign test at `level`. */
function accepts(tally, d, level) {
  return tally.memory.passed > tally.noMemory.passed && d.memoryOnly - d.noMemoryOnly >= RULE.minMargin
    && signP(d.memoryOnly, d.noMemoryOnly) <= level;
}

/** Runs `n` trials drawing settings from `draw(r)`; tallies promotions and breakdowns. */
async function block(r, n, draw, breakdownKey) {
  let promoted = 0;
  let measurements = 0;
  const reasons = {};
  const mismatches = [];
  const breakdown = {};
  for (let i = 0; i < n; i += 1) {
    const setting = draw(r);
    const out = await trial(r, setting);
    const key = out.status === 'promoted' ? 'PROMOTED' : (out.reason ?? out.status);
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (out.status === 'promoted') promoted += 1;
    measurements += out.measurements ?? 0;
    if (out.mismatch && mismatches.length < 5) mismatches.push({ setting, ...out.mismatch });
    else if (out.mismatch) mismatches.push(null);
    if (breakdownKey) {
      const b = breakdownKey(setting);
      breakdown[b] ??= { n: 0, promoted: 0 };
      breakdown[b].n += 1;
      if (out.status === 'promoted') breakdown[b].promoted += 1;
    }
  }
  for (const b of Object.values(breakdown)) b.rate = b.promoted / b.n;
  return { promoted, n, measurements, reasons, mismatches: mismatches.length, mismatchExamples: mismatches.filter(Boolean), breakdown };
}

const results = [];
const r = rng(seed);

// ---- M1: zero true effect ------------------------------------------------------------------
{
  const h = hypothesis('M1');
  const n = args.trials ?? h.minTrials;
  const draw = rr => ({ base: uniform(rr, 0.2, 0.95), tasks: rr.pick(TASK_COUNTS), kappa: rr.pick(KAPPAS), uplift: 0 });
  const byTasks = await block(r, n, draw, s => `tasks=${s.tasks}`);
  results.push({
    id: 'M1', ...judgeProportion(byTasks.promoted, byTasks.n, h.bound, h.direction), minTrials: h.minTrials, belowMinTrials: n < h.minTrials,
    claim: h.claim,
    assumptions: {
      base: 'uniform [0.2, 0.95]', tasks: TASK_COUNTS, kappa: KAPPAS.map(String), uplift: 0,
      difficulty: 'per-task Beta(mean base, concentration kappa); kappa Infinity = homogeneous', runNoise: 'independent Bernoulli per run',
      curator: RULE.label, store: 'real SqliteSystemMemory, fresh scope per trial',
    },
    outcomes: byTasks.reasons, byTasks: byTasks.breakdown, measurementsPerCandidate: byTasks.measurements / byTasks.n,
    decisionCrossCheck: { mismatches: byTasks.mismatches, examples: byTasks.mismatchExamples },
  });
}

// ---- M3: harmful (-10 points) --------------------------------------------------------------
{
  const h = hypothesis('M3');
  const n = args.trials ?? h.minTrials;
  const draw = rr => ({ base: uniform(rr, 0.2, 0.95), tasks: rr.pick(TASK_COUNTS), kappa: rr.pick(KAPPAS), uplift: -0.10 });
  const out = await block(r, n, draw, s => `tasks=${s.tasks}`);
  results.push({
    id: 'M3', ...judgeProportion(out.promoted, out.n, h.bound, h.direction), minTrials: h.minTrials, belowMinTrials: n < h.minTrials,
    claim: h.claim,
    assumptions: { base: 'uniform [0.2, 0.95]', tasks: TASK_COUNTS, kappa: KAPPAS.map(String), uplift: -0.10, effect: 'proportional (mean drop exactly 10 points)' },
    outcomes: out.reasons, byTasks: out.breakdown, measurementsPerCandidate: out.measurements / out.n,
    decisionCrossCheck: { mismatches: out.mismatches, examples: out.mismatchExamples },
  });
}

// ---- M2: +20 points, 20 tasks (power) ------------------------------------------------------
const POWER_BASE = [0.2, 0.65];
{
  const h = hypothesis('M2');
  const n = args.trials ?? h.minTrials;
  const draw = rr => ({ base: uniform(rr, ...POWER_BASE), tasks: 20, kappa: 4, uplift: 0.20 });
  const out = await block(r, n, draw, s => `base=${(Math.floor(s.base * 10) / 10).toFixed(1)}`);
  // Sensitivity of the same cell to task heterogeneity and to a fixed base (extra info, no verdict).
  const sensitivity = {};
  for (const kappa of [1, 20, Infinity]) {
    const s = await block(r, cellTrials, rr => ({ base: uniform(rr, ...POWER_BASE), tasks: 20, kappa, uplift: 0.20 }));
    sensitivity[`kappa=${kappa}`] = { n: s.n, promoted: s.promoted, rate: s.promoted / s.n };
  }
  const fixed = await block(r, cellTrials, () => ({ base: 0.5, tasks: 20, kappa: 4, uplift: 0.20 }));
  sensitivity['base=0.5,kappa=4'] = { n: fixed.n, promoted: fixed.promoted, rate: fixed.promoted / fixed.n };

  // Power curve: uplift x tasks.
  const curve = [];
  for (const uplift of [0.05, 0.10, 0.20, 0.30]) {
    for (const tasks of TASK_COUNTS) {
      const c = await block(r, cellTrials, rr => ({ base: uniform(rr, ...POWER_BASE), tasks, kappa: 4, uplift }));
      curve.push({ uplift, tasks, n: c.n, promoted: c.promoted, rate: c.promoted / c.n });
    }
  }
  const table = ['uplift \\ tasks | ' + TASK_COUNTS.join(' | ')];
  for (const uplift of [0.05, 0.10, 0.20, 0.30]) {
    table.push(`+${Math.round(uplift * 100)} pts | ` + TASK_COUNTS.map(t => pct(curve.find(c => c.uplift === uplift && c.tasks === t).rate)).join(' | '));
  }
  results.push({
    id: 'M2', ...judgeProportion(out.promoted, out.n, h.bound, h.direction), minTrials: h.minTrials, belowMinTrials: n < h.minTrials,
    claim: h.claim,
    assumptions: {
      base: `uniform [${POWER_BASE.join(', ')}] (so base + 30 points stays <= 0.95 across the curve)`, tasks: 20, kappa: 4,
      uplift: 0.20, effect: 'proportional (mean gain exactly 20 points)',
    },
    outcomes: out.reasons, byBase: out.breakdown, sensitivity, measurementsPerCandidate: out.measurements / out.n,
    decisionCrossCheck: { mismatches: out.mismatches, examples: out.mismatchExamples },
    powerCurve: { cellTrials, cells: curve, table },
  });
}

store.close();
emit('memory/curation', results, { seed, rule: RULE.label, wallSeconds: elapsed() });
