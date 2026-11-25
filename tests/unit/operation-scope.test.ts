import { describe, expect, it, vi } from 'vitest';
import { OperationScope } from '../../src/control/operation-scope.js';

describe('OperationScope', () => {
  it('aborts cooperative work on deadline and refuses a later step', async () => {
    const scope = new OperationScope({ timeoutMs: 15 });
    let stopped = false;
    await expect(scope.race(() => new Promise<void>((resolve) => {
      scope.signal.addEventListener('abort', () => { stopped = true; resolve(); });
    }))).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(stopped).toBe(true);
    const later = vi.fn();
    await expect(scope.race(later)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(later).not.toHaveBeenCalled();
    scope.dispose();
  });
  it('removes the parent listener after successful disposal', async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const scope = new OperationScope({ timeoutMs: 1000, signal: parent.signal });
    expect(await scope.race(() => 42)).toBe(42);
    scope.dispose();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('propagates parent cancellation and observes a late rejection', async () => {
    const parent = new AbortController();
    const scope = new OperationScope({ timeoutMs: 1000, signal: parent.signal });
    let reject!: (reason: Error) => void;
    const result = scope.race(() => new Promise((_, fail) => { reject = fail; }));
    await Promise.resolve();
    parent.abort();
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    reject(new Error('late'));
    await Promise.resolve();
    scope.dispose();
  });
  it('rejects invalid timer limits before invoking work', () => {
    for (const timeoutMs of [0, NaN, 1.1, 2 ** 31]) expect(() => new OperationScope({ timeoutMs })).toThrow(RangeError);
  });
});
