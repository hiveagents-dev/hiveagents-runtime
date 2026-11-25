/**
 * M7: the real `runMemoryAblation` (and so `ablationVerdict`) on null suites: memory has no true
 * effect, and infrastructure errors hit runs at 0 / 10 / 20 %, spread over every condition or
 * concentrated on one condition only. Plus a power check (+25 pts, 10 tasks, 3 repeats; report only)
 * and, as extra stress outside the registered claim, errors that fall on outcome-informative runs.
 *
 * Every run's outcome is drawn up front into a table (task, condition, repeat) -> {error, passed},
 * so the bulk (simulated Agents that answer from the table) and the cross-check (real `Agent`s
 * whose stub CLI must infer the condition from the prompt the SDK actually built, recalled block
 * and all) consume the same outcomes and must reach the same verdicts.
 *
 *   node scripts/simulation/memory/ablation.mjs [--seed N] [--trials N] [--power-trials N] [--cross-check N]
 */
import { emit, hypothesis, judgeProportion, rng, sdk } from '../lib/sim.mjs';
import { cli, stopwatch, taskDifficulties, uniform, withEffect } from './lib-env.mjs';

const args = cli({
  'power-trials': { type: 'string', default: '1000' }, 'cross-check': { type: 'string', default: '150' },
  // Extra power arms at other task counts (report only); the registered setting is 10 tasks.
  'power-tasks': { type: 'string', default: '10' },
});
const elapsed = stopwatch();
const h = hypothesis('M7');
const { runMemoryAblation } = await sdk('orchestration/index');
const { Agent, Runtime } = await sdk('index');

const CONDITIONS = ['off', 'on', 'irrelevant'];
const TASKS = [5, 10, 20];
const REPEATS = [1, 3];
const RATES = [0, 0.1, 0.2];
const PLACEMENTS = ['even', 'on', 'off', 'irrelevant'];
const ON_MARK = 'The billing team closes the books on the 25th.';
const DECOY_MARK = 'The office plants are watered on Fridays.';
const SCOPE = { tenant: 'twin', namespace: 'agents', subject: 'ablation' };
const memory = { provider: { id: 'twin-memory', recall: async () => [{ id: 'm1', source: 'twin', text: ON_MARK }] }, scope: SCOPE };
const irrelevantProvider = { id: 'twin-decoy', recall: async () => [{ id: 'd1', source: 'twin', text: DECOY_MARK }] };

/**
 * Draws one suite's outcome table. `errors`: { rate, placement } with placement even | on | off |
 * irrelevant | on-fails (errors replace failures under on) | off-passes (errors replace passes under off).
 */
function drawSuite(r, { tasks, repeats, base, kappa = 4, uplift = 0, errors }) {
  const p = taskDifficulties(r, base, tasks, kappa);
  const table = {};
  for (const condition of CONDITIONS) {
    table[condition] = p.map((pi, i) => Array.from({ length: repeats }, () => {
      const prob = condition === 'on' ? withEffect(pi, uplift, base) : pi;
      const passed = r.next() < prob;
      const { rate, placement } = errors;
      let error = false;
      if (placement === 'even' || placement === condition) error = r.next() < rate;
      else if (placement === 'on-fails' && condition === 'on') error = !passed && r.next() < Math.min(1, rate / Math.max(1e-9, 1 - pi));
      else if (placement === 'off-passes' && condition === 'off') error = passed && r.next() < Math.min(1, rate / Math.max(1e-9, pi));
      else r.next(); // keep the stream aligned across placements
      return { passed, error };
    }));
  }
  return table;
}

const taskList = n => Array.from({ length: n }, (_, i) => ({
  id: `task-${i}`, input: `Solve task task-${i}.`,
  check: turn => {
    if (turn.status !== 'completed') throw new Error('turn did not complete');
    return turn.text === 'PASS';
  },
}));

/** Simulated Agents: answer from the table by the run's context; `memory` must match the condition. */
function simulatedAgents(table, anomalies) {
  return (option, { condition, taskId, repeat }) => {
    const expectsMemory = condition !== 'off';
    if ((option === false) === expectsMemory) anomalies.push({ condition, option: option === false ? 'false' : 'memory' });
    const cell = table[condition][Number(taskId.slice(5))][repeat - 1];
    return {
      async send() {
        if (cell.error) throw Object.assign(new Error('infrastructure'), { name: 'InfraError' });
        return { status: 'completed', text: cell.passed ? 'PASS' : 'FAIL', warnings: [], providerMetadata: {} };
      },
      async close() {},
    };
  };
}

/** Real Agents over a stub CLI that sees only the prompt the SDK built and infers the condition from it. */
function realAgents(table, anomalies) {
  return (option, { condition, taskId, repeat }) => {
    const exec = {
      id: 'claude',
      async detect() { return { installed: true, path: '/bin/claude', version: '1.0.0' }; },
      async auth() { return { authenticated: true, source: 'subscription' }; },
      async models() { return []; },
      async execute(request) {
        const prompt = String(request.prompt);
        const seen = prompt.includes(ON_MARK) ? 'on' : prompt.includes(DECOY_MARK) ? 'irrelevant' : 'off';
        if (seen !== condition) anomalies.push({ condition, seen });
        const task = Number(/Solve task task-(\d+)\./.exec(prompt)[1]);
        const cell = table[seen][task][repeat - 1];
        if (cell.error) throw Object.assign(new Error('infrastructure'), { name: 'InfraError' });
        const text = cell.passed ? 'PASS' : 'FAIL';
        return { completed: true, failed: false, refused: false, sessionId: 's', text, events: [{ type: 'message.completed', text }], nativeEvents: [] };
      },
      async *stream(request) { yield { kind: 'result', result: await this.execute(request) }; },
    };
    return new Agent({ model: 'opus-5', memory: option }, new Runtime({ adapters: [exec] }));
  };
}

async function suite(table, tasks, repeats, makeAgents, anomalies) {
  return runMemoryAblation({
    id: 'twin-ablation', tasks: taskList(tasks), memory, irrelevantProvider, repeats,
    makeAgent: makeAgents(table, anomalies),
  });
}

const tally = report => ({ verdict: report.verdict, reason: report.reason, ...Object.fromEntries(CONDITIONS.map(c => [c, [report.conditions[c].passed, report.conditions[c].errors, report.conditions[c].runs]])) });

const r = rng(args.seed);
const n = args.trials ?? h.minTrials;
const anomalies = [];
const combos = [];
for (const tasks of TASKS) for (const repeats of REPEATS) for (const rate of RATES) {
  for (const placement of rate === 0 ? ['none'] : PLACEMENTS) combos.push({ tasks, repeats, rate, placement });
}
const byCombo = new Map();
const verdicts = {};
let helps = 0;
const crossN = Number(args['cross-check']);
const cross = { suites: 0, identical: 0, anomalies: [], differences: [] };
for (let i = 0; i < n; i += 1) {
  const combo = combos[i % combos.length];
  const settings = { tasks: combo.tasks, repeats: combo.repeats, base: uniform(r, 0.2, 0.9), errors: { rate: combo.rate, placement: combo.placement } };
  const table = drawSuite(r, settings);
  const report = await suite(table, combo.tasks, combo.repeats, simulatedAgents, anomalies);
  if (report.verdict === 'helps') helps += 1;
  verdicts[`${report.verdict}/${report.reason}`] = (verdicts[`${report.verdict}/${report.reason}`] ?? 0) + 1;
  const key = `T${combo.tasks} R${combo.repeats} e${combo.rate} ${combo.placement}`;
  const c = byCombo.get(key) ?? { n: 0, helps: 0, inconclusive: 0 };
  c.n += 1; if (report.verdict === 'helps') c.helps += 1; if (report.verdict === 'inconclusive') c.inconclusive += 1;
  byCombo.set(key, c);
  if (i < crossN) {
    cross.suites += 1;
    const real = await suite(table, combo.tasks, combo.repeats, realAgents, cross.anomalies);
    if (JSON.stringify(tally(real)) === JSON.stringify(tally(report))) cross.identical += 1;
    else if (cross.differences.length < 5) cross.differences.push({ i, simulated: tally(report), real: tally(real) });
  }
}
const breakdown = {};
for (const [key, c] of byCombo) breakdown[key] = { ...c, helpsRate: +(c.helps / c.n).toFixed(4) };
const marginal = keyOf => {
  const out = {};
  for (const [key, c] of byCombo) {
    const k = keyOf(key);
    out[k] ??= { n: 0, helps: 0 };
    out[k].n += c.n; out[k].helps += c.helps;
  }
  for (const v of Object.values(out)) v.rate = +(v.helps / v.n).toFixed(4);
  return out;
};

// Extra stress (not the registered claim): errors on outcome-informative runs.
const stress = {};
for (const placement of ['on-fails', 'off-passes']) {
  for (const rate of [0.1, 0.2]) {
    let k = 0, m = 0;
    const reasons = {};
    for (let i = 0; i < 300; i += 1) {
      const tasks = TASKS[i % 3], repeats = REPEATS[i % 2];
      const table = drawSuite(r, { tasks, repeats, base: uniform(r, 0.2, 0.9), errors: { rate, placement } });
      const rep = await suite(table, tasks, repeats, simulatedAgents, anomalies);
      m += 1; if (rep.verdict === 'helps') k += 1;
      reasons[`${rep.verdict}/${rep.reason}`] = (reasons[`${rep.verdict}/${rep.reason}`] ?? 0) + 1;
    }
    stress[`${placement} e=${rate}`] = { n: m, helps: k, rate: k / m, reasons };
  }
}

// Power check: +25 pts, 10 tasks, 3 repeats (report only); other task counts with --power-tasks.
const power = {};
for (const powerTasks of args['power-tasks'].split(',').map(Number)) {
  for (const errorsAt of [{ rate: 0, placement: 'none' }, { rate: 0.1, placement: 'even' }]) {
    let k = 0;
    const reasons = {};
    const pn = Number(args['power-trials']);
    for (let i = 0; i < pn; i += 1) {
      const table = drawSuite(r, { tasks: powerTasks, repeats: 3, base: uniform(r, 0.2, 0.7), uplift: 0.25, errors: errorsAt });
      const rep = await suite(table, powerTasks, 3, simulatedAgents, anomalies);
      if (rep.verdict === 'helps') k += 1;
      reasons[`${rep.verdict}/${rep.reason}`] = (reasons[`${rep.verdict}/${rep.reason}`] ?? 0) + 1;
    }
    const prefix = powerTasks === 10 ? '' : `tasks ${powerTasks} `;
    power[`${prefix}errors ${errorsAt.placement} ${errorsAt.rate}`] = { n: pn, helps: k, rate: k / pn, reasons };
  }
}

emit('memory/ablation', [{
  id: 'M7', ...judgeProportion(helps, n, h.bound, h.direction), minTrials: h.minTrials, belowMinTrials: n < h.minTrials, claim: h.claim,
  assumptions: {
    tasks: TASKS, repeats: REPEATS, errorRates: RATES, placements: PLACEMENTS,
    placementMeaning: 'even: every run of every condition errors w.p. rate; on/off/irrelevant: only that condition\'s runs, w.p. rate',
    design: 'combos cycled evenly (rate 0 has one placement)', base: 'uniform [0.2, 0.9]', kappa: 4, trueEffect: 0,
    ablation: 'runMemoryAblation defaults: minTasks 5, maxErrorRate 0.25, concurrency 1',
    agents: 'simulated Agents answering from a pre-drawn outcome table (see crossCheck for real Agents)',
  },
  verdicts, byRepeats: marginal(k => k.split(' ')[1]), byTasks: marginal(k => k.split(' ')[0]),
  byErrors: marginal(k => k.split(' ').slice(2).join(' ')), breakdown,
  wiringAnomalies: anomalies.length,
  crossCheck: { what: 'first N null suites re-run with real Agent + Runtime over a stub CLI that infers the condition from the SDK-built prompt', ...cross, anomalies: cross.anomalies.length },
  extraStress: { note: 'not pre-registered: errors replace failures under on, or passes under off', ...stress },
  power: { setting: '+25 pts (proportional), 10 tasks, 3 repeats, base uniform [0.2, 0.7], kappa 4', ...power },
}], { seed: args.seed, wallSeconds: elapsed() });
