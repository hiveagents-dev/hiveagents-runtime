import { describe, expect, it, vi } from 'vitest';

import {
  createCodexControlRegistration,
  type CodexControlTransport,
  type CodexTransportStartOptions,
} from '../../src/adapters/codex-control/factory.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { AbortError, ProtocolError } from '../../src/public/errors.js';
import type { AgentEvent } from '../../src/public/types.js';

/** Only the external App Server is simulated; its factory and turn queues are real. */
class FakeCodexTransport implements CodexControlTransport {
  hooks!: CodexTransportStartOptions;
  readonly interrupted: string[] = [];
  readonly steered: string[] = [];
  readonly completeOnStart = new Set<number>();
  turns = 0;

  async request(method: string, params: unknown): Promise<unknown> {
    if (method === 'thread/start') return { threadId: 'thread-1' };
    if (method === 'turn/start') {
      const number = ++this.turns;
      const turnId = `turn-${number}`;
      queueMicrotask(() => {
        this.hooks.onNotification('turn/started', { threadId: 'thread-1', turnId });
        this.hooks.onNotification('item/completed', {
          threadId: 'thread-1',
          item: { id: `message-${number}`, type: 'agent_message', text: `response ${number}` },
        });
        if (this.completeOnStart.has(number)) this.complete(number);
      });
      return { turnId };
    }
    const { turnId } = params as { turnId: string };
    if (method === 'turn/interrupt') {
      this.interrupted.push(turnId);
      queueMicrotask(() => this.hooks.onNotification('turn/interrupted', {
        threadId: 'thread-1', turnId,
      }));
    }
    if (method === 'turn/steer') this.steered.push(turnId);
    return {};
  }

  complete(number: number): void {
    this.hooks.onNotification('turn/completed', {
      threadId: 'thread-1', turn: { id: `turn-${number}` },
    });
  }

  async close(): Promise<void> {}
}

async function openSession(transport: FakeCodexTransport) {
  const adapter: ExecAdapter = {
    id: 'codex',
    detect: async () => ({ installed: true }),
    auth: async () => ({ authenticated: true, source: 'subscription' }),
    models: async () => [],
    execute: async () => { throw new Error('Unexpected exec'); },
  };
  const runtime = new Runtime({
    adapters: [adapter],
    controlAdapters: [createCodexControlRegistration({
      startTransport: async (hooks) => { transport.hooks = hooks; return transport; },
    })],
  });
  return new Agent({
    model: 'gpt-5.2-codex', transport: 'control',
    providerOptions: { experimentalControl: true },
  }, runtime).openSession();
}

async function readCompleted(iterator: AsyncIterator<AgentEvent>): Promise<void> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('Missing turn.completed');
    if (next.value.type === 'turn.completed') return;
  }
}

describe('control stream ownership', () => {
  it('cannot interrupt a later turn through an already completed handle', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(1);
    const session = await openSession(transport);
    const first = session.start('first');
    await first.result;
    const second = session.start('second');
    void second.result.catch(() => undefined);
    await vi.waitFor(() => expect(transport.turns).toBe(2));
    try {
      await expect(first.interrupt()).resolves.toEqual({ requested: false, terminal: 'completed' });
      expect(transport.interrupted).toEqual([]);
      expect(session.state).toBe('running');
    } finally {
      transport.complete(2);
      await second.result.catch(() => undefined);
      await session.close();
    }
  });

  it('cannot steer a later turn through an already completed handle', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(1);
    const session = await openSession(transport);
    const first = session.start('first');
    await first.result;
    const second = session.start('second');
    await vi.waitFor(() => expect(transport.turns).toBe(2));
    try {
      await expect(first.steer?.('stale input')).rejects.toBeInstanceOf(ProtocolError);
      expect(transport.steered).toEqual([]);
      expect(session.state).toBe('running');
    } finally {
      transport.complete(2);
      await second.result;
      await session.close();
    }
  });

  it('retires control operations when the session closes', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(1);
    const session = await openSession(transport);
    const handle = session.start('first');
    await handle.result;
    await session.close();

    await expect(handle.interrupt()).resolves.toEqual({ requested: false, terminal: 'completed' });
    await expect(handle.steer?.('stale input')).rejects.toBeInstanceOf(ProtocolError);
    expect(transport.interrupted).toEqual([]);
    expect(transport.steered).toEqual([]);
    expect(session.state).toBe('closed');
  });

  it('retires the old signal before yielding completion to a paused consumer', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(1);
    const session = await openSession(transport);
    const controller = new AbortController();
    const iterator = session.stream('first', { signal: controller.signal })[Symbol.asyncIterator]();
    await readCompleted(iterator);
    const second = session.start('second');
    void second.result.catch(() => undefined);
    await vi.waitFor(() => expect(transport.turns).toBe(2));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(transport.interrupted).toEqual([]);
      expect(session.state).toBe('running');
    } finally {
      transport.complete(2);
      await second.result.catch(() => undefined);
      await iterator.return?.();
      await session.close();
    }
  });

  it('retires the deadline while the consumer pauses at completion', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(1);
    const session = await openSession(transport);
    vi.useFakeTimers();
    const iterator = session.stream('first', { timeoutMs: 100 })[Symbol.asyncIterator]();
    try {
      await readCompleted(iterator);
      await vi.advanceTimersByTimeAsync(200);
      expect(transport.interrupted).toEqual([]);
      expect(session.state).toBe('idle');
    } finally {
      await iterator.return?.();
      await session.close();
      vi.useRealTimers();
    }
  });

  it('does not release a later active turn when a completed iterator returns', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(1);
    const session = await openSession(transport);
    const iterator = session.stream('first')[Symbol.asyncIterator]();
    await readCompleted(iterator);
    const second = session.start('second');
    await vi.waitFor(() => expect(transport.turns).toBe(2));
    await iterator.return?.();
    try {
      expect(session.state).toBe('running');
      await session.steer('also this');
      expect(transport.steered).toEqual(['turn-2']);
    } finally {
      transport.complete(2);
      await second.result;
      await session.close();
    }
  });

  it('drains an abandoned turn before reconciliation permits another turn', async () => {
    const transport = new FakeCodexTransport();
    transport.completeOnStart.add(2);
    const session = await openSession(transport);
    const iterator = session.stream('first')[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    try {
      expect(session.state).toBe('interrupted');
      await expect(session.reconcile()).resolves.toBe('idle');
      await expect(session.send('second')).resolves.toMatchObject({ id: 'turn-2', text: 'response 2' });
    } finally { await session.close(); }
  });

  it('preserves closed state when an aborted paused iterator resumes', async () => {
    const transport = new FakeCodexTransport();
    const session = await openSession(transport);
    const controller = new AbortController();
    const iterator = session.stream('first', { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await vi.waitFor(() => expect(session.state).toBe('interrupted'));
    await session.close();
    await expect(iterator.next()).rejects.toBeInstanceOf(AbortError);
    expect(session.state).toBe('closed');
  });

  it('cannot let an old aborted iterator mutate or release a later turn', async () => {
    const transport = new FakeCodexTransport();
    const session = await openSession(transport);
    const controller = new AbortController();
    const iterator = session.stream('first', { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await vi.waitFor(() => expect(session.state).toBe('interrupted'));
    await session.reconcile();
    const second = session.start('second');
    void second.result.catch(() => undefined);
    await vi.waitFor(() => expect(transport.turns).toBe(2));
    await expect(iterator.next()).rejects.toBeInstanceOf(AbortError);
    try {
      expect(session.state).toBe('running');
      await session.steer('also this');
      expect(transport.steered).toEqual(['turn-2']);
    } finally {
      transport.complete(2);
      await second.result.catch(() => undefined);
      await session.close();
    }
  });
});
