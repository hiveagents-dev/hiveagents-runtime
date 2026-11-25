import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { resolveDynamicLimits } from '../../src/orchestration/dynamic/limits.js';
import { DynamicPlanError } from '../../src/orchestration/dynamic/plan-error.js';
import {
  DYNAMIC_PLAN_JSON_SCHEMA, checkPlanArgs, estimatePlan, planLimits, planWaves, validatePlan,
} from '../../src/orchestration/dynamic/plan.js';
import type { DynamicLimits } from '../../src/orchestration/dynamic/types.js';

type Json = Record<string, unknown>;
const agent = (id: string, prompt = 'Do the work.', extra: Json = {}): Json => ({ kind: 'agent', id, prompt, ...extra });
const map = (id: string, over: string, prompt = 'Review {{item}}.', extra: Json = {}): Json => ({ kind: 'map', id, over, prompt, ...extra });
const plan = (steps: Json[], extra: Json = {}, meta: Json = {}): Json => ({
  format: 1, meta: { name: 'Review', description: 'Review the change.', ...meta }, steps, ...extra,
});
const LIST = { type: 'array', items: { type: 'string' } };

function issues(value: unknown, limits?: DynamicLimits): string[] {
  try {
    validatePlan(value, limits);
  } catch (error) {
    if (!(error instanceof DynamicPlanError)) throw error;
    return error.issues.map(issue => `${issue.code} ${issue.path}`);
  }
  return [];
}

describe('validatePlan', () => {
  it('accepts a valid plan and returns a frozen copy holding only the known keys', () => {
    const input = plan([agent('find', 'List the files.', { schema: LIST, phase: 'Find' }), map('review', 'steps.find', 'Review {{item}}.', { phase: 'Review', maxItems: 10 })],
      { result: 'review' }, { phases: [{ title: 'Find' }, { title: 'Review', detail: 'One agent per file.' }] });
    const validated = validatePlan(input);
    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(Object.isFrozen(validated) && Object.isFrozen(validated.steps[0])).toBe(true);
  });

  it('refuses anything that is not plain JSON', () => {
    const cyclic: Json = plan([agent('a')]);
    cyclic.self = cyclic;
    for (const value of [cyclic, plan([agent('a', 'x', { timeoutMs: Number.NaN })]), { get format() { return 1; } }, () => 1]) {
      expect(issues(value)).toEqual(['NOT_JSON $']);
    }
  });

  it('closes every object: an unknown key anywhere is an error', () => {
    expect(issues({ ...plan([agent('a')]), extra: 1 })).toEqual(['UNKNOWN_KEY $.extra']);
    expect(issues(plan([agent('a')], {}, { whenToUse: 'x' }))).toEqual(['UNKNOWN_KEY $.meta.whenToUse']);
    expect(issues(plan([agent('a', 'x', { phase: 'P' })], {}, { phases: [{ title: 'P', model: 'x' }] }))).toEqual(['UNKNOWN_KEY $.meta.phases[0].model']);
    expect(issues(plan([agent('a', 'x', { over: 'args.list' })]))).toEqual(['UNKNOWN_KEY $.steps[0].over']);
    expect(issues(plan([agent('a', 'x', { maxItems: 3 })]))).toEqual(['UNKNOWN_KEY $.steps[0].maxItems']);
    expect(issues(plan([map('a', 'args.list', 'x', { label: 'A' })]))).toEqual(['UNKNOWN_KEY $.steps[0].label']);
    // A non-plain prototype is not JSON; an own "__proto__" key is an unknown key.
    expect(issues(plan([{ ...agent('a'), __proto__: { kind: 'map' } }]))).toEqual(['NOT_JSON $']);
    expect(issues(JSON.parse('{"format":1,"meta":{"name":"n","description":"d"},"steps":[{"kind":"agent","id":"a","prompt":"x","__proto__":{}}]}')))
      .toEqual(['UNKNOWN_KEY $.steps[0].__proto__']);
    expect(issues([])).toEqual(['SHAPE $']);
    expect(issues(plan(['step' as never]))).toEqual(['SHAPE $.steps[0]']);
  });

  it('checks format, required keys and bounded labels', () => {
    expect(issues({ ...plan([agent('a')]), format: 2 })).toEqual(['FORMAT $.format']);
    expect(issues({ format: 1, steps: [agent('a')] })).toEqual(['MISSING $.meta']);
    expect(issues({ format: 1, meta: { name: 'n' } })).toEqual(['MISSING $.steps', 'MISSING $.meta.description']);
    expect(issues(plan([agent('a')], {}, { name: '  ' }))).toEqual(['LABEL $.meta.name']);
    expect(issues(plan([agent('a')], {}, { name: 'two\nlines' }))).toEqual(['LABEL $.meta.name']);
    expect(issues(plan([agent('a')], {}, { name: 'x'.repeat(129) }))).toEqual(['LABEL $.meta.name']);
    expect(issues(plan([agent('a')], {}, { description: 'bell \u0007' }))).toEqual(['LABEL $.meta.description']);
    expect(issues(plan([agent('a')], {}, { description: 'line one\nline two\tok' }))).toEqual([]);
  });

  it('checks phases: unique titles, at most 32, and every step in a declared phase', () => {
    const phases = (...titles: string[]) => ({ phases: titles.map(title => ({ title })) });
    expect(issues(plan([agent('a', 'x', { phase: 'P' })], {}, phases('P', 'P')))).toEqual(['DUPLICATE $.meta.phases[1].title']);
    expect(issues(plan([agent('a', 'x', { phase: 'P0' })], {}, phases(...Array.from({ length: 33 }, (_, i) => `P${i}`))))).toEqual(['PHASE $.meta.phases']);
    expect(issues(plan([agent('a')], {}, { phases: [] }))).toEqual(['PHASE $.meta.phases']);
    expect(issues(plan([agent('a')], {}, phases('P')))).toEqual(['PHASE $.steps[0].phase']);
    expect(issues(plan([agent('a', 'x', { phase: 'Q' })], {}, phases('P')))).toEqual(['PHASE $.steps[0].phase']);
    expect(issues(plan([agent('a', 'x', { phase: 'P' })]))).toEqual(['PHASE $.steps[0].phase']);
  });

  it('checks the step list, ids, kinds and prompts', () => {
    expect(issues(plan([]))).toEqual(['LIMIT $.steps']);
    expect(issues(plan(Array.from({ length: 257 }, (_, i) => agent(`s${i}`))))).toEqual(['LIMIT $.steps']);
    for (const id of ['A', '1a', '-a', 'a.b', 'a'.repeat(65), 7]) expect(issues(plan([agent(id as string)])), String(id)).toEqual(['ID $.steps[0].id']);
    expect(issues(plan([agent('a'), agent('a')]))).toEqual(['DUPLICATE $.steps[1].id']);
    expect(issues(plan([{ kind: 'loop', id: 'a', prompt: 'x' }]))).toEqual(['TYPE $.steps[0].kind']);
    expect(issues(plan([map('a', 'args.list')].map(({ over: _over, ...step }) => step)))).toEqual(['MISSING $.steps[0].over']);
    expect(issues(plan([agent('a', '   ')]))).toEqual(['TYPE $.steps[0].prompt']);
    expect(issues(plan([agent('a', 'x'.repeat(32 * 1024 + 1))]))).toEqual(['LIMIT $.steps[0].prompt']);
    expect(issues(plan([agent('a', 'é'.repeat(16 * 1024 + 1))]))).toEqual(['LIMIT $.steps[0].prompt']);
    expect(issues(plan([agent('a', 'x'.repeat(32 * 1024))]))).toEqual([]);
  });

  it('accepts only the documented placeholders', () => {
    expect(issues(plan([agent('a', 'Use {{secrets.token}}')]))).toEqual(['TEMPLATE $.steps[0].prompt']);
    expect(issues(plan([agent('a', 'Unclosed {{args.x')]))).toEqual(['TEMPLATE $.steps[0].prompt']);
    expect(issues(plan([agent('a', 'Use {{item}} and {{index}}')]))).toEqual(['REFERENCE $.steps[0].prompt', 'REFERENCE $.steps[0].prompt']);
    expect(issues(plan([map('a', 'args.list', '{{item.path}} #{{index}} of {{args.repo}}')]))).toEqual([]);
  });

  it('resolves references to declared steps, in any order, and refuses cycles', () => {
    expect(issues(plan([agent('a', 'Use {{steps.ghost}}')]))).toEqual(['REFERENCE $.steps[0].prompt']);
    const forward = validatePlan(plan([agent('report', 'Summarise {{steps.scan}}'), agent('scan')]));
    expect(planWaves(forward).map(wave => wave.map(step => step.id))).toEqual([['scan'], ['report']]);
    const cycle = (() => { try { validatePlan(plan([agent('a', '{{steps.b}}'), agent('b', '{{steps.a}}')])); } catch (error) { return error as DynamicPlanError; } })();
    expect(cycle).toMatchObject({ code: 'CYCLE', path: '$.steps' });
    expect(cycle!.message).toContain('a -> b -> a');
    expect(issues(plan([agent('a', 'Again {{steps.a}}')]))).toEqual(['CYCLE $.steps']);
    expect(issues(plan([agent('a', '{{steps.b}}'), map('b', 'steps.a', '{{item}}')]))).toEqual(['REFERENCE $.steps[1].over', 'CYCLE $.steps']);
  });

  it('checks what a reference can read: text has no fields, and over needs an array', () => {
    expect(issues(plan([agent('a'), agent('b', '{{steps.a.findings}}')]))).toEqual(['REFERENCE $.steps[1].prompt']);
    expect(issues(plan([agent('a'), map('b', 'steps.a')]))).toEqual(['REFERENCE $.steps[1].over']);
    expect(issues(plan([agent('a', 'x', { schema: { type: 'object' } }), map('b', 'steps.a')]))).toEqual(['REFERENCE $.steps[1].over']);
    expect(issues(plan([agent('a', 'x', { schema: { type: 'object' } }), map('b', 'steps.a.items')]))).toEqual([]);
    expect(issues(plan([agent('a', 'x', { schema: LIST }), map('b', 'steps.a'), map('c', 'steps.b')]))).toEqual([]);
    for (const over of ['item', 'index', '{{args.list}}', 'args', 'steps.Bad', 'args.list.', 42]) {
      expect(issues(plan([map('a', over as string)])), String(over)).toEqual([typeof over === 'number' ? 'TYPE $.steps[0].over' : 'REFERENCE $.steps[0].over']);
    }
  });

  it('keeps permissions, models, timeouts and items within the limits', () => {
    expect(issues(plan([agent('a', 'x', { permissions: 'edit' })]))).toEqual(['PERMISSIONS $.steps[0].permissions']);
    expect(issues(plan([agent('a', 'x', { permissions: 'edit' })]), { permissions: 'edit' })).toEqual([]);
    expect(issues(plan([agent('a', 'x', { permissions: 'admin' })]), { permissions: 'edit' })).toEqual(['TYPE $.steps[0].permissions']);
    expect(issues(plan([agent('a', 'x', { model: 'opus-5' })]))).toEqual(['MODEL $.steps[0].model']);
    expect(issues(plan([agent('a', 'x', { model: 'opus-5' })]), { models: ['opus-5'] })).toEqual([]);
    expect(issues(plan([agent('a', 'x', { model: 'gpt-5' })]), { models: ['opus-5'] })).toEqual(['MODEL $.steps[0].model']);
    expect(issues(plan([agent('a', 'x', { isolation: 'docker' })]))).toEqual(['TYPE $.steps[0].isolation']);
    expect(issues(plan([agent('a', 'x', { isolation: 'worktree', effort: 'high' })]))).toEqual([]);
    expect(issues(plan([agent('a', 'x', { effort: 'HIGH; rm' })]))).toEqual(['TYPE $.steps[0].effort']);
    expect(issues(plan([agent('a', 'x', { timeoutMs: 15 * 60_000 + 1 })]))).toEqual(['LIMIT $.steps[0].timeoutMs']);
    expect(issues(plan([agent('a', 'x', { timeoutMs: 2000 })]), { agentTimeoutMs: 1000 })).toEqual(['LIMIT $.steps[0].timeoutMs']);
    expect(issues(plan([agent('a', 'x', { timeoutMs: 1.5 })]))).toEqual(['LIMIT $.steps[0].timeoutMs']);
    expect(issues(plan([map('a', 'args.list', 'x', { maxItems: 257 })]))).toEqual(['LIMIT $.steps[0].maxItems']);
    expect(issues(plan([map('a', 'args.list', 'x', { maxItems: 20 })]), { maxItems: 10 })).toEqual(['LIMIT $.steps[0].maxItems']);
    expect(issues(plan([map('a', 'args.list', 'x', { maxItems: 0 })]))).toEqual(['LIMIT $.steps[0].maxItems']);
    expect(issues(plan([agent('a'), agent('b'), agent('c')]), { maxAgents: 2 })).toEqual(['LIMIT $.steps']);
  });

  it('requires a bounded schema that compiles and describes an object, array, string or number', () => {
    for (const type of ['object', 'array', 'string', 'number', 'integer']) expect(issues(plan([agent('a', 'x', { schema: { type } })])), type).toEqual([]);
    expect(issues(plan([agent('a', 'x', { schema: [] })]))).toEqual(['SCHEMA $.steps[0].schema']);
    expect(issues(plan([agent('a', 'x', { schema: { type: 'boolean' } })]))).toEqual(['SCHEMA $.steps[0].schema.type']);
    expect(issues(plan([agent('a', 'x', { schema: { properties: {} } })]))).toEqual(['SCHEMA $.steps[0].schema.type']);
    expect(issues(plan([agent('a', 'x', { schema: { type: 'object', properties: { a: { type: 'strin' } } } })]))).toEqual(['SCHEMA $.steps[0].schema']);
    expect(issues(plan([agent('a', 'x', { schema: { type: 'object', bogusKeyword: 1 } })]))).toEqual(['SCHEMA $.steps[0].schema']);
    const huge = { type: 'object', description: 'x'.repeat(64 * 1024) };
    expect(issues(plan([agent('a', 'x', { schema: huge })]))).toEqual(['SCHEMA $.steps[0].schema']);
    // A plan schema may not name itself: plans use inline schemas, never registered ones.
    const withId = { $id: 'https://example.test/finding', type: 'object' };
    expect(issues(plan([agent('a', 'x', { schema: withId }), agent('b', 'y', { schema: withId })])))
      .toEqual(['SCHEMA $.steps[0].schema.$id', 'SCHEMA $.steps[1].schema.$id']);
  });

  it('checks that result names a step', () => {
    expect(issues(plan([agent('a')], { result: 'zzz' }))).toEqual(['RESULT $.result']);
    expect(issues(plan([agent('a')], { result: 3 }))).toEqual(['RESULT $.result']);
  });

  it('reports every issue at once; code and path are the first one', () => {
    try {
      validatePlan(plan([agent('A', '{{nope}}', { permissions: 'edit' })], { result: 'x' }, { name: '' }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DynamicPlanError);
      const planError = error as DynamicPlanError;
      expect(planError.issues.map(issue => issue.code)).toEqual(['LABEL', 'ID', 'TEMPLATE', 'PERMISSIONS', 'RESULT']);
      expect([planError.code, planError.path]).toEqual(['LABEL', '$.meta.name']);
      expect(planError.message).toMatch(/^\$\.meta\.name: .* \(and 4 more\)$/);
    }
  });

  it('refuses malformed limits as an application error', () => {
    expect(() => planLimits({ maxItems: 5000 })).toThrow(TypeError);
    expect(() => planLimits({ permissions: 'root' as never })).toThrow(TypeError);
    expect(() => planLimits({ models: [''] })).toThrow(TypeError);
    expect(planLimits()).toEqual({ maxAgents: 50, maxItems: 256, agentTimeoutMs: 900_000, permissions: 'analyze', models: [] });
  });

  it('refuses exactly the limits the engine refuses (resolveDynamicLimits)', () => {
    const cases: unknown[] = [
      { agentTimeoutMs: 2 * 24 * 60 * 60_000 }, { concurrency: 17 }, { schemaRetries: 6 }, { tokens: 0 },
      { models: ['a', 'a'] }, { unknown: 1 }, { maxAgents: 0 }, 'not-an-object',
    ];
    for (const limits of cases) {
      expect(() => resolveDynamicLimits(limits as DynamicLimits)).toThrow(TypeError);
      expect(() => planLimits(limits as DynamicLimits)).toThrow(TypeError);
      expect(() => validatePlan(plan([agent('a')]), limits as DynamicLimits)).toThrow(TypeError);
    }
    const day = 24 * 60 * 60_000;
    expect(planLimits({ agentTimeoutMs: day }).agentTimeoutMs).toBe(day);
    expect(issues(plan([agent('a', 'A.', { timeoutMs: day + 1 })]), { agentTimeoutMs: day })).toEqual(['LIMIT $.steps[0].timeoutMs']);
  });

  it('refuses regex-backed schema keywords anywhere in a plan schema (ReDoS over agent output)', () => {
    const redos = { type: 'string', pattern: '^(a+)+$' };
    expect(issues(plan([agent('a', 'A.', { schema: redos })]))).toEqual(['SCHEMA_PATTERN $.steps[0].schema.pattern']);
    const nested = {
      type: 'object',
      properties: {
        name: { type: 'string', format: 'email' },
        tags: { type: 'array', items: { anyOf: [{ type: 'string', pattern: 'x' }, { type: 'number' }] } },
        meta: { type: 'object', patternProperties: { '^a': { type: 'string' } }, propertyNames: { pattern: '^[a-z]+$' } },
      },
      $defs: { id: { type: 'string', pattern: '^[0-9]+$' } },
    };
    expect(issues(plan([agent('a', 'A.', { schema: nested })]))).toEqual([
      'SCHEMA_PATTERN $.steps[0].schema.properties.name.format',
      'SCHEMA_PATTERN $.steps[0].schema.properties.tags.items.anyOf[0].pattern',
      'SCHEMA_PATTERN $.steps[0].schema.properties.meta.patternProperties',
      'SCHEMA_PATTERN $.steps[0].schema.properties.meta.propertyNames.pattern',
      'SCHEMA_PATTERN $.steps[0].schema.$defs.id.pattern',
    ]);
    // Names and data are not keywords: a property called "pattern" and "format" in an enum are fine.
    const named = {
      type: 'object', required: ['pattern'],
      properties: { pattern: { type: 'string', enum: ['pattern', 'format'] }, format: { const: 'pattern' } },
    };
    expect(issues(plan([agent('a', 'A.', { schema: named })]))).toEqual([]);
    const guidance = JSON.stringify((DYNAMIC_PLAN_JSON_SCHEMA as { properties: Json }).properties.steps);
    expect(guidance).toContain('pattern, patternProperties and format are refused');
  });
});

describe('DYNAMIC_PLAN_JSON_SCHEMA', () => {
  it('compiles under strict ajv, accepts a valid plan and rejects unknown keys', () => {
    const validate = new Ajv({ allErrors: true, strict: true }).compile(DYNAMIC_PLAN_JSON_SCHEMA as Json);
    const valid = plan([agent('find', 'x', { schema: LIST }), map('review', 'steps.find', '{{item}}', { maxItems: 4 })], { result: 'review' });
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, extra: true })).toBe(false);
    expect(validate(plan([agent('a', 'x', { over: 'args.x' })]))).toBe(false);
    expect(Object.isFrozen(DYNAMIC_PLAN_JSON_SCHEMA)).toBe(true);
  });
});

describe('estimatePlan', () => {
  const phased = validatePlan(plan([
    agent('scan', 'x', { phase: 'Scan', schema: LIST }),
    map('per-file', 'args.files', '{{item}}', { phase: 'Review' }),
    map('per-finding', 'steps.scan', '{{item}}', { phase: 'Review', maxItems: 8 }),
    agent('report', '{{steps.per-file}} {{steps.per-finding}}', { phase: 'Report' }),
  ], {}, { phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Report' }] }));

  it('counts maps over args exactly and maps over outputs as unknown until run', () => {
    const estimate = estimatePlan(phased, { files: ['a', 'b', 'c'] });
    expect(estimate).toEqual({
      agents: 'unknown-until-run', minAgents: 5, maxAgents: 13, waves: 3,
      steps: [
        { id: 'scan', kind: 'agent', phase: 'Scan', agents: 1 },
        { id: 'per-file', kind: 'map', phase: 'Review', agents: 3 },
        { id: 'per-finding', kind: 'map', phase: 'Review', agents: 'unknown-until-run' },
        { id: 'report', kind: 'agent', phase: 'Report', agents: 1 },
      ],
      phases: [{ title: 'Scan', agents: 1 }, { title: 'Review', agents: 'unknown-until-run' }, { title: 'Report', agents: 1 }],
    });
    const exact = estimatePlan(validatePlan(plan([map('m', 'args.files'), agent('r', '{{steps.m}}')])), { files: [1, 2] });
    expect([exact.agents, exact.minAgents, exact.maxAgents, exact.phases]).toEqual([3, 3, 3, []]);
  });

  it('refuses args a map cannot run over, as the run would', () => {
    expect(() => estimatePlan(phased, { files: 'a.ts' })).toThrow(expect.objectContaining({ code: 'OVER_NOT_ARRAY', path: '$.steps[1].over' }));
    expect(() => estimatePlan(phased, {})).toThrow(expect.objectContaining({ code: 'OVER_NOT_ARRAY' }));
    expect(() => estimatePlan(phased, { files: [1, 2, 3] }, { maxItems: 2 })).toThrow(expect.objectContaining({ code: 'MAX_ITEMS' }));
  });

  it('checkPlanArgs finds a missing args value before anything runs', () => {
    const needsRepo = validatePlan(plan([agent('a', 'Clone {{args.repo.url}}')]));
    expect(() => checkPlanArgs(needsRepo, { repo: {} })).toThrow(expect.objectContaining({ code: 'MISSING_VALUE', path: '$.steps[0].prompt' }));
    expect(() => checkPlanArgs(needsRepo, { repo: { url: 'git@x' } })).not.toThrow();
  });
});
