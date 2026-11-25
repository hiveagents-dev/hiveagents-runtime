import { describe, expect, it, vi } from 'vitest';

import { createClaudeControlRegistration } from '../../src/adapters/claude-control/factory.js';
import type { ClaudeAgentSdk, SdkQuery, SdkQueryOptions, SdkUserMessage } from '../../src/adapters/claude-control/sdk.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { AbortError, TimeoutError } from '../../src/public/errors.js';
import type { ControlSessionHandle } from '../../src/session/control-session.js';

class FakeSdk implements ClaudeAgentSdk {
  queries = 0;
  interrupts = 0;
  readonly prompts: unknown[] = [];
  onQuery: (() => void) | undefined;
  onPrompt: (() => void) | undefined;

  query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }): SdkQuery {
    this.queries += 1;
    this.onQuery?.();
    const sdk = this;
    const generator = (async function* () {
      for await (const message of prompt) {
        sdk.prompts.push(message.message.content);
        sdk.onPrompt?.();
        yield { type: 'result', subtype: 'success', session_id: 'claude-thread', result: 'done' };
      }
    })();
    return Object.assign(generator, {
      interrupt: async () => { this.interrupts += 1; },
      close: () => { void generator.return(); },
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
    });
  }
}

async function openSession(sdk: FakeSdk) {
  const adapter: ExecAdapter = {
    id: 'claude', detect: async () => ({ installed: true }),
    auth: async () => ({ authenticated: true, source: 'subscription' }),
    models: async () => [], execute: async () => { throw new Error('Unexpected exec'); },
  };
  const registration = createClaudeControlRegistration({ sdk });
  const create = registration.createSession!;
  let control!: ControlSessionHandle;
  const runtime = new Runtime({ adapters: [adapter], controlAdapters: [{
    ...registration,
    createSession: async (request) => { control = await create(request); return control; },
  }] });
  const session = await new Agent({
    model: 'opus-5', transport: 'control', providerOptions: { experimentalControl: true },
  }, runtime).openSession();
  return { session, control };
}

describe('Claude control cancellation before prompt submission', () => {
  it.each(['send', 'stream'] as const)('does not start a lazy Query after immediate %s abort', async (mode) => {
    const sdk = new FakeSdk();
    const { session } = await openSession(sdk);
    const controller = new AbortController();
    const pending = mode === 'send'
      ? session.send('cancelled prompt', { signal: controller.signal })
      : session.stream('cancelled prompt', { signal: controller.signal })[Symbol.asyncIterator]().next();
    controller.abort();
    try {
      await expect(pending).rejects.toBeInstanceOf(AbortError);
      expect(sdk.queries).toBe(0);
      expect(sdk.prompts).toEqual([]);
    } finally { await session.close(); }
  });

  it('prevents a prompt when the native turn is interrupted before its first read', async () => {
    const sdk = new FakeSdk();
    const { session, control } = await openSession(sdk);
    const turn = await control.startTurn({ input: 'cancelled prompt' });
    await turn.interrupt();
    try {
      await expect(turn.stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AbortError);
      expect(sdk.queries).toBe(0);
      expect(sdk.prompts).toEqual([]);
    } finally { await session.close(); }
  });

  it('checks an external abort again after Query creation', async () => {
    const sdk = new FakeSdk();
    const { session } = await openSession(sdk);
    const controller = new AbortController();
    sdk.onQuery = () => controller.abort();
    try {
      await expect(session.send('cancelled prompt', { signal: controller.signal }))
        .rejects.toBeInstanceOf(AbortError);
      expect(sdk.queries).toBe(1);
      expect(sdk.prompts).toEqual([]);
    } finally { await session.close(); }
  });

  it('checks a native interrupt that races Query creation before enqueuing input', async () => {
    const sdk = new FakeSdk();
    const { session, control } = await openSession(sdk);
    const turn = await control.startTurn({ input: 'cancelled prompt' });
    sdk.onQuery = () => { void turn.interrupt(); };
    try {
      await expect(turn.stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AbortError);
      expect(sdk.queries).toBe(1);
      expect(sdk.prompts).toEqual([]);
    } finally { await session.close(); }
  });

  it('prevents a prompt after an immediate public handle interrupt', async () => {
    const sdk = new FakeSdk();
    const { session } = await openSession(sdk);
    const turn = session.start('cancelled prompt');
    void turn.result.catch(() => undefined);
    await turn.interrupt();
    try {
      await expect(turn.result).rejects.toBeInstanceOf(AbortError);
      expect(sdk.prompts).toEqual([]);
    } finally { await session.close(); }
  });

  it('prevents enqueue when a deadline expires during Query creation', async () => {
    const sdk = new FakeSdk();
    const { session } = await openSession(sdk);
    vi.useFakeTimers();
    sdk.onQuery = () => vi.advanceTimersByTime(10);
    try {
      const pending = session.send('cancelled prompt', { timeoutMs: 10 });
      void pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(pending).rejects.toBeInstanceOf(TimeoutError);
      expect(sdk.prompts).toEqual([]);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  it('still drains a previously submitted prompt before allowing reuse', async () => {
    const sdk = new FakeSdk();
    const { session } = await openSession(sdk);
    const controller = new AbortController();
    sdk.onPrompt = () => controller.abort();
    try {
      await expect(session.send('submitted prompt', { signal: controller.signal }))
        .rejects.toBeInstanceOf(AbortError);
      expect(session.state).toBe('interrupted');
      await expect(session.reconcile()).resolves.toBe('idle');
      sdk.onPrompt = undefined;
      await expect(session.send('next prompt')).resolves.toMatchObject({ text: 'done' });
      expect(sdk.prompts).toEqual(['submitted prompt', 'next prompt']);
    } finally { await session.close(); }
  });
});
