import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, SessionRef, Turn } from '../../src/public/types.js';
import { ObservedTaskError, runObservedTask } from '../../src/orchestration/tasks/index.js';

const ref = { schemaVersion: 1, provider: 'codex', id: 'early-session' } as SessionRef;
const turn = { status: 'completed', text: 'done', session: ref } as Turn;
const done: AgentEvent = { type: 'turn.completed', turn };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe('observed task', () => {
  it('starts an admitted unbudgeted sibling before later synchronous refusal and drains its work', async () => {
    const finish = deferred(); let active = false, ended = false;
    let interrupt!: () => Promise<{ requested: boolean }>;
    const running = runObservedTask({ async *stream() {
      active = true; await finish.promise; ended = true; throw new Error('provider stopped'); yield done;
    } }, 'first', {}, { onHandle: handle => { interrupt = handle.interrupt; } });
    const rejected = expect(running).rejects.toThrow('provider stopped');
    const denial = new Error('denied');
    await expect(runObservedTask({ async *stream() { yield done; } }, 'second', {}, { onHandle() {
      expect(active).toBe(true); throw denial;
    } })).rejects.toBe(denial);
    await interrupt(); expect(ended).toBe(false); finish.resolve(); await rejected; expect(ended).toBe(true);
  });

  it('announces session and progress before completion and forwards starter options', async () => {
    const seen: string[] = [];
    const starter = { async *stream(input: string, options: { timeoutMs?: number }) {
      expect(input).toBe('prompt'); expect(options.timeoutMs).toBe(123);
      yield { type: 'session.started', session: ref } as AgentEvent;
      expect(seen).toEqual(['early-session']);
      yield { type: 'provider.event', provider: 'codex', event: {} } as AgentEvent;
      yield done;
    } };
    await expect(runObservedTask(starter, 'prompt', { timeoutMs: 123 }, {
      onSession: session => { seen.push(session.id); }, onProgress: kind => { seen.push(kind); },
    })).resolves.toBe(turn);
    expect(seen).toEqual(['early-session', 'provider']);
  });

  it('preserves the provider error on operator cancellation and drains before releasing budget', async () => {
    const started = deferred(), finish = deferred();
    const providerError = new Error('provider cancelled');
    const released = vi.fn();
    let interrupt!: () => Promise<{ requested: boolean }>;
    let signal!: AbortSignal;
    const running = runObservedTask({ async *stream(_input: string, options) {
      signal = options.signal!; started.resolve();
      await finish.promise;
      throw providerError;
      yield done;
    } }, 'prompt', {}, {
      budget: { acquire: () => ({ release: released }) },
      onHandle: handle => { interrupt = handle.interrupt; },
    });
    const rejected = expect(running).rejects.toBe(providerError);
    await started.promise; await interrupt();
    expect(signal.aborted).toBe(true); expect(released).not.toHaveBeenCalled();
    finish.resolve(); await rejected;
    expect(released).toHaveBeenCalledOnce();
  });

  it('rearms idle time on every event and types only its own idle failure', async () => {
    vi.useFakeTimers();
    const pulse = deferred();
    let signal!: AbortSignal;
    const running = runObservedTask({ async *stream(_input: string, options) {
      signal = options.signal!;
      await pulse.promise;
      yield { type: 'provider.event', provider: 'codex', event: {} } as AgentEvent;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('provider aborted');
    } }, 'prompt', {}, { idleTimeoutMs: 100 });
    const rejected = expect(running).rejects.toMatchObject({ code: 'IDLE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(99); expect(signal.aborted).toBe(false);
    pulse.resolve(); await vi.advanceTimersByTimeAsync(99); expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('suspends idle time during human interaction and rearms after the response', async () => {
    vi.useFakeTimers();
    const answer = deferred();
    let signal!: AbortSignal;
    const running = runObservedTask({ async *stream(_input: string, options) {
      signal = options.signal!;
      await options.onInteraction!({} as never);
      yield done;
    } }, 'prompt', { onInteraction: async () => { await answer.promise; return { kind: 'approval', decision: 'approve' }; } }, { idleTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(100); expect(signal.aborted).toBe(false);
    answer.resolve(); await expect(running).resolves.toBe(turn);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a pre-aborted task before admission or provider launch', async () => {
    const stream = vi.fn(), acquire = vi.fn();
    const signal = AbortSignal.abort();
    await expect(runObservedTask({ stream }, 'prompt', { signal }, { budget: { acquire } }))
      .rejects.toBeInstanceOf(ObservedTaskError);
    expect(acquire).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  });

  it('cleans up a refused onHandle admission and types a missing result', async () => {
    vi.useFakeTimers();
    const admissionError = new Error('no spending');
    const stream = vi.fn();
    await expect(runObservedTask({ stream }, 'prompt', {}, { onHandle() { throw admissionError; } }))
      .rejects.toBe(admissionError);
    await expect(runObservedTask({ async *stream() {} }, 'prompt', {}, { idleTimeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'MISSING_RESULT' });
    expect(stream).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the reservation until an interaction callback settles even if the provider finishes first', async () => {
    const entered = deferred(), answer = deferred();
    const release = vi.fn();
    const running = runObservedTask({ async *stream(_input: string, options) {
      void options.onInteraction!({} as never);
      yield done;
    } }, 'prompt', { onInteraction: async () => { entered.resolve(); await answer.promise; return { kind: 'approval', decision: 'approve' }; } }, {
      budget: { acquire: () => ({ release }) },
    });
    await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(release).not.toHaveBeenCalled();
    answer.resolve(); await expect(running).resolves.toBe(turn);
    expect(release).toHaveBeenCalledOnce();
  });

  it('cleans up its original parent signal even if the caller mutates options during the turn', async () => {
    const parent = new AbortController(), finish = deferred(), started = deferred();
    const options = { signal: parent.signal };
    const running = runObservedTask({ async *stream() { started.resolve(); await finish.promise; yield done; } }, 'prompt', options);
    await started.promise;
    options.signal = new AbortController().signal;
    finish.resolve(); await running;
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  });

  it('rejects detach semantics before a reservation or turn can start', async () => {
    const stream = vi.fn(), acquire = vi.fn();
    await expect(runObservedTask({ stream }, 'prompt', { signalBehavior: 'detach' }, { budget: { acquire } }))
      .rejects.toThrow(/detach/i);
    expect(stream).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
  });

  it('retains the original provider error when releasing the launch reservation also fails', async () => {
    const providerError = new Error('provider failed'), releaseError = new Error('budget store offline');
    const running = runObservedTask({ async *stream() { throw providerError; yield done; } }, 'prompt', {}, {
      budget: { acquire: () => ({ release() { throw releaseError; } }) },
    });
    await expect(running).rejects.toSatisfy((error: unknown) => error instanceof AggregateError
      && error.errors[0] === providerError && error.errors[1] === releaseError);
  });
});
