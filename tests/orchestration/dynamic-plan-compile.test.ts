import { describe, expect, it } from 'vitest';
import { compilePlan } from '../../src/orchestration/dynamic/plan-compile.js';
import { DynamicPlanError } from '../../src/orchestration/dynamic/plan-error.js';
import type {
  DynamicAgentOptions, DynamicLimits, DynamicWorkflowContext, JsonValue,
} from '../../src/orchestration/dynamic/types.js';

type Json = Record<string, unknown>;
const agent = (id: string, prompt = 'Do the work.', extra: Json = {}): Json => ({ kind: 'agent', id, prompt, ...extra });
const map = (id: string, over: string, prompt = 'Review {{item}}.', extra: Json = {}): Json => ({ kind: 'map', id, over, prompt, ...extra });
const plan = (steps: Json[], extra: Json = {}, meta: Json = {}): Json => ({
  format: 1, meta: { name: 'Review', description: 'Review the change.', ...meta }, steps, ...extra,
});
const LIST = { type: 'array', items: { type: 'string' } };

interface Call { prompt: string; options: DynamicAgentOptions }
type Answer = (call: Call) => JsonValue | Error;

/** A context like the engine's: agent failures resolve to null, parallel turns rejections into null. */
function fakeContext(args: JsonValue, answer: Answer = call => `out:${call.options.label}`) {
  const calls: Call[] = [];
  const phases: string[] = [];
  const batches: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const controller = new AbortController();
  const context: DynamicWorkflowContext = {
    runId: 'run-1',
    args,
    async agent(prompt, options = {}) {
      calls.push({ prompt, options });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight -= 1;
      const value = answer({ prompt, options });
      if (value instanceof Error) throw value;
      return value;
    },
    agentResult: () => { throw new Error('not used by plans'); },
    async parallel(thunks) {
      const before = calls.length;
      const settled = Promise.all(thunks.map(thunk => thunk().catch(() => null)));
      batches.push(calls.slice(before).map(call => call.options.label ?? ''));
      return settled;
    },
    pipeline: () => { throw new Error('not used by plans'); },
    phase: title => { phases.push(title); },
    log: () => undefined,
    budget: { spent: () => 0, remaining: () => undefined },
    signal: controller.signal,
  };
  return { context, calls, phases, batches, controller, maxInFlight: () => maxInFlight };
}

async function rejection(promise: Promise<unknown>): Promise<DynamicPlanError> {
  try { await promise; } catch (error) { if (error instanceof DynamicPlanError) return error; throw error; }
  throw new Error('expected a DynamicPlanError');
}

describe('compilePlan', () => {
  it('validates the plan and returns its meta', () => {
    expect(() => compilePlan(plan([agent('A')]) as never)).toThrow(DynamicPlanError);
    expect(() => compilePlan(plan([agent('a', 'x', { permissions: 'edit' })]) as never)).toThrow(/ceiling/);
    expect(compilePlan(plan([agent('a', 'x', { permissions: 'edit' })]) as never, { permissions: 'edit' }).meta.name).toBe('Review');
  });

  it('runs independent steps concurrently in waves and feeds outputs forward as data blocks', async () => {
    const { script } = compilePlan(plan([
      agent('security', 'Audit for security.'), agent('style', 'Audit for style.'),
      agent('report', 'Merge:\n{{steps.security}}\n{{steps.style}}'),
    ]) as never);
    const fake = fakeContext(null);
    const result = await script(fake.context);
    expect(fake.batches).toEqual([['security', 'style'], ['report']]);
    expect(fake.maxInFlight()).toBe(2);
    expect(fake.calls[2]!.prompt).toContain('[data: steps.security]\n    out:security\n[data: steps.style]\n    out:style');
    expect(result).toBe('out:report');
  });

  it('maps over an args array, one labelled call per item, and returns the outputs in order', async () => {
    const { script } = compilePlan(plan([map('review', 'args.files', 'Review {{item}} ({{index}}) in {{args.repo}}.')]) as never);
    const fake = fakeContext({ repo: 'acme', files: ['a.ts', 'b.ts', 'c.ts'] }, call => `ok ${call.options.label}`);
    expect(await script(fake.context)).toEqual(['ok review[0]', 'ok review[1]', 'ok review[2]']);
    expect(fake.batches).toEqual([['review[0]', 'review[1]', 'review[2]']]);
    expect(fake.calls[1]!.prompt).toContain('[data: item]\n    b.ts');
    expect(fake.calls[1]!.prompt).toContain('[data: index]\n    1');
  });

  it('maps over a previous output, whole or by path', async () => {
    const { script } = compilePlan(plan([
      agent('find', 'Find files.', { schema: LIST }),
      agent('scan', 'Scan.', { schema: { type: 'object' } }),
      map('per-file', 'steps.find', 'File {{item}}'),
      map('per-issue', 'steps.scan.issues', 'Issue {{item.title}}'),
      agent('report', '{{steps.per-file}}\n{{steps.per-issue}}'),
    ]) as never);
    const fake = fakeContext(null, (call) => {
      if (call.options.label === 'find') return ['x.ts', 'y.ts'];
      if (call.options.label === 'scan') return { issues: [{ title: 'leak' }] };
      return call.options.label!;
    });
    await script(fake.context);
    expect(fake.batches).toEqual([['find', 'scan'], ['per-file[0]', 'per-file[1]', 'per-issue[0]'], ['report']]);
    expect(fake.calls.find(call => call.options.label === 'per-issue[0]')!.prompt).toContain('[data: item.title]\n    leak');
    expect(fake.calls.at(-1)!.prompt).toContain('[data: steps.per-file]\n    [\n      "per-file[0]",\n      "per-file[1]"\n    ]');
  });

  it('refuses more items than allowed before any call of the run (args) or of the wave (outputs)', async () => {
    const overArgs = compilePlan(plan([agent('first'), map('m', 'args.files', '{{item}}', { maxItems: 2 })]) as never);
    const fake = fakeContext({ files: [1, 2, 3] });
    expect(await rejection(overArgs.script(fake.context))).toMatchObject({ code: 'MAX_ITEMS', path: '$.steps[1].over' });
    expect(fake.calls).toEqual([]);

    const overOutput = compilePlan(plan([agent('find', 'x', { schema: LIST }), map('m', 'steps.find')]) as never, { maxItems: 2 });
    const second = fakeContext(null, call => (call.options.label === 'find' ? ['a', 'b', 'c'] : 'x'));
    expect(await rejection(overOutput.script(second.context))).toMatchObject({ code: 'MAX_ITEMS', path: '$.steps[1].over' });
    expect(second.calls.map(call => call.options.label)).toEqual(['find']);
  });

  it('refuses to map over something that is not an array, such as a failed step', async () => {
    const { script } = compilePlan(plan([agent('find', 'x', { schema: LIST }), map('m', 'steps.find')]) as never);
    const fake = fakeContext(null, call => (call.options.label === 'find' ? new Error('agent failed') : 'x'));
    const error = await rejection(script(fake.context));
    expect(error).toMatchObject({ code: 'OVER_NOT_ARRAY', path: '$.steps[1].over' });
    expect(error.message).toContain('null');
    expect(fake.calls).toHaveLength(1);
    const notArray = compilePlan(plan([map('m', 'args.files')]) as never);
    expect(await rejection(notArray.script(fakeContext({ files: 'a.ts' }).context))).toMatchObject({ code: 'OVER_NOT_ARRAY' });
  });

  it('keeps a failed agent as null in its slot and goes on', async () => {
    const { script } = compilePlan(plan([map('m', 'args.files', '{{item}}'), agent('sum', 'Sum {{steps.m}}')]) as never);
    const fake = fakeContext({ files: ['a', 'b', 'c'] }, call => (call.options.label === 'm[1]' ? new Error('boom') : call.options.label === 'sum' ? 'done' : 'ok'));
    expect(await script(fake.context)).toBe('done');
    expect(fake.calls[3]!.prompt).toContain('    [\n      "ok",\n      null,\n      "ok"\n    ]');
    const single = compilePlan(plan([agent('a'), agent('b', 'Use {{steps.a}}')], { result: 'a' }) as never);
    const failing = fakeContext(null, call => (call.options.label === 'a' ? new Error('boom') : 'b-out'));
    expect(await single.script(failing.context)).toBeNull();
    expect(failing.calls[1]!.prompt).toContain('[data: steps.a]\n    null');
  });

  it('returns the result step, by default the last one', async () => {
    const steps = [agent('a'), agent('b'), agent('c', '{{steps.a}}')];
    expect(await compilePlan(plan(steps) as never).script(fakeContext(null).context)).toBe('out:c');
    expect(await compilePlan(plan(steps, { result: 'b' }) as never).script(fakeContext(null).context)).toBe('out:b');
  });

  it('marks each new phase as its steps start and pins every call to its phase', async () => {
    const { script } = compilePlan(plan([
      agent('scan', 'x', { phase: 'Scan', schema: LIST }), map('fix', 'steps.scan', '{{item}}', { phase: 'Fix' }),
      agent('verify', '{{steps.fix}}', { phase: 'Fix' }), agent('report', '{{steps.verify}}', { phase: 'Report' }),
    ], {}, { phases: [{ title: 'Scan' }, { title: 'Fix' }, { title: 'Report' }] }) as never);
    const fake = fakeContext(null, call => (call.options.label === 'scan' ? ['one'] : 'ok'));
    await script(fake.context);
    expect(fake.phases).toEqual(['Scan', 'Fix', 'Report']);
    expect(fake.calls.map(call => [call.options.label, call.options.phase])).toEqual([
      ['scan', 'Scan'], ['fix[0]', 'Fix'], ['verify', 'Fix'], ['report', 'Report'],
    ]);
  });

  it('passes the step options through, and nothing else', async () => {
    const limits: DynamicLimits = { permissions: 'edit', models: ['opus-5'] };
    const options = { schema: { type: 'object' }, model: 'opus-5', effort: 'high', permissions: 'edit', isolation: 'worktree', timeoutMs: 1000 };
    const { script } = compilePlan(plan([agent('a', 'x', options)]) as never, limits);
    const fake = fakeContext(null, () => ({}));
    await script(fake.context);
    expect(fake.calls[0]!.options).toEqual({ label: 'a', ...options });
  });

  it('checks args before the first call and renders prompts before the calls of their wave', async () => {
    const { script } = compilePlan(plan([agent('a'), agent('b', 'Use {{args.missing}}')]) as never);
    const fake = fakeContext({});
    expect(await rejection(script(fake.context))).toMatchObject({ code: 'MISSING_VALUE', path: '$.steps[1].prompt' });
    expect(fake.calls).toEqual([]);

    const big = compilePlan(plan([agent('a'), agent('b', 'x'), agent('c', '{{steps.a}}')]) as never);
    const huge = fakeContext(null, call => (call.options.label === 'a' ? 'y'.repeat(300 * 1024) : 'ok'));
    expect(await rejection(big.script(huge.context))).toMatchObject({ code: 'PROMPT_TOO_LARGE', path: '$.steps[2].prompt' });
    expect(huge.calls.map(call => call.options.label)).toEqual(['a', 'b']);
  });

  it('slices a wave wider than maxItems into consecutive parallel calls', async () => {
    const { script } = compilePlan(plan([map('m', 'args.a'), map('n', 'args.b')]) as never, { maxItems: 2 });
    const fake = fakeContext({ a: [1, 2], b: [3] });
    expect(await script(fake.context)).toEqual(['out:n[0]']);
    expect(fake.batches).toEqual([['m[0]', 'm[1]'], ['n[0]']]);
  });

  it('is deterministic: same plan, args and outputs give the same calls in the same order', async () => {
    const input = plan([agent('find', 'x', { schema: LIST }), map('m', 'steps.find', '{{item}} of {{args.repo}}'), agent('r', '{{steps.m}}'), agent('s', 'other')]);
    const answer: Answer = call => (call.options.label === 'find' ? ['a', 'b'] : `v-${call.options.label}`);
    const runs = await Promise.all([1, 2].map(async () => {
      const fake = fakeContext({ repo: 'acme' }, answer);
      await compilePlan(input as never).script(fake.context);
      return fake.calls;
    }));
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]!.map(call => call.options.label)).toEqual(['find', 's', 'm[0]', 'm[1]', 'r']);
  });

  it('stops at an aborted signal', async () => {
    const { script } = compilePlan(plan([agent('a'), agent('b', '{{steps.a}}')]) as never);
    const fake = fakeContext(null);
    fake.controller.abort(new Error('stop'));
    await expect(script(fake.context)).rejects.toThrow('stop');
    expect(fake.calls).toEqual([]);
  });
});
