/**
 * W2 — hard limits of dynamic workflows under fuzzing.
 *
 * Each trial draws limits within DYNAMIC_LIMIT_BOUNDS (read from the SDK) and a random script or plan,
 * and runs it on the REAL engine with an instrumented runner (latency 0-4 ms, log-normal tokens,
 * failures with and without usage, schema-invalid outputs, provider rate limits, per-attempt timeouts,
 * external aborts). Scripts run on `createDynamicEngine({ clock })` whose rate-limit backoff waits 1 real
 * ms per virtual second; plans run on `runWorkflowPlan` (real-time backoff) with `rateLimitRetries: 0`.
 *
 * The exact promise read from agent-call.ts / context.ts / concurrency.ts:
 * - a slot of the run's adaptive window is held around every runner invocation (first attempt, schema
 *   retries, and rate-limit retries after re-queueing; never during a backoff), and the window never
 *   exceeds the ceiling -> invocations in flight <= concurrency; every `concurrency.changed` event
 *   chains from `initialConcurrency` and stays within [1, concurrency];
 * - `reserveAgent()` is taken once per `agent()` call (never per attempt), and cached replays count too
 *   -> calls (distinct call keys) that reach the runner <= maxAgents; attempts of one call <= 1 +
 *   schemaRetries + rateLimitRetries;
 * - `budgetLeft()` (spent < tokens) is checked synchronously right before every runner invocation,
 *   and every reported usage (failed turns included) is added when the invocation settles. So
 *   (A) no invocation starts once spent >= tokens, and (B) the final spend exceeds the budget by at
 *   most the tokens of the invocations already started but not yet accounted when spend first reached
 *   the budget ("in flight when it ran out", the crossing invocation included);
 *   (C) report.spent equals the sum of usage the runner reported (input + output);
 * - items beyond maxItems: `parallel`/`pipeline` reject before any thunk/stage runs; a plan map over
 *   args is refused before the run starts; a map over an earlier output is refused before any call of
 *   its wave (PLAN_INVALID).
 *
 * Usage: node scripts/simulation/workflows/limits.mjs [--seed 1] [--trials 5000] [--width 16]
 */
import { emit, hypothesis, judgeInvariant, rng, sdk } from '../lib/sim.mjs';
import { planSpec, scriptFromSpec, scriptSpec } from './lib-flows.mjs';
import { flags, pool, quantile, sleep } from './lib-twin.mjs';

/** Rate-limit backoff at 1 real ms per virtual second, so retries stay in the trial's time scale. */
const FAST_CLOCK = { now: () => Date.now(), sleep: (ms, signal) => sleep(ms / 1000, signal) };

function drawLimits(r, bounds, isPlan) {
  const between = (key, low, high) => r.int(Math.max(bounds[key].min, low), Math.min(bounds[key].max, high));
  const limits = {
    maxAgents: r.bernoulli(0.05) ? bounds.maxAgents.max : between('maxAgents', 1, 60),
    concurrency: between('concurrency', 1, 16),
    maxItems: r.bernoulli(0.05) ? bounds.maxItems.max : between('maxItems', 1, 24),
    schemaRetries: between('schemaRetries', 0, 5),
    rateLimitRetries: isPlan ? 0 : between('rateLimitRetries', 0, 4),
  };
  if (r.bernoulli(0.3)) limits.initialConcurrency = r.int(1, limits.concurrency);
  if (r.bernoulli(0.6)) limits.tokens = r.int(1, 8000);
  if (r.bernoulli(0.15)) limits.agentTimeoutMs = between('agentTimeoutMs', 1, 6);
  return limits;
}

async function trial(index, opts, dynamic) {
  const r = rng(opts.seed * 7_919 + index);
  const isPlan = r.bernoulli(0.4);
  const limits = drawLimits(r, dynamic.DYNAMIC_LIMIT_BOUNDS, isPlan);
  const spec = isPlan ? planSpec(r, { maxItems: 30 }) : scriptSpec(r, { maxN: 30 });
  if (isPlan) {
    for (const step of spec.plan.steps) {
      if (step.kind === 'map' && r.bernoulli(0.3)) step.maxItems = r.int(1, limits.maxItems + (r.bernoulli(0.2) ? 3 : 0));
    }
  }
  const violations = [];
  const state = {
    seq: 0, spent: 0, crossSeq: undefined, spentBeforeCross: undefined, inFlight: 0, maxInFlight: 0, invocations: [], tokens: 0,
    attemptsByKey: new Map(), rateLimited: 0, windowChanges: 0,
  };
  const touched = { thunks: new Map(), stages: new Map() };
  const RunnerError = dynamic.DynamicRunnerError;
  const runner = {
    async run(request) {
      const call = { seq: ++state.seq, spentAtStart: state.spent, prompt: request.prompt, tokens: 0 };
      state.invocations.push(call);
      state.attemptsByKey.set(request.key, (state.attemptsByKey.get(request.key) ?? 0) + 1);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const total = Math.max(2, Math.round(r.lognormal(300, 2000)));
      const usage = fraction => {
        const input = Math.round(total * 0.8 * fraction), output = Math.round(total * 0.2 * fraction);
        call.tokens = input + output; state.tokens += call.tokens;
        return { inputTokens: input, outputTokens: output, costMeaning: 'estimate' };
      };
      try {
        await sleep(r.next() * 4, request.signal, () => new RunnerError('ABORTED', { usage: usage(0.3) }));
        const roll = r.next();
        if (roll < 0.08) throw new RunnerError('PROVIDER_FAILED', { usage: usage(1) });
        if (roll < 0.10) throw new Error('no usage reported');
        if (roll < 0.16) { state.rateLimited++; throw new RunnerError('RATE_LIMITED', r.bernoulli(0.3) ? { usage: usage(0.05) } : {}); }
        const schema = request.options.schema;
        const u = usage(1);
        if (!schema) return { text: `ok ${call.seq}`, usage: u };
        const bad = r.next() < 0.15;
        const output = schema.type === 'array' ? (bad ? 'x' : Array.from({ length: r.int(1, 8) }, (_, i) => `t${i}`)) : (bad ? { v: 1 } : { v: 'ok' });
        return { text: JSON.stringify(output), output, usage: u };
      } finally { state.inFlight--; }
    },
  };
  const resolved = dynamic.resolveDynamicLimits(limits);
  let window = resolved.initialConcurrency;
  const onEvent = event => {
    if (event.type === 'concurrency.changed') {
      state.windowChanges++;
      if (event.previous !== window || event.window < 1 || event.window > limits.concurrency || event.ceiling !== limits.concurrency) {
        violations.push({ kind: 'window', event: { previous: event.previous, window: event.window, ceiling: event.ceiling }, expectedPrevious: window });
      }
      window = event.window;
      return;
    }
    if (event.type !== 'budget') return;
    const before = state.spent;
    state.spent = event.spent;
    state.seq++;
    if (limits.tokens !== undefined && state.crossSeq === undefined && event.spent >= limits.tokens) {
      state.crossSeq = state.seq; state.spentBeforeCross = before;
    }
  };
  const controller = new AbortController();
  if (r.bernoulli(0.1)) setTimeout(() => controller.abort(), r.next() * 30);
  const options = { runId: `w2-${index}`, runner, limits, onEvent, signal: controller.signal };
  let report, refusedUpFront;
  try {
    if (isPlan) report = await dynamic.runWorkflowPlan(spec.plan, { ...options, args: spec.args });
    else {
      report = await dynamic.createDynamicEngine({ clock: FAST_CLOCK })(spec.meta, scriptFromSpec(spec, {
        thunk: (i) => touched.thunks.set(i, (touched.thunks.get(i) ?? 0) + 1),
        stage: (i) => touched.stages.set(i, (touched.stages.get(i) ?? 0) + 1),
      }), options);
    }
  } catch (error) { refusedUpFront = error; }

  const n = state.invocations.length;
  // Negative control (--control tight): every bound one unit tighter than promised must be caught.
  const slack = opts.control === 'tight' ? 1 : 0;
  // In flight and agent count.
  if (state.maxInFlight > limits.concurrency - slack) violations.push({ kind: 'concurrency', max: state.maxInFlight, limit: limits.concurrency });
  const calls = state.attemptsByKey.size;
  if (calls > limits.maxAgents - slack) violations.push({ kind: 'maxAgents', calls, invocations: n, limit: limits.maxAgents });
  const attemptCap = 1 + limits.schemaRetries + limits.rateLimitRetries;
  const maxAttempts = Math.max(0, ...state.attemptsByKey.values());
  if (maxAttempts > attemptCap - slack) violations.push({ kind: 'attempts-per-call', maxAttempts, cap: attemptCap });
  // Tokens.
  let overshoot = 0, allowance = 0;
  if (report) {
    if (report.spent !== state.tokens) violations.push({ kind: 'accounting', reported: report.spent, runnerTokens: state.tokens });
    if (limits.tokens !== undefined) {
      const late = state.invocations.filter(call => call.spentAtStart >= (slack ? limits.tokens / 2 : limits.tokens));
      if (late.length) violations.push({ kind: 'started-after-budget', count: late.length });
      if (state.crossSeq !== undefined) {
        const startedBefore = state.invocations.filter(call => call.seq < state.crossSeq).reduce((sum, call) => sum + call.tokens, 0);
        allowance = startedBefore - state.spentBeforeCross;
        overshoot = report.spent - limits.tokens;
        if (overshoot > allowance - slack) violations.push({ kind: 'budget-bound', overshoot, allowance });
        // Exact form: the final spend is the usage of the invocations started before the crossing, nothing more.
        if (report.spent !== startedBefore) violations.push({ kind: 'budget-exact', spent: report.spent, startedBefore });
      }
    }
  }
  // Items beyond maxItems.
  let itemRefusals = 0;
  if (!isPlan) {
    spec.ops.forEach((op, i) => {
      if ((op.op === 'parallel' || op.op === 'pipeline') && op.n > limits.maxItems) {
        itemRefusals++;
        const ran = (touched.thunks.get(i) ?? 0) + (touched.stages.get(i) ?? 0)
          + state.invocations.filter(call => call.prompt.startsWith(`Step ${i}:`) || call.prompt.startsWith(`Step ${i} stage`)).length;
        if (ran > 0) violations.push({ kind: 'maxItems-script', op: op.op, n: op.n, limit: limits.maxItems, ran });
      }
    });
  } else {
    const files = spec.plan.steps.find(step => step.id === 'files');
    const fileCeiling = files ? Math.min(files.maxItems ?? limits.maxItems, limits.maxItems) : Infinity;
    const stepTooWide = spec.plan.steps.some(step => step.maxItems !== undefined && step.maxItems > limits.maxItems);
    if (files && spec.args.items.length > fileCeiling || stepTooWide) {
      itemRefusals++;
      if (!(refusedUpFront?.name === 'DynamicPlanError') || n > 0) {
        violations.push({ kind: 'maxItems-plan-args', items: spec.args.items.length, ceiling: fileCeiling, stepTooWide, refused: refusedUpFront?.name ?? null, invocations: n });
      }
    } else if (report?.error?.code === 'PLAN_INVALID') {
      itemRefusals++;
      if (state.invocations.some(call => call.prompt.startsWith('Expand the topic'))) violations.push({ kind: 'maxItems-plan-wave', invocations: n });
    }
  }
  if (refusedUpFront && !(refusedUpFront.name === 'DynamicPlanError' || refusedUpFront instanceof TypeError)) {
    violations.push({ kind: 'unexpected-throw', name: refusedUpFront.name, message: String(refusedUpFront.message).slice(0, 160) });
  }
  return {
    index, isPlan, limits, violations, invocations: n, maxInFlight: state.maxInFlight, status: report?.status ?? `threw ${refusedUpFront?.name}`,
    budgetCrossed: state.crossSeq !== undefined, overshoot, allowance, itemRefusals, saturated: state.maxInFlight === limits.concurrency,
    hitMaxAgents: calls === limits.maxAgents, retriedBeyondCalls: n > calls, invocationsBeyondMaxAgents: n > limits.maxAgents,
    rateLimited: state.rateLimited, windowChanges: state.windowChanges,
  };
}

async function main() {
  const h = hypothesis('W2');
  const opts = flags({ seed: 1, trials: h.minTrials, width: 16 });
  const dynamic = await sdk('orchestration/dynamic');
  const started = Date.now();
  const trials = await pool(opts.trials, opts.width, index => trial(index, opts, dynamic));
  const bad = trials.filter(t => t.violations.length);
  const byKind = {};
  for (const t of bad) for (const v of t.violations) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
  const statuses = {};
  for (const t of trials) statuses[t.status] = (statuses[t.status] ?? 0) + 1;
  const crossed = trials.filter(t => t.budgetCrossed);
  emit('workflows/limits', [{
    id: 'W2', claim: h.claim,
    ...judgeInvariant(bad.reduce((sum, t) => sum + t.violations.length, 0), opts.trials),
    violationsByKind: byKind,
    examples: bad.slice(0, 6).map(t => ({ trial: t.index, limits: t.limits, isPlan: t.isPlan, violations: t.violations.slice(0, 3) })),
    coverage: {
      trials: opts.trials, plans: trials.filter(t => t.isPlan).length, scripts: trials.filter(t => !t.isPlan).length,
      runnerInvocations: trials.reduce((sum, t) => sum + t.invocations, 0),
      trialsSaturatingConcurrency: trials.filter(t => t.saturated).length,
      trialsReachingMaxAgents: trials.filter(t => t.hitMaxAgents).length,
      trialsWithRetries: trials.filter(t => t.retriedBeyondCalls).length,
      trialsWithInvocationsBeyondMaxAgents: trials.filter(t => t.invocationsBeyondMaxAgents).length,
      rateLimitedInvocations: trials.reduce((sum, t) => sum + t.rateLimited, 0),
      windowChanges: trials.reduce((sum, t) => sum + t.windowChanges, 0),
      trialsCrossingTokenBudget: crossed.length,
      overshootTokens: { p50: quantile(crossed.map(t => t.overshoot), 0.5), p95: quantile(crossed.map(t => t.overshoot), 0.95), max: Math.max(0, ...crossed.map(t => t.overshoot)) },
      overshootOverAllowance: { p50: quantile(crossed.filter(t => t.allowance > 0).map(t => t.overshoot / t.allowance), 0.5), max: Math.max(0, ...crossed.filter(t => t.allowance > 0).map(t => t.overshoot / t.allowance)) },
      maxItemsRefusalsChecked: trials.reduce((sum, t) => sum + t.itemRefusals, 0),
      statuses,
    },
    assumptions: {
      limits: 'maxAgents 1..60 (5%: 1000), concurrency 1..16, initialConcurrency 1..concurrency in 30%, maxItems 1..24 (5%: 4096), schemaRetries 0..5, rateLimitRetries 0..4 (plans: 0), tokens 1..8000 in 60% of trials, agentTimeoutMs 1..6 ms in 15%',
      maxAgents: 'counted in calls (distinct call keys reaching the runner), not attempts; attempts of a call are bounded by 1 + schemaRetries + rateLimitRetries',
      workflows: '40% plans (agent + map over args (1..30 items) + map over an earlier output, random step maxItems), 60% scripts (agent/parallel/pipeline/phase, 1..30 items)',
      runner: 'latency uniform 0..4 ms honouring the signal (an aborted turn reports 30% of its usage); tokens log-normal median 300 p95 2000; 8% failures with usage, 2% plain errors without usage, 6% RATE_LIMITED (30% of them with 5% usage), 15% schema-invalid outputs',
      aborts: '10% of runs aborted by the caller at uniform 0..30 ms',
      bound: 'B: final spend - budget <= tokens of invocations started before spend first reached the budget minus spend before that moment (exactly the invocations in flight then)',
    },
    crossCheck: 'not applicable: the real engine runs; the runner itself measures in-flight calls and tokens independently of the engine',
  }], { seed: opts.seed, ...(opts.control ? { control: opts.control } : {}), wallMs: Date.now() - started });
}

await main();
