import { describe, expect, it } from 'vitest';
import { runWorkflowScript } from '../../src/orchestration/dynamic/engine.js';
import { DynamicPlanError, compilePlan, runWorkflowPlan } from '../../src/orchestration/dynamic/index.js';
import type { DynamicIsolation } from '../../src/orchestration/dynamic/types.js';
import { fakeRunner, meta } from './dynamic-engine-fixture.js';

type Json = Record<string, unknown>;
const plan = (steps: Json[], extra: Json = {}): Json => ({ format: 1, meta, steps, ...extra });
const LIST = { type: 'array', items: { type: 'string' } };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}

describe('runWorkflowPlan refuses before anything runs', () => {
  it("refuses a step asking isolation 'worktree' when the run has no isolation (never a silent no-op)", async () => {
    const fake = fakeRunner();
    const worktree = plan([
      { kind: 'agent', id: 'read', prompt: 'Read.' },
      { kind: 'agent', id: 'edit', prompt: 'Edit.', isolation: 'worktree' },
    ]);
    const error = await rejection(runWorkflowPlan(worktree, { runId: 'iso', runner: fake.runner }));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("$.steps[1].isolation: 'worktree' requires DynamicRunOptions.isolation");
    expect(fake.calls).toHaveLength(0);
    // With isolation configured the same plan runs.
    const isolation: DynamicIsolation = {
      create: async ({ key }) => ({ path: `/tmp/oar-never-${key.slice(0, 8)}`, branch: 'b' }),
      inspect: async () => ({ changed: false }),
    };
    const report = await runWorkflowPlan(worktree, { runId: 'iso-ok', runner: fake.runner, isolation });
    expect(report.status).toBe('completed');
    expect(report.agents).toHaveLength(2);
  });

  it('a compiled plan run without isolation fails visibly: the usage error is rethrown, not turned into null', async () => {
    const fake = fakeRunner();
    const { meta: compiledMeta, script } = compilePlan(plan([{ kind: 'map', id: 'edit', over: 'args.files', prompt: 'Edit {{item}}.', isolation: 'worktree' }]) as never);
    const report = await runWorkflowScript(compiledMeta, script, { runId: 'iso-script', runner: fake.runner, args: { files: ['a', 'b'] } });
    expect(report.status).toBe('failed');
    expect(report.error).toEqual({
      code: 'SCRIPT_ERROR', message: "The workflow script failed: Agent isolation 'worktree' requires DynamicRunOptions.isolation",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects with DynamicPlanError for args that do not fit the plan (its JSDoc)', async () => {
    const fake = fakeRunner();
    const over = plan([{ kind: 'map', id: 'review', over: 'args.files', prompt: 'Review {{item}}.' }]);
    const notArray = await rejection(runWorkflowPlan(over, { runId: 'args', runner: fake.runner, args: { files: 'not-an-array' } }));
    expect(notArray).toBeInstanceOf(DynamicPlanError);
    expect([(notArray as DynamicPlanError).code, (notArray as DynamicPlanError).path]).toEqual(['OVER_NOT_ARRAY', '$.steps[0].over']);
    const missing = await rejection(runWorkflowPlan(plan([{ kind: 'agent', id: 'a', prompt: 'Use {{args.topic}}.' }]), { runId: 'args-2', runner: fake.runner }));
    expect((missing as DynamicPlanError).code).toBe('MISSING_VALUE');
    const tooMany = await rejection(runWorkflowPlan(over, { runId: 'args-3', runner: fake.runner, args: { files: ['a', 'b', 'c'] }, limits: { maxItems: 2 } }));
    expect((tooMany as DynamicPlanError).code).toBe('MAX_ITEMS');
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects (never throws synchronously) for an invalid plan, malformed limits or non-JSON args', async () => {
    const fake = fakeRunner();
    const valid = plan([{ kind: 'agent', id: 'a', prompt: 'A.' }]);
    const invalid = runWorkflowPlan(plan([{ kind: 'agent', id: 'A', prompt: 'A.' }]), { runId: 'bad', runner: fake.runner });
    expect((await rejection(invalid) as DynamicPlanError).code).toBe('ID');
    expect(await rejection(runWorkflowPlan(valid, { runId: 'l', runner: fake.runner, limits: { agentTimeoutMs: 2 * 24 * 60 * 60_000 } }))).toBeInstanceOf(TypeError);
    expect(await rejection(runWorkflowPlan(valid, { runId: 'j', runner: fake.runner, args: { when: new Date() } as never }))).toBeInstanceOf(TypeError);
    expect(await rejection(runWorkflowPlan(valid, null as never))).toBeInstanceOf(TypeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('plan errors found mid-run are in the report', () => {
  it('a map over a failed step (null) reports PLAN_INVALID with OVER_NOT_ARRAY and its path', async () => {
    const fake = fakeRunner(request => {
      if (request.options.label === 'find') throw new Error('provider text that must never be reported');
      return { text: 'reviewed' };
    });
    const report = await runWorkflowPlan(plan([
      { kind: 'agent', id: 'find', prompt: 'List the files.', schema: LIST },
      { kind: 'map', id: 'review', over: 'steps.find', prompt: 'Review {{item}}.' },
    ]), { runId: 'mid-run', runner: fake.runner });
    expect(report.status).toBe('failed');
    expect(report.error).toEqual({
      code: 'PLAN_INVALID', message: 'The plan failed (OVER_NOT_ARRAY) at $.steps[1].over',
    });
    expect(JSON.stringify(report)).not.toContain('provider text');
    expect(report.agents.map(agent => [agent.label, agent.status])).toEqual([['find', 'failed']]);
  });
});
