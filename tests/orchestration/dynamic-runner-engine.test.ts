// The bundled agentRunner under the engine: schema retries, failed-turn usage, reported runner codes,
// base permission safety fields and the shared effort shape.
import { describe, expect, it } from 'vitest';
import type { ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { ProviderUnavailableError } from '../../src/public/errors.js';
import { DynamicRunnerError, agentRunner } from '../../src/orchestration/dynamic/agent-runner.js';
import { createDynamicEngine, runWorkflowScript } from '../../src/orchestration/dynamic/engine.js';
import { DYNAMIC_EFFORT_PATTERN, DynamicSchemaCache } from '../../src/orchestration/dynamic/limits.js';
import type { DynamicAgentRequest, DynamicAgentRunner } from '../../src/orchestration/dynamic/types.js';
import { RecordingExec, success } from '../unit/memory.fixture.js';

const META = { name: 'Runner', description: 'Runner under the engine.' };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
const USAGE = { inputTokens: 100, outputTokens: 50, costMeaning: 'provider-reported' as const };

function runtimeAnswering(answer: (request: ExecTurnRequest, index: number) => Promise<ProtocolResult> | ProtocolResult = request => success(request.sessionId ?? 's1')) {
  const exec = new RecordingExec();
  let index = 0;
  exec.executeImpl = async request => answer(request, index++);
  return { exec, runtime: new Runtime({ adapters: [exec] }) };
}

const invalid = (usage = USAGE) => success('s', { text: '{"ok":"nope"}', output: { ok: 'nope' }, usage });
const valid = () => success('s', { text: '{"ok":true}', output: { ok: true }, usage: USAGE });

describe('agentRunner x engine: structured output retries', () => {
  it('re-asks a schema-invalid output with the schema errors, then completes', async () => {
    const { exec, runtime } = runtimeAnswering((_request, index) => (index === 0 ? invalid() : valid()));
    const report = await runWorkflowScript(META, async ctx => ctx.agent('Check.', { schema: SCHEMA }), {
      runId: 'schema-retry', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }),
    });
    expect(report.agents[0]?.error).toBeUndefined();
    expect(report.agents[0]?.status).toBe('completed');
    expect(report.result).toEqual({ ok: true });
    expect(exec.requests).toHaveLength(2);
    expect(exec.requests[1]!.prompt).toContain('[Structured output check]');
    expect(exec.requests[1]!.prompt).toContain('/ok must be boolean');
    expect(exec.requests[1]!.outputSchema).toEqual(SCHEMA);
    expect(report.spent).toBe(300);
  });

  it('fails SCHEMA once schemaRetries are exhausted, counting every attempt', async () => {
    const { exec, runtime } = runtimeAnswering(() => invalid());
    const report = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Answer.', { schema: SCHEMA }); return null; }, {
      runId: 'schema-exhausted', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }), limits: { schemaRetries: 2 },
    });
    expect({ attempts: exec.requests.length, code: report.agents[0]?.error?.code }).toEqual({ attempts: 3, code: 'SCHEMA' });
    expect(report.spent).toBe(450);
    expect(report.agents[0]?.usage?.inputTokens).toBe(300);
  });

  it('re-asks a missing structured output (the Agent rejects it, nothing to salvage)', async () => {
    const { exec, runtime } = runtimeAnswering((_request, index) => (index === 0
      ? success('s', { text: 'not json at all', usage: USAGE }) : valid()));
    const report = await runWorkflowScript(META, async ctx => ctx.agent('Check.', { schema: SCHEMA }), {
      runId: 'schema-missing', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }),
    });
    expect(report.result).toEqual({ ok: true });
    expect(exec.requests).toHaveLength(2);
    expect(exec.requests[1]!.prompt).toContain('the answer was missing or was not valid JSON');
    expect(report.spent).toBe(300);
  });

  it('treats a runner OUTPUT_INVALID throw as a schema failure eligible for retry', async () => {
    const prompts: string[] = [];
    const runner: DynamicAgentRunner = {
      async run(request: DynamicAgentRequest) {
        prompts.push(request.prompt);
        if (prompts.length === 1) throw new DynamicRunnerError('OUTPUT_INVALID', { usage: USAGE });
        return { text: '{"ok":true}', output: { ok: true }, usage: USAGE };
      },
    };
    const report = await runWorkflowScript(META, async ctx => ctx.agent('Check.', { schema: SCHEMA }), { runId: 'defence', runner });
    expect(report.result).toEqual({ ok: true });
    expect(prompts).toHaveLength(2);
    expect(report.spent).toBe(300);

    const always: DynamicAgentRunner = { run: async () => { throw new DynamicRunnerError('OUTPUT_INVALID'); } };
    const exhausted = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.', { schema: SCHEMA }); return null; }, {
      runId: 'defence-exhausted', runner: always, limits: { schemaRetries: 1 },
    });
    expect(exhausted.agents[0]?.error?.code).toBe('SCHEMA');
    // Without a schema there is nothing to re-ask: the runner's code is reported.
    const plain = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.'); return null; }, { runId: 'defence-plain', runner: always });
    expect(plain.agents[0]?.error?.code).toBe('OUTPUT_INVALID');
  });
});

describe('agentRunner x engine: failed turns spend budget', () => {
  it('counts rejected turns: tokens 1500 and 1000-token rejections stop the run after two turns', async () => {
    const usage = { inputTokens: 600, outputTokens: 400, costMeaning: 'provider-reported' as const };
    const { exec, runtime } = runtimeAnswering(() => invalid(usage));
    const report = await runWorkflowScript(META, async ctx => {
      for (let i = 0; i < 5; i++) await ctx.agentResult(`Answer ${i}.`, { schema: SCHEMA });
      return null;
    }, { runId: 'budget', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }), limits: { tokens: 1500, schemaRetries: 0 } });
    expect({ turns: exec.requests.length, spent: report.spent, status: report.status })
      .toEqual({ turns: 2, spent: 2000, status: 'budget-exhausted' });
  });

  it('counts a single schema-invalid attempt', async () => {
    const { runtime } = runtimeAnswering(() => invalid());
    const report = await runWorkflowScript(META, async ctx => ctx.agent('Check.', { schema: SCHEMA }), {
      runId: 'schema-usage', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }), limits: { schemaRetries: 0 },
    });
    expect(report.spent).toBe(150);
  });

  it('counts refusals and provider failures, keeping provider text out', async () => {
    const refused = runtimeAnswering(() => success('s', { completed: false, refused: true, text: 'no', usage: USAGE }));
    const first = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.'); return null; }, {
      runId: 'refused-usage', runner: agentRunner({ agent: { model: 'opus-5' }, runtime: refused.runtime }),
    });
    expect(first.spent).toBe(150);
    expect(first.agents[0]?.usage?.outputTokens).toBe(50);

    const secret = 'provider says: token sk-123 rejected';
    const failing = runtimeAnswering(() => { throw new ProviderUnavailableError({ retryable: true, observedUsage: USAGE }, secret); });
    const second = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.'); return null; }, {
      runId: 'failed-usage', runner: agentRunner({ agent: { model: 'opus-5' }, runtime: failing.runtime }),
    });
    expect(second.spent).toBe(150);
    expect(second.agents[0]?.error).toEqual({
      code: 'PROVIDER_FAILED', message: 'The agent run failed: The agent turn failed (PROVIDER_UNAVAILABLE)',
    });
    expect(JSON.stringify(second)).not.toContain('sk-123');
  });
});

describe('agentRunner x engine: runner codes in the report', () => {
  it("keeps the runner's closed code (REFUSED) in the agent record", async () => {
    const { runtime } = runtimeAnswering(() => success('s', { completed: false, refused: true, text: 'no' }));
    const report = await runWorkflowScript(META, async ctx => ctx.agent('Check.'), {
      runId: 'refused', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }),
    });
    expect(report.agents[0]?.error).toEqual({ code: 'REFUSED', message: 'The agent run failed: The provider refused the agent turn' });
  });

  it('reports MODEL_NOT_ALLOWED when limits.models lists a model the runner does not', async () => {
    const { exec, runtime } = runtimeAnswering();
    const options = { limits: { models: ['sonnet-5'] } };
    const strict = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.', { model: 'sonnet-5' }); return null; }, {
      runId: 'model', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }), ...options,
    });
    expect(strict.agents[0]?.error?.code).toBe('MODEL_NOT_ALLOWED');
    expect(exec.requests).toHaveLength(0);
    // Listed in both allowlists: it runs.
    const both = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.', { model: 'sonnet-5' }); return null; }, {
      runId: 'model-both', runner: agentRunner({ agent: { model: 'opus-5' }, runtime, models: ['sonnet-5'] }), ...options,
    });
    expect(both.agents[0]?.status).toBe('completed');
    expect(exec.requests.map(sent => sent.modelId)).toEqual(['claude-sonnet-5']);
  });

  it('rebuilds the message from the code (never a runner detail) and keeps AGENT_ERROR for foreign errors', async () => {
    const detailed: DynamicAgentRunner = {
      run: async () => { throw new DynamicRunnerError('UNSUPPORTED', { detail: 'secret provider text sk-999' }); },
    };
    const report = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.'); return null; }, { runId: 'detail', runner: detailed });
    expect(report.agents[0]?.error).toEqual({ code: 'UNSUPPORTED', message: 'The agent run failed: The provider cannot run this agent turn' });
    expect(JSON.stringify(report)).not.toContain('sk-999');

    const forged = new DynamicRunnerError('PROVIDER_FAILED');
    Object.defineProperty(forged, 'code', { value: 'sk-777 FORGED' });
    const foreign: DynamicAgentRunner = { run: async () => { throw forged; } };
    const other = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.'); return null; }, { runId: 'forged', runner: foreign });
    expect(other.agents[0]?.error?.code).toBe('AGENT_ERROR');
    expect(JSON.stringify(other)).not.toContain('sk-777');
  });
});

describe('agentRunner keeps the safety fields of its base permissions', () => {
  const request = (): DynamicAgentRequest => ({
    runId: 'run-1', key: 'k1', prompt: 'Review the file.', options: { permissions: 'analyze' }, signal: new AbortController().signal,
  });
  for (const permissions of [
    { mode: 'analyze' as const, network: 'deny' as const },
    { mode: 'analyze' as const, minimumEnforcement: 'sandbox' as const },
  ]) {
    it(`refuses like a plain Agent with ${JSON.stringify(permissions)}`, async () => {
      const direct = runtimeAnswering();
      const agent = new Agent({ model: 'opus-5', permissions }, direct.runtime);
      const directError = await agent.send('probe').then(() => undefined, (error: unknown) => error);
      await agent.close();
      expect(directError).toBeInstanceOf(Error);
      expect(direct.exec.requests).toHaveLength(0);

      const viaRunner = runtimeAnswering();
      const runner = agentRunner({ agent: { model: 'opus-5', permissions }, runtime: viaRunner.runtime, ceiling: 'edit' });
      const error = await runner.run(request()).then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(DynamicRunnerError);
      expect((error as DynamicRunnerError).runtimeCode).toBe((directError as { code?: string }).code);
      expect(viaRunner.exec.requests).toHaveLength(0);
      // Also for an 'edit' call: the mode changes, the requirement stays.
      await runner.run({ ...request(), options: { permissions: 'edit' } }).catch(() => undefined);
      expect(viaRunner.exec.requests).toHaveLength(0);
    });
  }
});

describe('one effort shape', () => {
  it('refuses up front, before any turn, an effort the bundled runner would refuse', async () => {
    const { exec, runtime } = runtimeAnswering();
    for (const effort of ['High Effort', '-x', 'a'.repeat(33), 'Low']) {
      const report = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.', { effort }); return null; }, {
        runId: 'effort', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }),
      });
      expect(report.status).toBe('failed');
      expect(report.error?.message).toContain('Agent effort must be a short lowercase word');
    }
    expect(exec.requests).toHaveLength(0);
    const ok = await runWorkflowScript(META, async ctx => { await ctx.agentResult('Check.', { effort: 'high' }); return null; }, {
      runId: 'effort-ok', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }),
    });
    expect(ok.agents[0]?.status).toBe('completed');
    expect(exec.requests.map(sent => sent.effort)).toEqual(['high']);
    expect(DYNAMIC_EFFORT_PATTERN.source).toBe('^[a-z][a-z0-9-]{0,31}$');
  });

  it('names the dialect it compiles (draft-07) in the schema error', () => {
    let message = '';
    try { new DynamicSchemaCache().compile({ type: 'object', unknownKeyword: 1 }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('draft-07');
    expect(message).not.toContain('2020-12');
  });
});

describe('agentRunner x engine: provider usage limits', () => {
  it('maps the SDK usage-limit rejection to RATE_LIMITED: the window is cut, the reset is honoured, the call retries', async () => {
    const retryAt = Date.now() + 20_000;
    const limited = (): ProtocolResult => ({
      completed: false, failed: true, refused: false, text: '', events: [], nativeEvents: [], usage: USAGE,
      failure: { kind: 'usage-limit', message: 'provider prose: you hit your limit (secret)', retryAt },
    });
    const { exec, runtime } = runtimeAnswering((_request, index) => (index === 0 ? limited() : success('s', { text: 'fine', usage: USAGE })));
    const waits: number[] = [];
    const events: string[] = [];
    const engine = createDynamicEngine({ clock: { now: () => Date.now(), sleep: async ms => { waits.push(ms); } } });
    const report = await engine(META, async ctx => ctx.agent('Check.'), {
      runId: 'usage-limit', runner: agentRunner({ agent: { model: 'opus-5' }, runtime }), limits: { initialConcurrency: 2 },
      onEvent: event => { if (event.type === 'concurrency.changed') events.push(`${event.previous}->${event.window}:${event.reason}`); },
    });
    expect(report.result).toBe('fine');
    expect(exec.requests).toHaveLength(2);
    expect(events).toEqual(['2->1:rate-limited', '1->2:recovered']);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(19_000);
    expect(report.spent).toBe(300);
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
