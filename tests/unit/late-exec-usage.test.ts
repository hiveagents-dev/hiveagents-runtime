import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { Session } from '../../src/session/session.js';
import { SubscriptionExecAdapter } from '../../src/core/subscription-exec.js';
import { createExecutablePin, PinnedExecAdapter } from '../../src/core/registry.js';
import { AbortError, ProviderUnavailableError, TimeoutError } from '../../src/public/errors.js';
import type { ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import type { Usage } from '../../src/public/types.js';

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const modes = ['session-execute', 'session-stream', 'subscription-execute', 'subscription-stream', 'pin-execute', 'pin-stream', 'nested-session-stream', 'agent-run', 'agent-send', 'agent-stream'] as const;
type Mode = typeof modes[number];

async function fixture(mode: Mode, nominalFailure = false, override?: { usage?: Usage }) {
  const usage = override === undefined ? { inputTokens: 1300, outputTokens: 200, costMeaning: 'unavailable' } as Usage : override.usage;
  const entered = deferred<void>(), finish = deferred<void>();
  const result: ProtocolResult = { completed: true, failed: false, refused: false, sessionId: 'late-native', text: 'DO NOT PUBLISH', ...(usage === undefined ? {} : { usage }), events: [], nativeEvents: [] };
  const execute = async () => {
    entered.resolve(); await finish.promise;
    if (nominalFailure) throw new ProviderUnavailableError({ provider: 'claude', retryable: false, ...(usage === undefined ? {} : { observedUsage: usage }) });
    return result;
  };
  let adapter: ExecAdapter = { id: 'claude', detect: async () => ({ installed: true }), models: async () => [], auth: async () => ({ authenticated: true, source: 'subscription' }), execute };
  if (mode.includes('stream')) adapter.stream = async function* () { yield { kind: 'result', result: await execute() }; };
  if (mode.includes('subscription') || mode.includes('nested')) adapter = new SubscriptionExecAdapter(adapter);
  if (mode.includes('pin') || mode.includes('nested')) {
    const directory = await mkdtemp(join(tmpdir(), 'oar-late-usage-')); directories.push(directory);
    const path = join(directory, 'cli'); await writeFile(path, 'fixture');
    const pin = (await createExecutablePin(path))!;
    adapter = new PinnedExecAdapter(adapter, pin, async () => pin);
  }
  const owner = new Session({ adapter, model: { id: 'opus-5', provider: 'claude', aliases: [], source: 'explicit', availability: 'available' }, cwd: process.cwd(), transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
  const agent = new Agent({ model: 'opus-5', transport: 'exec' }, new Runtime({ adapters: [adapter] }));
  const events: unknown[] = [];
  const run = async (signal: AbortSignal, timeoutMs = 60000, awaitSettlement = true) => {
    const options = { signal, timeoutMs, awaitSettlement };
    if (mode.startsWith('agent-')) {
      if (mode === 'agent-run') return agent.run('x', options);
      if (mode === 'agent-send') return agent.send('x', options);
      for await (const event of agent.stream('x', options)) events.push(event);
      return;
    }
    if (mode.startsWith('session-') || mode.startsWith('nested')) {
      if (mode === 'session-execute') return owner.send('x', options);
      for await (const event of owner.stream('x', options)) events.push(event);
      return;
    }
    const request: ExecTurnRequest = { mode: 'open', modelId: 'opus-5', prompt: 'x', cwd: process.cwd(), env: {}, contextArgs: [], permissionArgs: [], maxOutputBytes: 1024, ...options };
    if (mode.endsWith('execute')) return adapter.execute(request);
    for await (const event of adapter.stream!(request)) events.push(event);
  };
  return { entered, finish, run, events, owner, agent, usage };
}

describe('observed usage after actual exec settlement', () => {
  for (const mode of modes) for (const nominalFailure of [false, true]) {
    it(`${mode} retains usage after cancellation and ${nominalFailure ? 'nominal rejection' : 'terminal result'}, without publishing it`, async () => {
      const f = await fixture(mode, nominalFailure), controller = new AbortController();
      let settled = false;
      const running = f.run(controller.signal).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
      await f.entered.promise; controller.abort();
      await Promise.resolve(); expect(settled).toBe(false);
      f.finish.resolve();
      const terminal = await running;
      expect(terminal).toHaveProperty('error');
      if (!('error' in terminal)) throw new Error('Late result escaped cancellation');
      expect(terminal.error).toBeInstanceOf(AbortError);
      expect(terminal.error.context.observedUsage).toEqual({ inputTokens: 1300, outputTokens: 200, costMeaning: 'unavailable' });
      expect(terminal.error.context.observedUsage).not.toBe(f.usage);
      expect(f.events).toEqual([]); expect(f.owner.ref).toBeUndefined();
      await f.agent.close(); await f.owner.close();
    });
  }

  it('retains the timeout outcome while preserving a later zero usage value', async () => {
    const f = await fixture('session-execute', false, { usage: { inputTokens: 0, outputTokens: 0, costMeaning: 'unavailable' } });
    vi.useFakeTimers();
    const running = f.run(new AbortController().signal, 10).catch(error => error);
    await f.entered.promise; await vi.advanceTimersByTimeAsync(15); f.finish.resolve();
    const error = await running;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.context.observedUsage).toEqual({ inputTokens: 0, outputTokens: 0, costMeaning: 'unavailable' });
    expect(f.owner.ref).toBeUndefined(); await f.owner.close();
  });

  it('keeps unreported usage unknown after cancellation', async () => {
    const f = await fixture('session-execute', false, {}), controller = new AbortController();
    const running = f.run(controller.signal).catch(error => error);
    await f.entered.promise; controller.abort(); f.finish.resolve();
    expect((await running).context.observedUsage).toBeUndefined(); await f.owner.close();
  });
});
