import { describe, expect, it } from 'vitest';

import { BoundedQueue } from '../../src/control/bounded-queue.js';
import { OutputLimitError } from '../../src/public/errors.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('BoundedQueue', () => {
  it.each([undefined, 2])('bounds waiting producers separately from accepted items (%s)', async maxPendingProducers => {
    const queue = new BoundedQueue<string>({ maxItems: 1, overflow: 'wait',
      ...(maxPendingProducers === undefined ? {} : { maxPendingProducers }) });
    await queue.enqueue('accepted');
    const pending = Array.from({ length: maxPendingProducers ?? 1 }, (_, i) => queue.enqueue(`waiting-${i}`));
    for (const work of pending) void work.catch(() => undefined);
    const excess = queue.enqueue('must-not-be-retained').then(() => ({ accepted: true }), error => ({ error }));
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      const outcome = await Promise.race([excess, Promise.resolve({ stillPending: true })]);
      expect(outcome).toMatchObject({ error: { code: 'OUTPUT_LIMIT' } });
      expect(queue.size).toBe(1);
      const iterator = queue[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toBe('accepted');
      for (let i = 0; i < pending.length; i++) {
        await pending[i]; expect((await iterator.next()).value).toBe(`waiting-${i}`);
      }
      queue.close(); expect((await iterator.next()).done).toBe(true);
    } finally {
      queue.fail(new Error('fixture cleanup'));
      await Promise.allSettled(pending); await excess;
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid waiting-producer bound %s', bound => {
    expect(() => new BoundedQueue({ overflow: 'wait', maxPendingProducers: bound })).toThrow(RangeError);
  });

  it('delivers values in order through async iteration', async () => {
    const queue = new BoundedQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.close();

    await expect(collect(queue)).resolves.toEqual([1, 2, 3]);
  });

  it('resolves a waiting consumer when a value arrives later', async () => {
    const queue = new BoundedQueue<string>();
    const pending = queue[Symbol.asyncIterator]().next();
    queue.push('late');

    await expect(pending).resolves.toEqual({ done: false, value: 'late' });
  });

  it('fails typed on item overflow under the fail policy', () => {
    const queue = new BoundedQueue<string>({ maxItems: 2 });
    queue.push('one');
    queue.push('two');

    expect(() => queue.push('three')).toThrow(OutputLimitError);
  });

  it('fails typed on byte overflow under the fail policy', () => {
    const queue = new BoundedQueue<string>({ maxBytes: 10 });
    queue.push('aaaa');

    expect(() => queue.push('bbbbbbbb')).toThrow(OutputLimitError);
  });

  it('rejects a single item larger than the byte cap even under the wait policy', async () => {
    const queue = new BoundedQueue<string>({ maxBytes: 8, overflow: 'wait' });

    await expect(queue.enqueue('x'.repeat(64))).rejects.toBeInstanceOf(OutputLimitError);
  });

  it('applies drain-wait backpressure to a producer that outruns a slow consumer', async () => {
    const maxItems = 8;
    const queue = new BoundedQueue<number>({ maxItems, overflow: 'wait' });
    let maxObservedSize = 0;

    const producer = (async () => {
      for (let index = 0; index < 100; index += 1) {
        await queue.enqueue(index);
        maxObservedSize = Math.max(maxObservedSize, queue.size);
      }
      queue.close();
    })();

    const consumed: number[] = [];
    for await (const value of queue) {
      consumed.push(value);
      if (consumed.length % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await producer;

    expect(consumed).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect(maxObservedSize).toBeLessThanOrEqual(maxItems);
  });

  it('keeps enqueue pending until the consumer drains capacity', async () => {
    const queue = new BoundedQueue<string>({ maxItems: 1, overflow: 'wait' });
    await queue.enqueue('first');

    let accepted = false;
    const blocked = queue.enqueue('second').then(() => {
      accepted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(accepted).toBe(false);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
    await blocked;
    expect(accepted).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'second' });
  });

  it('rejects producers blocked on capacity when the queue fails', async () => {
    const queue = new BoundedQueue<string>({ maxItems: 1, overflow: 'wait' });
    await queue.enqueue('first');
    const blocked = queue.enqueue('second');

    const failure = new Error('transport lost');
    queue.fail(failure);

    await expect(blocked).rejects.toBe(failure);
  });

  it('treats push after close as a no-op', () => {
    const queue = new BoundedQueue<string>();
    queue.close();

    expect(() => queue.push('ignored')).not.toThrow();
    expect(queue.size).toBe(0);
  });

  it('rethrows the failure to consumers', async () => {
    const queue = new BoundedQueue<string>();
    const failure = new Error('boom');
    queue.fail(failure);

    await expect(queue[Symbol.asyncIterator]().next()).rejects.toBe(failure);
  });

  it('releases byte accounting as values are consumed', async () => {
    const queue = new BoundedQueue<string>({ maxBytes: 12 });
    queue.push('aaaa');
    expect(queue.bufferedBytes).toBeGreaterThan(0);

    await queue[Symbol.asyncIterator]().next();
    expect(queue.bufferedBytes).toBe(0);
  });
});
