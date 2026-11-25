/**
 * W4 — structured-output retries.
 *
 * Where retries happen: in the engine (agent-call.ts `attempts`): a schema-invalid output, a missing or
 * non-JSON answer, or a runner `DynamicRunnerError('OUTPUT_INVALID')` is re-asked with the schema
 * errors appended to the prompt, up to `schemaRetries` (default 2) more attempts; every retry takes a
 * budget check but no `maxAgents` unit (maxAgents counts calls, not attempts). The bundled `agentRunner` feeds that loop: when the
 * Agent rejects the provider's output against `outputSchema` (STRUCTURED_OUTPUT_ERROR) and the output
 * is JSON, it returns it instead of failing, so the engine validates and re-asks; a missing/non-JSON
 * output becomes OUTPUT_INVALID, which the engine also re-asks.
 *
 * Path A (verdict): the real engine with a fake DynamicAgentRunner whose every attempt is invalid with
 * probability p, the invalid kind drawn uniformly from {wrong-type output, non-JSON text without
 * output, OUTPUT_INVALID throw}. Path B (cross-check): the real engine with the REAL `agentRunner` over
 * a real `Runtime` whose exec adapter is simulated (wrong-type output or non-JSON text), so the
 * Agent's own schema validation and the runner's salvage run unchanged.
 *
 * Usage: node scripts/simulation/workflows/schema-retries.mjs [--seed 1] [--trials 20000] [--crossTrials 4000]
 */
import { emit, hypothesis, judgeProportion, rng, sdk } from '../lib/sim.mjs';
import { flags } from './lib-twin.mjs';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer', 'score'], properties: { answer: { type: 'string' }, score: { type: 'integer' } } };
const PS = [0.05, 0.1, 0.2, 0.3];
const BATCH = 100;
const META = { name: 'w4', description: 'Structured calls.' };

/** Token model: input grows with the prompt (the retry feedback included); output log-normal. */
function tokens(r, prompt) {
  return { inputTokens: 400 + Math.ceil(prompt.length / 4), outputTokens: Math.max(1, Math.round(r.lognormal(150, 600))), costMeaning: 'estimate' };
}

async function pathA(dynamic, r, p, calls, limits = { maxAgents: 1000, concurrency: 16, initialConcurrency: 16 }) {
  const RunnerError = dynamic.DynamicRunnerError;
  const stats = { calls: 0, valid: 0, attempts: 0, firstAttemptTokens: 0, tokens: 0, codes: {} };
  const runner = {
    async run(request) {
      stats.attempts++;
      const usage = tokens(r, request.prompt);
      const spent = usage.inputTokens + usage.outputTokens;
      stats.tokens += spent;
      if (!request.prompt.includes('[Structured output check]')) stats.firstAttemptTokens += spent;
      if (r.next() < p) {
        const kind = r.int(0, 2);
        if (kind === 0) return { text: '{"answer":5}', output: { answer: 5 }, usage };
        if (kind === 1) return { text: 'Sure! Here is the answer: forty-two', usage };
        throw new RunnerError('OUTPUT_INVALID', { usage });
      }
      return { text: '', output: { answer: 'ok', score: 1 }, usage };
    },
  };
  for (let done = 0, run = 0; done < calls; run++) {
    const n = Math.min(BATCH, calls - done);
    const report = await dynamic.runWorkflowScript(META, async ctx => {
      await ctx.parallel(Array.from({ length: n }, (_, i) => () => ctx.agentResult(`Score item ${run}-${i}.`, { schema: SCHEMA })));
      return null;
    }, { runId: `w4-${run}`, runner, limits });
    for (const agent of report.agents) {
      stats.calls++;
      if (agent.status === 'completed') stats.valid++;
      else stats.codes[agent.error?.code ?? 'none'] = (stats.codes[agent.error?.code ?? 'none'] ?? 0) + 1;
    }
    done += n;
  }
  return stats;
}

async function pathB(dynamic, Runtime, r, p, calls) {
  const stats = { calls: 0, valid: 0, attempts: 0, codes: {} };
  const exec = {
    id: 'claude',
    async detect() { return { installed: true, path: '/bin/claude', version: '1.0.0' }; },
    async auth() { return { authenticated: true, source: 'subscription' }; },
    async models() { return []; },
    async execute(request) {
      stats.attempts++;
      const usage = { ...tokens(r, request.prompt), costMeaning: 'provider-reported' };
      let text, output;
      if (r.next() < p) {
        if (r.bernoulli(0.5)) { output = { answer: 5 }; text = JSON.stringify(output); } else text = 'Sure! forty-two';
      } else { output = { answer: 'ok', score: 1 }; text = JSON.stringify(output); }
      return { completed: true, failed: false, refused: false, sessionId: 's', text, ...(output ? { output } : {}), usage, events: [{ type: 'message.completed', text }], nativeEvents: [] };
    },
    async *stream(request) { yield { kind: 'result', result: await this.execute(request) }; },
  };
  const runner = dynamic.agentRunner({ agent: { model: 'opus-5' }, runtime: new Runtime({ adapters: [exec] }) });
  for (let done = 0, run = 0; done < calls; run++) {
    const n = Math.min(BATCH, calls - done);
    const report = await dynamic.runWorkflowScript(META, async ctx => {
      await ctx.parallel(Array.from({ length: n }, (_, i) => () => ctx.agentResult(`Score item ${run}-${i}.`, { schema: SCHEMA })));
      return null;
    }, { runId: `w4b-${run}`, runner, limits: { maxAgents: 1000, concurrency: 16, initialConcurrency: 16 } });
    for (const agent of report.agents) {
      stats.calls++;
      if (agent.status === 'completed') stats.valid++;
      else stats.codes[agent.error?.code ?? 'none'] = (stats.codes[agent.error?.code ?? 'none'] ?? 0) + 1;
    }
    done += n;
  }
  return stats;
}

async function main() {
  const h = hypothesis('W4');
  const opts = flags({ seed: 1, trials: 20_000, crossTrials: 4_000 });
  const dynamic = await sdk('orchestration/dynamic');
  const { Runtime } = await sdk('index');
  const started = Date.now();
  const rows = [];
  let verdict;
  for (const p of PS) {
    const a = await pathA(dynamic, rng(opts.seed * 31 + Math.round(p * 100)), p, opts.trials);
    const b = await pathB(dynamic, Runtime, rng(opts.seed * 37 + Math.round(p * 100)), p, opts.crossTrials);
    const judged = judgeProportion(a.valid, a.calls, h.bound, h.direction);
    if (p === 0.2) verdict = judged;
    rows.push({
      p, calls: a.calls, valid: a.valid, rate: judged.rate, ci95: judged.ci95, expectedClosedForm: 1 - p ** 3,
      failureCodes: a.codes, attemptsPerCall: +(a.attempts / a.calls).toFixed(4),
      tokensPerCall: +(a.tokens / a.calls).toFixed(1), firstAttemptTokensPerCall: +(a.firstAttemptTokens / a.calls).toFixed(1),
      retryTokenOverhead: +(a.tokens / a.firstAttemptTokens - 1).toFixed(4),
      crossCheckBundledRunner: {
        calls: b.calls, valid: b.valid, rate: +(b.valid / b.calls).toFixed(5), attemptsPerCall: +(b.attempts / b.calls).toFixed(4),
        failureCodes: b.codes, agreesWithin95: Math.abs(b.valid / b.calls - judged.rate) <= 1.96 * Math.sqrt(judged.rate * (1 - judged.rate) * (1 / b.calls + 1 / a.calls)) + 1e-9,
      },
    });
  }
  // Information: retries no longer draw on maxAgents (it counts calls). 40 structured calls at p=0.2 under the
  // default limits (maxAgents 50): before, 1.9% of the calls were lost to LIMIT; now none should be.
  const info = { runs: 300, calls: 0, limitFailures: 0, runsWithLimitFailure: 0 };
  for (let i = 0; i < info.runs; i++) {
    const s = await pathA(dynamic, rng(opts.seed * 41 + i), 0.2, 40, {});
    info.calls += s.calls;
    info.limitFailures += s.codes.LIMIT ?? 0;
    if (s.codes.LIMIT) info.runsWithLimitFailure++;
  }
  emit('workflows/schema-retries', [{
    id: 'W4', claim: h.claim, ...verdict,
    where: 'engine: agent-call.ts attempts() (re-ask with schema errors, schemaRetries default 2, each retry checks budget; maxAgents counts the call once); bundled agentRunner salvages rejected JSON output (STRUCTURED_OUTPUT_ERROR) and maps missing/non-JSON output to OUTPUT_INVALID so the engine re-asks',
    byP: rows,
    retriesVersusDefaultMaxAgents: info,
    assumptions: {
      failures: 'independent per attempt with probability p; kind uniform over wrong-type output / non-JSON text / OUTPUT_INVALID throw (path B: wrong-type output or non-JSON text through the real Agent)',
      tokens: 'input 400 + prompt chars/4 (retry feedback grows the prompt), output log-normal median 150 p95 600',
      limits: 'maxAgents 1000, concurrency 16 (initialConcurrency 16: the window starts at the ceiling and never moves, no rate limits here), schemaRetries default (2), except the maxAgents information row (all defaults)',
      sampleSize: '20000 calls per p chosen before running: at the closed-form 0.992 the 95% Wilson interval needs about 8000 calls to clear 0.99',
    },
    crossCheck: 'path B (real agentRunner + Agent schema validation over a simulated exec adapter) vs path A, per p',
  }], { seed: opts.seed, wallMs: Date.now() - started });
}

await main();
