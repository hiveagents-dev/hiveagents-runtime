import { describe, expect, it } from 'vitest';
import { dependencyWaves, DependencyCycleError } from '../../src/orchestration/workflow/graph.js';

describe('dependencyWaves', () => {
  it('orders peers after their dependencies and preserves input order and identity', () => {
    const tasks = [
      { id: 'publish', dependencies: ['join'], extra: 1 },
      { id: 'b', extra: 2 },
      { id: 'a', extra: 3 },
      { id: 'join', dependencies: ['a', 'b'], extra: 4 },
    ];
    const waves = dependencyWaves(tasks);
    expect(waves.map(wave => wave.map(task => task.id))).toEqual([['b', 'a'], ['join'], ['publish']]);
    expect(waves[0]?.[0]).toBe(tasks[1]);
  });

  it.each([
    [[{ id: 'a', dependencies: ['missing'] }], /unknown dependency/i],
    [[{ id: 'a' }, { id: 'a' }], /duplicate/i],
    [[{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['a'] }], /cycle/i],
    [[{ id: 'a', dependencies: ['a'] }], /cycle/i],
    [[{ id: '' }], /id/i],
  ])('rejects invalid graphs before any work can be scheduled', (tasks, error) => {
    expect(() => dependencyWaves(tasks)).toThrow(error);
  });

  it('exposes the actual cycle path for application error messages', () => {
    try {
      dependencyWaves([{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['c'] }, { id: 'c', dependencies: ['a'] }]);
      throw new Error('Expected a cycle');
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as DependencyCycleError).cycle).toEqual(['a', 'b', 'c', 'a']);
    }
  });

  it('handles an empty graph and a deep graph without recursive stack growth', () => {
    expect(dependencyWaves([])).toEqual([]);
    const tasks = Array.from({ length: 5000 }, (_, n) => ({
      id: String(n), ...(n ? { dependencies: [String(n - 1)] } : {}),
    }));
    expect(dependencyWaves(tasks)).toHaveLength(5000);
  });
});
