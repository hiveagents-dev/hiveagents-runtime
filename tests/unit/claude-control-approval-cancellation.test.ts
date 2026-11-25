import { describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import { createClaudeControlRegistration } from '../../src/adapters/claude-control/factory.js';
import { ClaudeControlSession } from '../../src/adapters/claude-control/session.js';
import type { ClaudeAgentSdk, SdkPermissionResult } from '../../src/adapters/claude-control/sdk.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { InteractionExpiredError } from '../../src/public/errors.js';
import type { InteractionRequest, InteractionResponse } from '../../src/public/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const allow: InteractionResponse = { kind: 'approval', decision: 'allow' };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(controllers = [new AbortController()]) {
  const wires: SdkPermissionResult[] = [];
  const sdk: ClaudeAgentSdk = {
    query({ prompt, options }) {
      return Object.assign((async function* () {
        for await (const _input of prompt) {
          await Promise.all(controllers.map(async (controller, index) => {
            const verdict = await options!.canUseTool!(`Tool${index}`, { synthetic: true }, { signal: controller.signal });
            wires[index] = verdict;
          }));
          yield { type: 'result', subtype: 'success', session_id: 'synthetic-claude', result: 'done' };
        }
      })(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} });
    },
  };
  const broker = new InteractionBroker({ provider: 'claude', epoch: 'fixture' });
  const session = new ClaudeControlSession({ sessionId: 'fixture', cwd: '/tmp', persistence: 'process', broker, sdk });
  return { sdk, session, broker, wires, controllers };
}

const exec: ExecAdapter = {
  id: 'claude',
  detect: async () => ({ installed: true, path: '/synthetic/claude', realpath: '/synthetic/claude', version: '1.0.0' }),
  auth: async () => ({ authenticated: true, source: 'subscription' }),
  models: async () => [],
  execute: async () => { throw new Error('Fixture must never execute a CLI'); },
};

function publicSession(sdk: ClaudeAgentSdk) {
  const runtime = new Runtime({ adapters: [exec], controlAdapters: [createClaudeControlRegistration({ sdk, sdkVersion: 'synthetic' })] });
  return new Agent({ transport: 'control', providerOptions: { experimentalControl: true },
    model: 'claude-opus-5', cwd: '/tmp', permissions: { mode: 'analyze' } }, runtime).openSession({ persistence: 'process' });
}

describe('Claude tool approval cancellation', () => {
  it('does not expose an already-cancelled native approval to the application', async () => {
    const native = new AbortController(); native.abort();
    const { session, broker, wires } = fixture([native]);
    let calls = 0;
    try {
      const turn = await session.send('synthetic', { onInteraction: async () => { calls++; return allow; } });
      expect(calls).toBe(0);
      expect(turn.events.some((event) => event.type === 'interaction.requested')).toBe(false);
      expect([...wires]).toMatchObject([{ behavior: 'deny' }]);
      expect(broker.size).toBe(0);
    } finally { await session.close(); }
  });

  it('expires a pending request and refuses a late out-of-band approval', async () => {
    const { session, broker, wires, controllers } = fixture();
    const delivered = deferred<InteractionRequest>(), answer = deferred<InteractionResponse>();
    const turn = session.send('synthetic', { onInteraction: (request) => { delivered.resolve(request); return answer.promise; } });
    const request = await delivered.promise;
    try {
      controllers[0]!.abort();
      expect(request.signal.aborted).toBe(true);
      expect(broker.size).toBe(0);
      expect(getEventListeners(controllers[0]!.signal, 'abort')).toHaveLength(0);
      await expect(broker.respond(request.binding.interactionId, { decision: 'allow' })).rejects.toBeInstanceOf(InteractionExpiredError);
    } finally { answer.resolve(allow); await turn; await session.close(); }
    expect([...wires]).toMatchObject([{ behavior: 'deny' }]);
  });

  it('settles the wire on cancellation without waiting for the application answer', async () => {
    const { session, wires, controllers } = fixture();
    const delivered = deferred<InteractionRequest>(), answer = deferred<InteractionResponse>();
    const turn = session.send('synthetic', { onInteraction: (request) => { delivered.resolve(request); return answer.promise; } });
    await delivered.promise;
    try {
      controllers[0]!.abort();
      await flush();
      expect([...wires]).toMatchObject([{ behavior: 'deny' }]);
    } finally { answer.resolve(allow); await turn; await session.close(); }
    expect([...wires]).toMatchObject([{ behavior: 'deny' }]);
  });

  it.each(['allow', 'deny'] as const)('preserves a legitimate %s even if the native signal aborts afterwards', async (decision) => {
    const { session, broker, wires, controllers } = fixture();
    try {
      await session.send('synthetic', { onInteraction: async () => ({ kind: 'approval', decision }) });
      controllers[0]!.abort(); await flush();
      expect([...wires]).toMatchObject([{ behavior: decision }]);
      expect(broker.size).toBe(0);
      expect(getEventListeners(controllers[0]!.signal, 'abort')).toHaveLength(0);
    } finally { await session.close(); }
  });

  it('the public runtime cancels only that native request, then accepts another turn', async () => {
    const f = fixture([new AbortController(), new AbortController()]);
    const session = await publicSession(f.sdk);
    const delivered = [deferred<InteractionRequest>(), deferred<InteractionRequest>()];
    const answers = [deferred<InteractionResponse>(), deferred<InteractionResponse>()];
    const handle = session.start('synthetic', { onInteraction: (request) => {
      const index = request.kind === 'tool-approval' && request.toolName === 'Tool0' ? 0 : 1;
      delivered[index]!.resolve(request); return answers[index]!.promise;
    } });
    const [first, second] = await Promise.all(delivered.map((item) => item.promise));
    try {
      f.controllers[0]!.abort();
      expect(first!.signal.aborted).toBe(true);
      expect(second!.signal.aborted).toBe(false);
      await expect(handle.respond(first!.binding.interactionId, allow)).rejects.toBeInstanceOf(InteractionExpiredError);
      answers[1]!.resolve(allow);
      await flush();
      expect(f.wires).toMatchObject([{ behavior: 'deny' }, { behavior: 'allow' }]);
    } finally { for (const answer of answers) answer.resolve(allow); await handle.result; }
    try {
      expect(session.state).toBe('idle');
      const next = await session.send('next', { onInteraction: async () => allow });
      expect(next.status).toBe('completed');
    } finally { await session.close(); await f.session.close(); }
  });
});
