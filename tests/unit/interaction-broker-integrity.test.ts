import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('Optional SDK absent in this fixture'); });

import { ClaudeControlSession } from '../../src/adapters/claude-control/session.js';
import type { ClaudeAgentSdk, SdkPermissionResult, SdkQuery } from '../../src/adapters/claude-control/sdk.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
import { InteractionExpiredError, ProtocolError } from '../../src/public/errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function approval(broker: InteractionBroker, payload: unknown, settle: () => Promise<void>, bindPayload = false) {
  return broker.register({
    method: 'canUseTool',
    sessionId: 'session-1',
    payload,
    ...(bindPayload ? { bindPayload } : {}),
    availableDecisions: ['allow', 'deny'],
    settle,
  });
}

describe('InteractionBroker epoch isolation', () => {
  it('stamps the current epoch and retires a settlement in flight when the epoch rotates', async () => {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const gate = deferred<void>();
    const settle = vi.fn(() => gate.promise);
    const handle = approval(broker, { command: 'ls' }, settle);
    expect(handle.binding.transportEpoch).toBe('epoch-1');

    const responding = broker.respond(handle.binding.interactionId, { decision: 'allow' });
    broker.expireAll('epoch-2');
    expect(handle.signal.aborted).toBe(true);
    expect(broker.size).toBe(0);
    gate.resolve();

    // Written to a dead transport: never reported as resolved on the new one.
    await expect(responding).rejects.toBeInstanceOf(InteractionExpiredError);
    await expect(broker.respond(handle.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('keeps the settle failure of a rotated settlement and records the entry as expired', async () => {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const gate = deferred<void>();
    const handle = approval(broker, {}, () => gate.promise);
    const responding = broker.respond(handle.binding.interactionId, { decision: 'deny' });
    broker.expireAll('epoch-2');
    gate.reject(new Error('pipe closed'));

    await expect(responding).rejects.toThrow('pipe closed');
    await expect(broker.respond(handle.binding.interactionId, { decision: 'deny' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
  });

  it('binds new interactions to the rotated epoch and settles them normally', async () => {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    broker.expireAll('epoch-2');
    const settle = vi.fn(async () => undefined);
    const handle = approval(broker, {}, settle);
    expect(handle.binding.transportEpoch).toBe('epoch-2');
    await broker.respond(handle.binding.interactionId, { decision: 'allow' });
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe('InteractionBroker payload binding', () => {
  it('refuses a decision whose bound payload changed after it was presented', async () => {
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const input = { command: 'ls' };
    const settle = vi.fn(async () => undefined);
    const handle = approval(broker, { toolName: 'Bash', input }, settle, true);

    input.command = 'rm -rf ~';

    await expect(broker.respond(handle.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(ProtocolError);
    expect(settle).not.toHaveBeenCalled();
    expect(handle.signal.aborted).toBe(true);
    expect(broker.size).toBe(0);
    await expect(broker.respond(handle.binding.interactionId, { decision: 'deny' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
  });

  it('settles an unchanged bound payload, and leaves unbound payloads to their owner', async () => {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const bound = approval(broker, { input: { a: 1 } }, async () => undefined, true);
    await expect(broker.respond(bound.binding.interactionId, { decision: 'allow' })).resolves.toBeUndefined();

    // A dynamic tool may consume its arguments; its settlement never echoes them.
    const args = { path: 'a' };
    const unbound = approval(broker, { arguments: args }, async () => undefined);
    args.path = 'b';
    await expect(broker.respond(unbound.binding.interactionId, { decision: 'allow' })).resolves.toBeUndefined();
  });

  it('denies at the Claude wire when a handler mutates the tool input it approves', async () => {
    const wire: SdkPermissionResult[] = [];
    const sdk: ClaudeAgentSdk = {
      query({ prompt, options }) {
        const generator = (async function* () {
          for await (const _user of prompt) {
            yield { type: 'system', subtype: 'init', session_id: 'native-1' };
            wire.push(await options!.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal }));
            yield { type: 'result', subtype: 'success', session_id: 'native-1', result: 'done' };
          }
        })();
        return Object.assign(generator, {
          interrupt: async () => undefined, setPermissionMode: async () => undefined, setModel: async () => undefined,
        }) as unknown as SdkQuery;
      },
    };
    const session = new ClaudeControlSession({
      sessionId: 'session-1', cwd: '/tmp/project', persistence: 'process',
      broker: new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' }), sdk,
    });

    await session.send('hi', {
      onInteraction: async (request) => {
        if (request.kind === 'tool-approval') (request.input as { command: string }).command = 'rm -rf ~';
        return { kind: 'approval', decision: 'allow' };
      },
    });

    expect(wire).toEqual([{ behavior: 'deny', message: 'Interaction payload changed after it was presented' }]);
    await session.close();
  });
});

describe('InteractionBroker settled refusals', () => {
  it('resolves an interaction the settlement answered with another decision and rethrows the refusal', async () => {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const refusal = new Error('acceptance refused; declined on the wire');
    const settle = vi.fn(async () => ({ refusal }));
    const handle = broker.register({
      method: 'item/commandExecution/requestApproval',
      sessionId: 'th-1',
      payload: { command: 'ls' },
      availableDecisions: ['accept', 'decline'],
      settle,
    });

    await expect(broker.respond(handle.binding.interactionId, { decision: 'accept' })).rejects.toBe(refusal);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(handle.signal.aborted).toBe(true);
    expect(broker.size).toBe(0);
    // The wire was settled, so the tombstone says resolved and expire() is a no-op.
    expect(broker.expire(handle.binding.interactionId)).toBe(false);
    await expect(broker.respond(handle.binding.interactionId, { decision: 'decline' }))
      .rejects.toThrow(ProtocolError);
  });
});
