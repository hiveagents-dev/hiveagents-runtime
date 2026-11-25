import { describe, expect, it } from 'vitest';
import { DYNAMIC_RATE_LIMIT_BACKOFF, DynamicWindow, rateLimitDelay } from '../../src/orchestration/dynamic/concurrency.js';
import { createDynamicEngine } from '../../src/orchestration/dynamic/engine.js';
import { memoryDynamicJournal } from '../../src/orchestration/dynamic/journal.js';
import { DynamicRunnerError } from '../../src/orchestration/dynamic/runner-error.js';
import type { DynamicClock, DynamicWorkflowEvent } from '../../src/orchestration/dynamic/index.js';
import { fakeRunner, meta, recorder, usage } from './dynamic-engine-fixture.js';

/** A clock whose sleeps settle only when the test says so (or when their signal aborts). */
function manualClock(start = 1_000_000) {
  const waits: number[] = [];
  const pending: Array<() => void> = [];
  const clock: DynamicClock = {
    now: () => start,
    sleep(ms, signal) {
      waits.push(ms);
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        pending.push(resolve);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  return { clock, waits, pending, wake: () => { for (const resolve of pending.splice(0)) resolve(); } };
}

/** A clock whose sleeps settle at once, recording what was asked. */
function instantClock(now = 1_000_000) {
  const waits: number[] = [];
  const clock: DynamicClock = { now: () => now, sleep: async ms => { waits.push(ms); } };
  return { clock, waits };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 1));
const windows = (events: DynamicWorkflowEvent[]) => events.flatMap(event => (event.type === 'concurrency.changed'
  ? [{ previous: event.previous, window: event.window, reason: event.reason, ceiling: event.ceiling }] : []));

/** Rate-limits the first `times` attempts of every call (by key), then answers. */
function limitedFirst(times = 1, extra: { retryAt?: number } = {}) {
  const seen = new Map<string, number>();
  return fakeRunner(async request => {
    const count = seen.get(request.key) ?? 0;
    seen.set(request.key, count + 1);
    await tick();
    if (count < times) throw new DynamicRunnerError('RATE_LIMITED', { usage: usage(1, 0), ...extra });
    return { text: `done:${request.prompt}` };
  });
}

describe('dynamic workflow engine: adaptive concurrency', () => {
  it('cuts the window once per burst of rate limits and retries every call', async () => {
    const { clock, waits } = instantClock();
    const fake = limitedFirst();
    const events = recorder();
    const report = await createDynamicEngine({ clock })(meta, async context =>
      context.parallel(['a', 'b', 'c', 'd'].map(prompt => () => context.agent(prompt))),
    { runId: 'halve', runner: fake.runner, limits: { concurrency: 8 }, onEvent: events.onEvent });
    expect(report.status).toBe('completed');
    expect(report.result).toEqual(['done:a', 'done:b', 'done:c', 'done:d']);
    expect(fake.calls).toHaveLength(8);
    // Four rejections of calls launched under the same window are one congestion signal: 4 -> 3, once.
    expect(windows(events.events)[0]).toEqual({ previous: 4, window: 3, reason: 'rate-limited', ceiling: 8 });
    expect(windows(events.events).filter(change => change.reason === 'rate-limited')).toHaveLength(1);
    expect(waits).toHaveLength(4);
    const { baseMs } = DYNAMIC_RATE_LIMIT_BACKOFF;
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(baseMs / 2);
      expect(wait).toBeLessThan(baseMs);
    }
    // Every attempt's reported usage counts, the rejected ones included.
    expect(report.spent).toBe(4);
  });

  it('grows the window by one per answered call while it is full, never past the ceiling', async () => {
    const fake = fakeRunner(async request => { await tick(); return { text: request.prompt }; });
    const events = recorder();
    const report = await createDynamicEngine()(meta, async context =>
      context.parallel(Array.from({ length: 40 }, (_, i) => () => context.agent(`call ${i}`))),
    { runId: 'grow', runner: fake.runner, limits: { concurrency: 6, initialConcurrency: 2 }, onEvent: events.onEvent });
    expect(report.status).toBe('completed');
    expect(windows(events.events).map(change => change.window)).toEqual([3, 4, 5, 6]);
    expect(windows(events.events).every(change => change.reason === 'recovered')).toBe(true);
    expect(fake.peak).toBe(6);
  });

  it('shrinks to one and stays within the ceiling under sustained rate limits', async () => {
    const { clock } = instantClock();
    const fake = limitedFirst(2);
    const events = recorder();
    const report = await createDynamicEngine({ clock })(meta, async context =>
      context.parallel(Array.from({ length: 12 }, (_, i) => () => context.agent(`call ${i}`))),
    { runId: 'sustained', runner: fake.runner, limits: { concurrency: 4 }, onEvent: events.onEvent });
    expect(report.agents.every(agent => agent.status === 'completed')).toBe(true);
    expect(Math.min(...windows(events.events).map(change => change.window))).toBe(1);
    expect(Math.max(...windows(events.events).map(change => change.window))).toBeLessThanOrEqual(4);
    expect(fake.peak).toBeLessThanOrEqual(4);
  });

  it('does not hold a slot or the launch gate while a rate-limited call backs off', async () => {
    const manual = manualClock();
    let holds = 0;
    const launch = { acquire: async () => { holds++; return { release: () => { holds--; } }; } };
    const order: string[] = [];
    let first = true;
    const fake = fakeRunner(async request => {
      order.push(request.prompt);
      if (request.prompt === 'a' && first) { first = false; throw new DynamicRunnerError('RATE_LIMITED'); }
      return { text: request.prompt };
    });
    const run = createDynamicEngine({ launch, clock: manual.clock })(meta, async context =>
      context.parallel([() => context.agent('a'), () => context.agent('b')]),
    { runId: 'no-slot', runner: fake.runner, limits: { concurrency: 1 } });
    while (manual.pending.length === 0 || order.length < 2) await tick();
    // 'a' waits its backoff; 'b' got the only slot and finished meanwhile.
    expect(order).toEqual(['a', 'b']);
    expect(holds).toBe(0);
    manual.wake();
    const report = await run;
    expect(order).toEqual(['a', 'b', 'a']);
    expect(report.result).toEqual(['a', 'b']);
    expect(fake.peak).toBe(1);
    expect(holds).toBe(0);
  });

  it('settles promptly when the run aborts during a backoff', async () => {
    const manual = manualClock();
    const controller = new AbortController();
    const fake = fakeRunner(() => { throw new DynamicRunnerError('RATE_LIMITED'); });
    const run = createDynamicEngine({ clock: manual.clock })(meta, async context => { await context.agentResult('a'); return null; },
      { runId: 'abort-backoff', runner: fake.runner, signal: controller.signal });
    while (manual.pending.length === 0) await tick();
    controller.abort();
    const report = await run;
    expect(report.status).toBe('aborted');
    expect(report.agents[0]!.error?.code).toBe('ABORTED');
    expect(fake.calls).toHaveLength(1);
  });

  it('fails RATE_LIMITED once rateLimitRetries are spent, and a provider reset bounds the wait', async () => {
    const { clock, waits } = instantClock();
    const fake = fakeRunner(() => { throw new DynamicRunnerError('RATE_LIMITED'); });
    const report = await createDynamicEngine({ clock })(meta, async context => { await context.agentResult('a'); return null; },
      { runId: 'exhausted', runner: fake.runner, limits: { rateLimitRetries: 2 } });
    expect(fake.calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(report.agents[0]!.error).toEqual({
      code: 'RATE_LIMITED', message: 'The agent run failed: The provider rate-limited the agent turn; 3 rate-limited attempt(s)',
    });

    const now = 5_000_000;
    const soon = instantClock(now);
    const reset = limitedFirst(1, { retryAt: now + 30_000 });
    const waited = await createDynamicEngine({ clock: soon.clock })(meta, async context => context.agent('a'),
      { runId: 'reset-soon', runner: reset.runner });
    expect(waited.result).toBe('done:a');
    expect(soon.waits[0]).toBeGreaterThanOrEqual(30_000);
    expect(soon.waits[0]).toBeLessThan(30_000 + DYNAMIC_RATE_LIMIT_BACKOFF.baseMs);

    const late = instantClock(now);
    const far = limitedFirst(1, { retryAt: now + 60_000 });
    const refused = await createDynamicEngine({ clock: late.clock })(meta, async context => { await context.agentResult('a'); return null; },
      { runId: 'reset-late', runner: far.runner, limits: { agentTimeoutMs: 10_000 } });
    expect(late.waits).toEqual([]);
    expect(far.calls).toHaveLength(1);
    expect(refused.agents[0]!.error?.code).toBe('RATE_LIMITED');
    expect(refused.agents[0]!.error?.message).toContain('beyond the call');
  });

  it('keeps the call key across retries and replays a rate-limited-then-completed call on resume', async () => {
    const journal = memoryDynamicJournal();
    const { clock } = instantClock();
    const engine = createDynamicEngine({ clock });
    const script = async (context: Parameters<Parameters<typeof engine>[1]>[0]) => context.agent('a');
    const first = limitedFirst();
    const report = await engine(meta, script, { runId: 'resume', runner: first.runner, journal });
    expect(report.result).toBe('done:a');
    expect(new Set(first.calls.map(call => call.key)).size).toBe(1);
    expect(first.calls.map(call => call.prompt)).toEqual(['a', 'a']);

    const again = fakeRunner();
    const replay = await engine(meta, script, { runId: 'resume', runner: again.runner, journal });
    expect(again.calls).toHaveLength(0);
    expect(replay.result).toBe('done:a');
    expect(replay.agents[0]).toMatchObject({ key: first.calls[0]!.key, cached: true });

    // A call that ended RATE_LIMITED is not journaled: it runs again on resume under the same key.
    const failing = fakeRunner(() => { throw new DynamicRunnerError('RATE_LIMITED'); });
    const failed = await engine(meta, async context => { await context.agentResult('b'); return null; },
      { runId: 'resume-failed', runner: failing.runner, journal, limits: { rateLimitRetries: 0 } });
    expect(failed.agents[0]!.error?.code).toBe('RATE_LIMITED');
    const rerun = fakeRunner();
    const resumed = await engine(meta, async context => context.agent('b'), { runId: 'resume-failed', runner: rerun.runner, journal });
    expect(resumed.result).toBe('done:b');
    expect(rerun.calls[0]!.key).toBe(failing.calls[0]!.key);
  });

  it('counts calls, not attempts, against maxAgents (cached replays still count)', async () => {
    const { clock } = instantClock();
    const engine = createDynamicEngine({ clock });
    const fake = limitedFirst(2);
    const report = await engine(meta, async context => [await context.agent('a'), await context.agent('b'), await context.agent('c')],
      { runId: 'calls', runner: fake.runner, limits: { maxAgents: 2 } });
    expect(fake.calls).toHaveLength(6);
    expect(report.result).toEqual(['done:a', 'done:b', null]);
    expect(report.agents[2]!.error?.code).toBe('LIMIT');

    const journal = memoryDynamicJournal();
    await engine(meta, async context => context.agent('a'), { runId: 'cached', runner: fakeRunner().runner, journal });
    const replay = await engine(meta, async context => [await context.agent('a'), await context.agent('b')],
      { runId: 'cached', runner: fakeRunner().runner, journal, limits: { maxAgents: 1 } });
    expect(replay.agents.map(agent => agent.error?.code ?? agent.status)).toEqual(['completed', 'LIMIT']);
  });

  it('refuses a malformed engine clock', () => {
    expect(() => createDynamicEngine({ clock: { now: () => 0 } as never })).toThrow(TypeError);
  });
});

describe('dynamic workflow window and backoff', () => {
  it('ignores rate limits of attempts started before the last cut and grows only on full-window answers', async () => {
    const changes: number[] = [];
    const window = new DynamicWindow(8, 4, change => changes.push(change.window));
    const signal = new AbortController().signal;
    for (let i = 0; i < 4; i++) expect(await window.acquire(signal)).toBe(true);
    const epoch = window.epoch;
    window.rateLimited(epoch);
    window.rateLimited(epoch);
    expect(window.size).toBe(3);
    // Four still in flight over a window of 3: a fifth caller waits until two of them settle.
    const fifth = window.acquire(signal);
    let granted = false;
    void fifth.then(() => { granted = true; });
    window.release();
    await Promise.resolve();
    expect(granted).toBe(false);
    window.release();
    await fifth;
    expect(granted).toBe(true);
    // Three active over a window of 3 (full): an answer of the previous epoch does not count, one of this epoch grows it.
    window.succeeded(epoch);
    expect(window.size).toBe(3);
    window.succeeded(window.epoch);
    expect(changes).toEqual([3, 4]);
    // Not full any more: answers do not grow it.
    window.succeeded(window.epoch); window.succeeded(window.epoch);
    expect(window.size).toBe(4);
    // Cuts are floored and never go below 1.
    const small = new DynamicWindow(8, 2);
    small.rateLimited(small.epoch);
    small.rateLimited(small.epoch);
    expect(small.size).toBe(1);
  });

  it('backs off exponentially with deterministic jitter per call and retry', () => {
    const { baseMs, maxMs } = DYNAMIC_RATE_LIMIT_BACKOFF;
    for (let retry = 0; retry < 8; retry++) {
      const ceiling = Math.min(maxMs, baseMs * 2 ** retry);
      const delay = rateLimitDelay('key', retry, undefined, 0, Infinity)!;
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
      expect(rateLimitDelay('key', retry, undefined, 0, Infinity)).toBe(delay);
    }
    expect(new Set(['a', 'b', 'c', 'd'].map(key => rateLimitDelay(key, 0, undefined, 0, Infinity))).size).toBeGreaterThan(1);
    expect(rateLimitDelay('key', 0, 1_000 + 20_000, 1_000, 20_000)).toBeGreaterThanOrEqual(20_000);
    expect(rateLimitDelay('key', 0, 1_000 + 20_001, 1_000, 20_000)).toBeUndefined();
  });
});
