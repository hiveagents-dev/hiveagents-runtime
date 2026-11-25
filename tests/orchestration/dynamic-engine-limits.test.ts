import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_LIMIT_BOUNDS, DynamicSchemaCache, resolveAgentOptions, resolveDynamicLimits, validateDynamicMeta,
} from '../../src/orchestration/dynamic/limits.js';

describe('dynamic workflow limits', () => {
  it('fills the documented defaults', () => {
    expect(resolveDynamicLimits(undefined)).toEqual({
      maxAgents: 50, concurrency: 8, initialConcurrency: 4, maxItems: 256, tokens: undefined, agentTimeoutMs: 15 * 60_000,
      permissions: 'analyze', models: [], schemaRetries: 2, rateLimitRetries: 3,
    });
  });

  it('starts the adaptive window at min(4, concurrency) unless initialConcurrency says otherwise', () => {
    expect(resolveDynamicLimits({ concurrency: 2 }).initialConcurrency).toBe(2);
    expect(resolveDynamicLimits({ concurrency: 16 }).initialConcurrency).toBe(4);
    expect(resolveDynamicLimits({ concurrency: 6, initialConcurrency: 6 }).initialConcurrency).toBe(6);
    expect(resolveDynamicLimits({ initialConcurrency: 1 }).initialConcurrency).toBe(1);
    expect(() => resolveDynamicLimits({ concurrency: 4, initialConcurrency: 5 })).toThrow(TypeError);
    expect(() => resolveDynamicLimits({ initialConcurrency: 9 })).toThrow(TypeError);
    expect(() => resolveDynamicLimits({ initialConcurrency: 0 })).toThrow(TypeError);
  });

  it('accepts the ceilings and refuses anything beyond them (never clamps)', () => {
    const ceilings = {
      maxAgents: DYNAMIC_LIMIT_BOUNDS.maxAgents.max, concurrency: 16, initialConcurrency: 16, maxItems: 4096, schemaRetries: 5,
      rateLimitRetries: 10, agentTimeoutMs: DYNAMIC_LIMIT_BOUNDS.agentTimeoutMs.max,
    };
    expect(resolveDynamicLimits(ceilings)).toMatchObject(ceilings);
    for (const [key, value] of Object.entries({
      maxAgents: 1001, concurrency: 17, maxItems: 4097, schemaRetries: 6, rateLimitRetries: 11, agentTimeoutMs: 0, tokens: 0,
    })) {
      expect(() => resolveDynamicLimits({ [key]: value }), key).toThrow(TypeError);
    }
    expect(() => resolveDynamicLimits({ concurrency: 1.5 })).toThrow(TypeError);
    expect(() => resolveDynamicLimits({ permissions: 'root' as never })).toThrow(TypeError);
    expect(() => resolveDynamicLimits({ models: ['a', 'a'] })).toThrow(TypeError);
    expect(() => resolveDynamicLimits({ unknown: 1 } as never)).toThrow(TypeError);
  });

  it('validates meta: labelled name, description and unique declared phases', () => {
    expect(validateDynamicMeta({ name: 'n', description: 'd', phases: [{ title: 'A', detail: 'x' }, { title: 'B' }] }))
      .toEqual({ name: 'n', description: 'd', phases: [{ title: 'A', detail: 'x' }, { title: 'B' }] });
    expect(() => validateDynamicMeta({ name: '', description: 'd' })).toThrow(TypeError);
    expect(() => validateDynamicMeta({ name: 'line\nbreak', description: 'd' })).toThrow(TypeError);
    expect(() => validateDynamicMeta({ name: 'n', description: '' })).toThrow(TypeError);
    expect(() => validateDynamicMeta({ name: 'n', description: 'd', phases: [{ title: 'A' }, { title: 'A' }] })).toThrow(TypeError);
    expect(() => validateDynamicMeta({ name: 'n', description: 'd', extra: 1 } as never)).toThrow(TypeError);
  });

  it('validates agent options against the run limits', () => {
    const scope = (overrides = {}) => ({
      limits: resolveDynamicLimits({ models: ['m1'], agentTimeoutMs: 1000, ...overrides }),
      phases: new Set(['Scan']), isolationConfigured: false, schemas: new DynamicSchemaCache(),
    });
    expect(resolveAgentOptions(undefined, scope())).toEqual({ permissions: 'analyze', isolation: 'none' });
    expect(resolveAgentOptions({ model: 'm1', phase: 'Scan', timeoutMs: 1000, effort: 'high' }, scope()))
      .toMatchObject({ model: 'm1', phase: 'Scan', timeoutMs: 1000, effort: 'high' });
    expect(resolveAgentOptions({ permissions: 'edit' }, scope({ permissions: 'edit' })).permissions).toBe('edit');
    for (const options of [
      { permissions: 'edit' }, { model: 'm2' }, { phase: 'Other' }, { timeoutMs: 1001 }, { isolation: 'worktree' },
      { schema: [] }, { schema: { type: 'nonsense' } }, { schema: { type: 'string', format: 'unknown-format' } }, { label: '' }, { other: 1 },
    ]) {
      expect(() => resolveAgentOptions(options as never, scope()), JSON.stringify(options)).toThrow(TypeError);
    }
  });
});
