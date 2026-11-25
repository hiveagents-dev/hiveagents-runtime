/**
 * W3 — goodput of the default concurrency under a subscription-like rate limit.
 *
 * Method: the REAL engine (`createDynamicEngine`) driven by a virtual clock. Only the environment's time
 * is virtual: the fake runner sleeps on the clock, the engine's rate-limit backoff waits on the same clock
 * (`createDynamicEngine({ clock })`), and the driver advances the clock to the next pending wake-up only
 * once the process is idle (a setImmediate turn drains every promise chain of the engine), so the engine's
 * own scheduling (adaptive window, parallel, pipeline, call order, retries) is exactly the shipped code. The
 * engine's per-attempt timeouts (15 min real time) never fire.
 * Cross-check: a subset of workloads re-run on the real engine with REAL timers at scaled time
 * (1 virtual second = `--scale` real ms), compared run by run.
 *
 * Environment (pre-registered): latency log-normal median 25 s, p95 120 s; workloads of 8-60
 * independent agent calls (map, pipeline or both); token bucket 6 requests/min sustained, burst 8,
 * starting full; a request over the limit fails with a rate-limit error after 2 s. Goodput = completed
 * calls per minute of wall time.
 *
 * Configurations:
 * - fixed c = 1..16 (the baseline, and the pre-registered W3 judgment, unchanged): the window pinned at c
 *   (`concurrency: c, initialConcurrency: c`) and the application retrying inside its runner while holding
 *   the slot, exponential backoff base 5 s (5, 10, 20, 40 s), at most 4 retries, then the call fails. The
 *   engine never sees a rate limit, so its window never moves: exactly the engine before the adaptive window.
 * - adaptive (the configuration under test): the runner surfaces the SDK's typed rate-limit error
 *   (`DynamicRunnerError('RATE_LIMITED')`, what `agentRunner` maps the SDK's USAGE_LIMIT to) after the 2 s
 *   rejection; the ENGINE adapts its window (default ceiling 8 starting at 4; and ceiling 16) and retries
 *   with its own backoff (`rateLimitRetries` default 3), holding no slot while it waits.
 *
 * Usage: node scripts/simulation/workflows/throughput.mjs [--seed 1] [--trials 500] [--cross 16] [--scale 2]
 */
import { emit, hypothesis, judgeProportion, rng, sdk } from '../lib/sim.mjs';
import { flags, pool, quantile, sleep } from './lib-twin.mjs';

const CONCURRENCY = Array.from({ length: 16 }, (_, i) => i + 1);
const ENV = { median: 25_000, p95: 120_000, perMinute: 6, burst: 8, rejectMs: 2_000 };
/** The fixed baseline's application-level retry (the configuration measured before the adaptive window). */
const APP_RETRY = { backoffMs: 5_000, retries: 4 };
/** Configurations under test: the engine defaults (ceiling 8) and the largest ceiling. */
const ADAPTIVE = [
  { name: 'adaptive (default: ceiling 8, start 4)', limits: {} },
  { name: 'adaptive (ceiling 16, start 4)', limits: { concurrency: 16 } },
];

class VirtualClock {
  now = 0;
  #queue = [];
  sleep(ms, signal, onAbort) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(onAbort()); return; }
      const entry = { at: this.now + ms, resolve };
      const abort = () => { this.#queue.splice(this.#queue.indexOf(entry), 1); reject(onAbort()); };
      entry.resolve = () => { signal?.removeEventListener('abort', abort); resolve(); };
      this.#queue.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async drive(isDone) {
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (isDone()) return;
      if (this.#queue.length === 0) throw new Error('virtual clock deadlock: nothing pending and the run is not finished');
      const at = Math.min(...this.#queue.map(entry => entry.at));
      this.now = at;
      const due = this.#queue.filter(entry => entry.at === at);
      this.#queue = this.#queue.filter(entry => entry.at !== at);
      for (const entry of due) entry.resolve();
    }
  }
}

/** Real time at `scale` real ms per virtual second. */
class ScaledClock {
  #t0 = performance.now();
  constructor(scale) { this.scale = scale; }
  get now() { return ((performance.now() - this.#t0) / this.scale) * 1000; }
  sleep(ms, signal, onAbort) { return sleep((ms / 1000) * this.scale, signal, onAbort); }
}

/** The engine's backoff clock over the environment's clock. */
const engineClock = clock => ({ now: () => clock.now, sleep: (ms, signal) => clock.sleep(ms, signal, () => signal.reason) });

function bucket(clock, perMinute, burst) {
  let tokens = burst, last = 0;
  return () => {
    const now = clock.now;
    tokens = Math.min(burst, tokens + ((now - last) / 60_000) * perMinute);
    last = now;
    if (tokens >= 1) { tokens -= 1; return true; }
    return false;
  };
}

function workload(r) {
  const calls = r.int(8, 60);
  const kind = r.pick(['map', 'pipeline', 'mixed']);
  const latency = Array.from({ length: calls + 3 }, () => r.lognormal(ENV.median, ENV.p95));
  return { calls, kind, latency, stages: r.int(2, 3) };
}

function script(w) {
  // Call ids are fixed by position (map index, or item x stage), so a call keeps its latency in every configuration.
  return async ctx => {
    const call = id => ctx.agent(`call #${id}`);
    const map = (offset, n) => ctx.parallel(Array.from({ length: n }, (_, i) => () => call(offset + i)));
    const pipelined = (offset, n) => {
      const items = Array.from({ length: Math.max(1, Math.round(n / w.stages)) }, (_, i) => i);
      return ctx.pipeline(items, ...Array.from({ length: w.stages }, (_, s) => (_value, item) => call(offset + item * w.stages + s)));
    };
    if (w.kind === 'map') return map(0, w.calls);
    if (w.kind === 'pipeline') return pipelined(0, w.calls);
    const half = Math.floor(w.calls / 2);
    return Promise.all([map(0, half), pipelined(half, w.calls - half)]);
  };
}

/** `config`: `{ fixed: c }` or `{ adaptive: limits }`. */
async function runOne(dynamic, w, config, clock, perMinute) {
  const take = bucket(clock, perMinute, ENV.burst);
  const RunnerError = dynamic.DynamicRunnerError;
  const adaptive = config.adaptive !== undefined;
  const stats = { completed: 0, failed: 0, rejections: 0, windowChanges: 0, minWindow: Infinity, maxWindow: 0 };
  const onAbort = () => new RunnerError('ABORTED');
  const runner = {
    async run(request) {
      const id = Number(/#(\d+)/.exec(request.prompt)[1]);
      for (let attempt = 0; ; attempt++) {
        if (take()) {
          await clock.sleep(w.latency[id], request.signal, onAbort);
          stats.completed++;
          return { text: `done ${id}`, usage: { inputTokens: 1, outputTokens: 1, costMeaning: 'estimate' } };
        }
        stats.rejections++;
        await clock.sleep(ENV.rejectMs, request.signal, onAbort);
        // Adaptive: the SDK's typed signal reaches the engine, which owns the retry.
        if (adaptive) throw new RunnerError('RATE_LIMITED');
        if (attempt >= APP_RETRY.retries) throw new RunnerError('PROVIDER_FAILED');
        await clock.sleep(APP_RETRY.backoffMs * 2 ** attempt, request.signal, onAbort);
      }
    },
  };
  const limits = adaptive
    ? { maxAgents: 1000, ...config.adaptive }
    : { concurrency: config.fixed, initialConcurrency: config.fixed, maxAgents: 1000 };
  const onEvent = event => {
    if (event.type !== 'concurrency.changed') return;
    stats.windowChanges++;
    stats.minWindow = Math.min(stats.minWindow, event.window);
    stats.maxWindow = Math.max(stats.maxWindow, event.window);
  };
  let done = false;
  const engine = dynamic.createDynamicEngine({ clock: engineClock(clock) });
  const run = engine({ name: 'w3', description: 'Throughput workload.' }, script(w), {
    runId: `w3-${adaptive ? 'adaptive' : config.fixed}`, runner, limits, onEvent,
  }).finally(() => { done = true; });
  if (clock instanceof VirtualClock) await clock.drive(() => done);
  const report = await run;
  stats.failed = report.agents.filter(agent => agent.status !== 'completed').length;
  const minutes = clock.now / 60_000;
  return { ...stats, minutes, goodput: stats.completed / minutes, status: report.status };
}

async function curve(dynamic, workloads, perMinute) {
  return pool(workloads.length, 8, async index => {
    const w = workloads[index];
    const runs = [];
    for (const c of CONCURRENCY) runs.push(await runOne(dynamic, w, { fixed: c }, new VirtualClock(), perMinute));
    const adaptive = [];
    for (const a of ADAPTIVE) adaptive.push(await runOne(dynamic, w, { adaptive: a.limits }, new VirtualClock(), perMinute));
    const best = Math.max(...runs.map(run => run.goodput));
    // Information: goodput rewards dropped calls (a failed call shortens the run), so also compare with the
    // best fixed concurrency that completed every call (the lowest levels always do in this environment).
    const lossless = runs.filter(run => run.failed === 0).map(run => run.goodput);
    const bestLossless = lossless.length ? Math.max(...lossless) : undefined;
    return { w, runs, adaptive, best, bestLossless, ok: runs[3].goodput >= 0.85 * best };
  });
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

function row(results, pick) {
  const g = results.map(res => pick(res).goodput);
  const ratio = results.map(res => pick(res).goodput / res.best);
  const comparable = results.filter(res => res.bestLossless !== undefined);
  const lossless = comparable.map(res => pick(res).goodput / res.bestLossless);
  return {
    goodputMean: +mean(g).toFixed(3),
    goodputP50: +quantile(g, 0.5).toFixed(3),
    ratioToBestMean: +mean(ratio).toFixed(3),
    ratioToBestP10: +quantile(ratio, 0.1).toFixed(3),
    shareWithin85pct: +(ratio.filter(x => x >= 0.85).length / ratio.length).toFixed(3),
    failedCallsMean: +mean(results.map(res => pick(res).failed)).toFixed(2),
    rejectionsMean: +mean(results.map(res => pick(res).rejections)).toFixed(1),
    ratioToBestLosslessMean: lossless.length ? +mean(lossless).toFixed(3) : null,
    shareWithin85pctOfBestLossless: lossless.length ? +(lossless.filter(x => x >= 0.85).length / lossless.length).toFixed(3) : null,
  };
}

function table(results) {
  return CONCURRENCY.map((c, i) => ({
    concurrency: c, ...row(results, res => res.runs[i]),
    bestIn: results.filter(res => res.runs[i].goodput === res.best).length,
  }));
}

/** The configurations under test against each workload's best fixed concurrency. */
function adaptiveTable(results, h) {
  return ADAPTIVE.map((a, i) => {
    const within = results.filter(res => res.adaptive[i].goodput >= 0.85 * res.best).length;
    const vsC4 = results.map(res => res.adaptive[i].goodput / res.runs[3].goodput);
    return {
      configuration: a.name, ...row(results, res => res.adaptive[i]),
      atLeastBestFixed: results.filter(res => res.adaptive[i].goodput >= res.best).length,
      ratioToFixedC4Mean: +mean(vsC4).toFixed(3),
      ratioToFixedC4P10: +quantile(vsC4, 0.1).toFixed(3),
      windowChangesMean: +mean(results.map(res => res.adaptive[i].windowChanges)).toFixed(1),
      minWindowP50: quantile(results.map(res => Math.min(res.adaptive[i].minWindow, 4)), 0.5),
      maxWindowP50: quantile(results.map(res => Math.max(res.adaptive[i].maxWindow, 4)), 0.5),
      // The W3 criterion applied to this configuration (information: the registry judges fixed c=4).
      sameCriterionAsW3: judgeProportion(within, results.length, h.bound, h.direction),
    };
  });
}

async function main() {
  const h = hypothesis('W3');
  const opts = flags({ seed: 1, trials: h.minTrials, cross: 16, scale: 2 });
  const dynamic = await sdk('orchestration/dynamic');
  const started = Date.now();
  const r = rng(opts.seed * 104_729);
  const workloads = Array.from({ length: opts.trials }, () => workload(r));
  const main6 = await curve(dynamic, workloads, ENV.perMinute);
  const k = main6.filter(res => res.ok).length;
  const byKind = {};
  for (const kind of ['map', 'pipeline', 'mixed']) {
    const subset = main6.filter(res => res.w.kind === kind);
    byKind[kind] = {
      workloads: subset.length, c4Within85pct: subset.filter(res => res.ok).length,
      adaptiveDefaultWithin85pct: subset.filter(res => res.adaptive[0].goodput >= 0.85 * res.best).length,
    };
  }
  const sensitivity = {};
  for (const perMinute of [3, 15]) {
    const res = await curve(dynamic, workloads, perMinute);
    const ok = res.filter(x => x.ok).length;
    sensitivity[`${perMinute}/min`] = {
      ...judgeProportion(ok, res.length, h.bound, h.direction), note: 'information only',
      curve: table(res).map(t => ({
        c: t.concurrency, goodputMean: t.goodputMean, ratioToBestMean: t.ratioToBestMean, shareWithin85pct: t.shareWithin85pct,
        failedCallsMean: t.failedCallsMean, ratioToBestLosslessMean: t.ratioToBestLosslessMean,
      })),
      configurationUnderTest: adaptiveTable(res, h).map(t => ({
        configuration: t.configuration, goodputMean: t.goodputMean, ratioToBestMean: t.ratioToBestMean, ratioToBestP10: t.ratioToBestP10,
        shareWithin85pct: t.shareWithin85pct, failedCallsMean: t.failedCallsMean, rejectionsMean: t.rejectionsMean,
        ratioToBestLosslessMean: t.ratioToBestLosslessMean, shareWithin85pctOfBestLossless: t.shareWithin85pctOfBestLossless,
      })),
    };
  }

  // Cross-check: real timers at scaled time, small workloads, a few fixed levels and the adaptive default.
  const crossLevels = [2, 4, 8, 16];
  const crossWorkloads = workloads.filter(w => w.calls <= 24).slice(0, opts.cross);
  const pairs = await Promise.all(crossWorkloads.flatMap(w => [...crossLevels, 'adaptive'].map(async c => {
    const config = c === 'adaptive' ? { adaptive: ADAPTIVE[0].limits } : { fixed: c };
    const virtual = await runOne(dynamic, w, config, new VirtualClock(), ENV.perMinute);
    const real = await runOne(dynamic, w, config, new ScaledClock(opts.scale), ENV.perMinute);
    return { w, c, virtual: virtual.goodput, real: real.goodput, completedSame: virtual.completed === real.completed };
  })));
  // Verdict-level agreement: per workload, is c=4 within 85% of the best of the cross-check levels, in both clocks?
  const verdictAgreement = crossWorkloads.map(w => {
    const mine = pairs.filter(p => p.w === w && p.c !== 'adaptive');
    const ok = field => mine.find(p => p.c === 4)[field] >= 0.85 * Math.max(...mine.map(p => p[field]));
    return ok('virtual') === ok('real');
  }).filter(Boolean).length;
  const rel = list => list.map(p => Math.abs(p.real - p.virtual) / p.virtual);
  const summary = values => values.length === 0 ? null : ({ mean: +mean(values).toFixed(4), p95: +quantile(values, 0.95).toFixed(4), max: +Math.max(...values).toFixed(4) });
  emit('workflows/throughput', [{
    id: 'W3', claim: h.claim,
    ...judgeProportion(k, main6.length, h.bound, h.direction),
    method: 'real engine on a virtual clock (only the environment is simulated; the engine backoff waits on the same clock); cross-checked against the real engine with real timers at scaled time',
    goodputCurve: table(main6),
    configurationUnderTest: adaptiveTable(main6, h),
    byWorkloadKind: byKind,
    sensitivity,
    crossCheck: {
      runs: pairs.length, workloads: crossWorkloads.length, configurations: [...crossLevels, 'adaptive (default)'], scale: `${opts.scale} real ms per virtual second`,
      relativeGoodputDifference: summary(rel(pairs)),
      relativeGoodputDifferenceAdaptive: summary(rel(pairs.filter(p => p.c === 'adaptive'))),
      sameCompletedCount: pairs.filter(p => p.completedSame).length,
      c4VerdictAgreementAmongLevels: `${verdictAgreement}/${crossWorkloads.length}`,
    },
    assumptions: {
      ...ENV, latencyUnit: 'ms of virtual time', bucket: 'continuous refill, starts full at burst capacity, shared by all calls of the run',
      retries: `fixed c: inside the application runner while the engine slot is held, base ${APP_RETRY.backoffMs} ms, at most ${APP_RETRY.retries} retries, no jitter (as pre-registered), then the call fails; adaptive: the engine's rate-limit retry (rateLimitRetries default 3, wait in [d/2, d) with d = 5 s x 2^n, deterministic jitter per call key), no slot held while waiting, then the call fails RATE_LIMITED`,
      workloads: '8-60 calls; map (one parallel), pipeline (2-3 stages, items flow without barrier) or mixed (half map, half pipeline, concurrently); latency per call drawn once and reused across configurations (common random numbers)',
      goodput: 'completed calls / wall minutes from run start to run end',
      bestLossless: 'information only: the best fixed concurrency of the workload among those that completed every call',
    },
  }], { seed: opts.seed, wallMs: Date.now() - started });
}

await main();
