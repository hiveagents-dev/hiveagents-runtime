import { ExecutionHaltedError } from '../../src/public/execution-halt.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import { Session } from '../../src/session/session.js';
import { SubscriptionExecAdapter } from '../../src/core/subscription-exec.js';
import { createExecutablePin, PinnedExecAdapter } from '../../src/core/registry.js';
import { runObservedTask } from '../../src/orchestration/tasks/index.js';
import { runEvaluation } from '../../src/orchestration/evaluation/index.js';
import type { AdapterStreamItem, ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const result = (): ProtocolResult => ({ completed: true, failed: false, refused: false, sessionId: 'native', text: 'ok', events: [], nativeEvents: [] });
const base = (): ExecAdapter => ({ id: 'claude', detect: async () => ({ installed: true }), auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [], execute: async () => result() });
const session = (adapter: ExecAdapter) => new Session({ adapter, model: { id: 'opus-5', provider: 'claude', aliases: [], source: 'explicit', availability: 'available' }, cwd: process.cwd(), transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
const request = (): ExecTurnRequest => ({ mode: 'open', modelId: 'opus-5', cwd: process.cwd(), prompt: 'x', env: {}, contextArgs: [], permissionArgs: [], timeoutMs: 10, maxOutputBytes: 1024, awaitSettlement: true });
afterEach(() => vi.useRealTimers());
/** A probe the test holds open explicitly instead of a wall-clock delay. */
const gate = () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  return { enter, entered, held, release };
};

describe('opted-in actual exec settlement', () => {
  it.each(['stream', 'execute-only', 'no-return'] as const)('holds evaluation reservations for the actual Session %s work', async mode => {
    vi.useFakeTimers(); let active = 0, maximum = 0, returned = false;
    const released: number[] = [], admitted: number[] = [];
    const adapter = base();
    const work = async () => { active++; maximum = Math.max(maximum, active); await delay(40); active--; return result(); };
    adapter.execute = work;
    if (mode === 'stream') adapter.stream = async function* () { yield { kind: 'result', result: await work() }; };
    if (mode === 'no-return') adapter.stream = () => ({ [Symbol.asyncIterator]() { return { next: async () => ({ done: false, value: { kind: 'result', result: await work() } as AdapterStreamItem }) }; } });
    const running = runEvaluation({ id: 'settlement', timeoutMs: 10,
      suite: { id: 'suite', version: '1', cases: ['one', 'two'].map(id => ({ id, input: true, expected: true })) },
      profile: { id: 'fake', version: '1', sourceDigest: 'a'.repeat(64) },
      budget: { acquire() { admitted.push(active); return { release() { released.push(active); } }; } },
      async execute(_input, context) {
        const turn = await runObservedTask(session(adapter), 'x', { signal: context.signal, timeoutMs: 10, awaitSettlement: true });
        return { output: turn.text };
      }, scorers: [{ id: 'score', version: '1', score: () => ({ value: 1, passed: true }) }],
    }).finally(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(15);
    expect(returned).toBe(false); expect(active).toBe(1); expect(released).toEqual([]);
    await vi.runAllTimersAsync(); const report = await running;
    expect(report.attempts.map(item => item.status)).toEqual(['timed-out', 'timed-out']);
    expect(admitted).toEqual([0, 0]); expect(released).toEqual([0, 0]); expect(maximum).toBe(1); expect(active).toBe(0);
  });

  it('preserves bounded default stream cancellation', async () => {
    vi.useFakeTimers(); let active = false;
    const adapter = base(); adapter.stream = async function* () { active = true; await delay(100); active = false; yield { kind: 'result', result: result() }; };
    const running = runObservedTask(session(adapter), 'x', { timeoutMs: 10 }).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15);
    expect(await running).toMatchObject({ code: 'TIMEOUT' }); expect(active).toBe(true);
    await vi.runAllTimersAsync(); expect(active).toBe(false);
  });

  it.each(['subscription-execute', 'subscription-stream', 'pin-execute', 'pin-stream'] as const)('drains %s prerequisites and never starts late inference', async mode => {
    const inner = base(); const execute = vi.fn(inner.execute); inner.execute = execute;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    let settled = false, probeFinished = false; let directory: string | undefined;
    try {
      let wrapped: ExecAdapter;
      if (mode.startsWith('subscription')) {
        inner.auth = async () => { entered(); await pending; probeFinished = true; return { authenticated: true, source: 'subscription' }; };
        inner.stream = async function* (value) { yield { kind: 'result', result: await inner.execute(value) }; };
        wrapped = new SubscriptionExecAdapter(inner);
      } else {
        directory = await mkdtemp(join(tmpdir(), 'oar-settle-pin-')); const file = join(directory, 'cli'); await writeFile(file, 'old');
        const pin = (await createExecutablePin(file))!; await writeFile(file, 'new');
        inner.stream = async function* (value) { yield { kind: 'result', result: await inner.execute(value) }; };
        wrapped = new PinnedExecAdapter(inner, pin, async () => { entered(); await pending; probeFinished = true; return pin; });
      }
      const running = (mode.endsWith('stream') ? wrapped.stream!(request())[Symbol.asyncIterator]().next() : wrapped.execute(request()))
        .then(() => undefined, error => error).finally(() => { settled = true; });
      // Hold a genuinely entered prerequisite. Scheduler load must not finish a 40ms fixture
      // before our pending assertion; the actual 10ms deadline stays unchanged.
      try { await started; await delay(15); expect(settled).toBe(false); } finally { release(); }
      expect(await running).toMatchObject({ code: 'TIMEOUT' });
      expect(probeFinished).toBe(true); expect(execute).not.toHaveBeenCalled();
    } finally { release(); if (directory) await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['subscription', 'pin'] as const)('drains %s inner pending next and queued cleanup', async kind => {
    const inner = base(); let nextDone = false, cleanupDone = false, settled = false;
    const next = gate(), cleanup = gate();
    inner.stream = async function* () { try { next.enter(); await next.held; nextDone = true; yield { kind: 'result', result: result() }; } finally { cleanup.enter(); await cleanup.held; cleanupDone = true; } };
    let directory: string | undefined;
    try {
      let wrapped: ExecAdapter = new SubscriptionExecAdapter(inner);
      if (kind === 'pin') { directory = await mkdtemp(join(tmpdir(), 'oar-settle-stream-')); const file = join(directory, 'cli'); await writeFile(file, 'cli'); const pin = (await createExecutablePin(file))!; wrapped = new PinnedExecAdapter(inner, pin, async () => pin); }
      vi.useFakeTimers();
      const running = wrapped.stream!(request())[Symbol.asyncIterator]().next().then(() => undefined, error => error).finally(() => { settled = true; });
      // The 10ms deadline fires on the fake clock while the inner next() is held open.
      await next.entered; await vi.advanceTimersByTimeAsync(15); expect(settled).toBe(false);
      // Its queued return() runs the generator's finally, which is held open in turn.
      next.release(); await cleanup.entered; await vi.advanceTimersByTimeAsync(15);
      expect(nextDone).toBe(true); expect(cleanupDone).toBe(false); expect(settled).toBe(false);
      cleanup.release(); expect(await running).toMatchObject({ code: 'TIMEOUT' }); expect(cleanupDone).toBe(true);
    } finally { next.release(); cleanup.release(); vi.useRealTimers(); if (directory) await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['stream', 'start', 'run'] as const)('drains Agent %s readiness before returning a deadline', async mode => {
    const adapter = base(); let probeDone = false, settled = false;
    const probe = gate();
    adapter.detect = async () => { probe.enter(); await probe.held; probeDone = true; return { installed: true }; };
    adapter.execute = vi.fn(adapter.execute);
    vi.useFakeTimers();
    const agent = new Agent({ model: 'opus-5', transport: 'exec' }, new Runtime({ adapters: [adapter] }));
    const options = { timeoutMs: 10, awaitSettlement: true };
    const running = (mode === 'stream' ? agent.stream('x', options)[Symbol.asyncIterator]().next() : mode === 'start' ? agent.start('x', options).result : agent.run('x', options))
      .then(() => undefined, error => error).finally(() => { settled = true; });
    try {
      // The deadline fires on the fake clock while the readiness probe is held open: no wall-clock window.
      await probe.entered; await vi.advanceTimersByTimeAsync(15); expect(settled).toBe(false); expect(probeDone).toBe(false);
    } finally { probe.release(); }
    expect(await running).toMatchObject({ code: 'TIMEOUT' }); expect(probeDone).toBe(true); expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['stream', 'start', 'run'] as const)('preserves a late readiness halt from Agent %s', async mode => {
    const adapter = base();
    const probe = gate(), controller = new AbortController(), halt = new ExecutionHaltedError();
    adapter.detect = async () => { probe.enter(); await probe.held; throw halt; };
    adapter.execute = vi.fn(adapter.execute);
    const agent = new Agent({ model: 'opus-5', transport: 'exec' }, new Runtime({ adapters: [adapter] }));
    const options = { signal: controller.signal, awaitSettlement: true };
    const running = (mode === 'stream' ? agent.stream('x', options)[Symbol.asyncIterator]().next()
      : mode === 'start' ? agent.start('x', options).result : agent.run('x', options))
      .catch((error: unknown) => error);
    await probe.entered;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    probe.release();
    expect(await running).toBe(halt);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['stream', 'start', 'run'] as const)('keeps Agent %s execution pending until native work settles', async mode => {
    const adapter = base();
    const agent = new Agent({ model: 'opus-5', transport: 'exec' }, new Runtime({ adapters: [adapter] }));
    await agent.ready(); vi.useFakeTimers(); let active = false, settled = false;
    adapter.execute = async () => { active = true; await delay(40); active = false; return result(); };
    const options = { timeoutMs: 10, awaitSettlement: true };
    const running = (mode === 'stream' ? agent.stream('x', options)[Symbol.asyncIterator]().next() : mode === 'start' ? agent.start('x', options).result : agent.run('x', options))
      .then(() => undefined, error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15); expect(active).toBe(true); expect(settled).toBe(false);
    await vi.runAllTimersAsync(); expect(await running).toMatchObject({ code: 'TIMEOUT' }); expect(active).toBe(false); await agent.close();
  });

  it.each(['execute-only', 'stream'] as const)('drains an opted-in exec fork %s before reporting failed child admission', async mode => {
    vi.useFakeTimers(); const adapter = base(), owner = session(adapter); await owner.send('initial');
    let active = false, settled = false;
    const work = async () => { active = true; await delay(40); active = false; return { ...result(), sessionId: 'child' }; };
    adapter.execute = work;
    if (mode === 'stream') adapter.stream = async function* () { yield { kind: 'result', result: await work() }; };
    const running = owner.forkAndSend('child', { timeoutMs: 10, awaitSettlement: true }).then(() => undefined, error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15); expect(active).toBe(true); expect(settled).toBe(false);
    await vi.runAllTimersAsync(); expect(await running).toMatchObject({ code: 'TIMEOUT' }); expect(active).toBe(false);
  });

  it.each([{ name: 'Claude', Adapter: ClaudeExecAdapter }, { name: 'Codex', Adapter: CodexExecAdapter }])('drains $name underlying runner after early stream return', async ({ Adapter }) => {
    vi.useFakeTimers(); let active = false, settled = false;
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async request => {
      active = true;
      request.onStdout?.(Buffer.from(Adapter === ClaudeExecAdapter
        ? '{"type":"system","subtype":"init","session_id":"native"}\n'
        : '{"type":"thread.started","thread_id":"native"}\n'));
      await delay(40); active = false;
      return { code: 0, signal: null, stdout: '', stderr: '', durationMs: 40 };
    } });
    const iterator = session(adapter).stream('x', { timeoutMs: 100, awaitSettlement: true })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'session.started' });
    const returning = iterator.return!().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15); expect(active).toBe(true); expect(settled).toBe(false);
    await vi.runAllTimersAsync(); await returning; expect(active).toBe(false);
  });

  it('rejects a nonboolean opt-in before inference', async () => {
    const adapter = base(); adapter.execute = vi.fn(adapter.execute);
    await expect(session(adapter).send('x', { awaitSettlement: 'yes' as never })).rejects.toThrow(/awaitSettlement/);
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
