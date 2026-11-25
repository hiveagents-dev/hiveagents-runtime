import { describe, expect, it } from 'vitest';

import {
  createCodexControlRegistration,
  type CodexControlTransport,
  type CodexTransportStartOptions,
} from '../../src/adapters/codex-control/factory.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { ProviderUnavailableError } from '../../src/public/errors.js';
import type { AgentEvent } from '../../src/public/types.js';

const fakeExec: ExecAdapter = {
  id: 'codex',
  detect: async () => ({ installed: true, path: '/fixture/codex', version: '0.149.0' }),
  auth: async () => ({ authenticated: true, source: 'subscription' }),
  models: async () => [],
  execute: async () => { throw new Error('No real CLI or EXEC fallback is permitted'); },
};

/** Uses the documented App Server v2 terminal shape, without launching a provider. */
async function failedSession() {
  let hooks: CodexTransportStartOptions;
  let closes = 0;
  const transport: CodexControlTransport = {
    request: async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          hooks.onNotification('turn/started', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' },
          });
          hooks.onNotification('item/completed', {
            threadId: 'thread-1', item: { id: 'item-1', type: 'agentMessage', text: 'Partial answer' },
          });
          hooks.onNotification('error', {
            threadId: 'thread-1', turnId: 'turn-1', willRetry: false,
            error: { message: 'Provider fixture failed', codexErrorInfo: 'internalServerError' },
          });
          hooks.onNotification('turn/completed', {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1', status: 'failed', items: [],
              error: { message: 'Provider fixture failed', codexErrorInfo: 'internalServerError' },
            },
          });
        });
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      return {};
    },
    close: async () => { closes += 1; },
  };
  const runtime = new Runtime({
    adapters: [fakeExec],
    controlAdapters: [createCodexControlRegistration({
      startTransport: async (options) => { hooks = options; return transport; },
    })],
  });
  const agent = new Agent({
    model: 'gpt-5.2-codex', transport: 'control', providerOptions: { experimentalControl: true },
  }, runtime);
  return { session: await agent.openSession(), closes: () => closes };
}

describe('Codex App Server failed turn/completed', () => {
  it('rejects send instead of certifying a partial answer as a completed turn', async () => {
    const fixture = await failedSession();
    try {
      await expect(fixture.session.send('fixture')).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE', message: 'Provider is unavailable',
        context: { sanitizedDiagnostics: { kind: 'provider-unavailable' } },
      });
      expect(fixture.session.state).toBe('failed');
    } finally {
      await fixture.session.close();
    }
    expect(fixture.closes()).toBe(1);
  });

  it('rejects stream and never emits turn.completed for the failed terminal', async () => {
    const fixture = await failedSession();
    const events: AgentEvent[] = [];
    const consume = async () => {
      for await (const event of fixture.session.stream('fixture')) events.push(event);
    };
    try {
      await expect(consume()).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
      expect(events).toContainEqual({ type: 'message.completed', text: 'Partial answer' });
      expect(fixture.session.state).toBe('failed');
    } finally {
      await fixture.session.close();
    }
    expect(fixture.closes()).toBe(1);
  });
});
