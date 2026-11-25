import { describe, expect, it } from 'vitest';

import { InteractionBroker } from '../../src/control/interaction-broker.js';
import { InteractionExpiredError, ProtocolError } from '../../src/public/errors.js';

describe('InteractionBroker', () => {
  it('settles one exact advertised decision and rejects a duplicate response', async () => {
    const written: unknown[] = [];
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const request = broker.register({
      providerRequestId: 7,
      method: 'item/commandExecution/requestApproval',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      payload: { command: ['git', 'status'] },
      availableDecisions: ['accept', 'decline'],
      settle: async (response) => { written.push(response); },
    });

    await broker.respond(request.binding.interactionId, { decision: 'accept' });

    expect(written).toEqual([{ decision: 'accept' }]);
    await expect(broker.respond(request.binding.interactionId, { decision: 'decline' }))
      .rejects.toBeInstanceOf(ProtocolError);
    expect(written).toHaveLength(1);
  });

  it('expires authority on epoch change so a stale response writes zero bytes', async () => {
    const written: unknown[] = [];
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const request = broker.register({
      providerRequestId: 7,
      method: 'item/commandExecution/requestApproval',
      sessionId: 'thread-1',
      payload: { command: ['rm', 'target'] },
      availableDecisions: ['accept', 'decline'],
      settle: async (response) => { written.push(response); },
    });

    broker.expireAll('epoch-2');

    await expect(broker.respond(request.binding.interactionId, { decision: 'accept' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
    expect(request.signal.aborted).toBe(true);
    expect(written).toHaveLength(0);
  });

  it('rejects a response the provider did not advertise', async () => {
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const request = broker.register({
      method: 'canUseTool',
      sessionId: 'session-1',
      payload: { tool: 'Bash' },
      availableDecisions: ['allow-once', 'deny'],
      settle: async () => undefined,
    });

    await expect(broker.respond(request.binding.interactionId, { decision: 'allow-session' }))
      .rejects.toBeInstanceOf(ProtocolError);
  });

  it('expires a single interaction so a late response writes zero bytes', async () => {
    const written: unknown[] = [];
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const request = broker.register({
      providerRequestId: 9,
      method: 'canUseTool',
      sessionId: 'session-1',
      payload: { toolName: 'Bash' },
      availableDecisions: ['allow', 'deny'],
      settle: async (response) => { written.push(response); },
    });

    broker.expire(request.binding.interactionId, 'missing handler denied at the wire');

    expect(request.signal.aborted).toBe(true);
    await expect(broker.respond(request.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
    expect(written).toHaveLength(0);

    // Idempotente y best-effort: repetir o expirar un id desconocido no lanza.
    broker.expire(request.binding.interactionId);
    broker.expire('unknown-id');
  });
});

describe('InteractionBroker retention (R6)', () => {
  function registerOne(broker: InteractionBroker) {
    return broker.register({
      method: 'canUseTool',
      sessionId: 'session-1',
      payload: { toolName: 'Write', input: { content: 'x'.repeat(4096) } },
      availableDecisions: ['allow', 'deny'],
      settle: async () => undefined,
    });
  }

  it('releases every settled or expired entry while keeping the typed distinction', async () => {
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const resolved = registerOne(broker);
    await broker.respond(resolved.binding.interactionId, { decision: 'allow' });
    const expired = registerOne(broker);
    broker.expire(expired.binding.interactionId);
    for (let i = 0; i < 2_000; i++) {
      const handle = registerOne(broker);
      await broker.respond(handle.binding.interactionId, { decision: 'allow' });
    }

    expect(broker.size).toBe(0);
    await expect(broker.respond(resolved.binding.interactionId, { decision: 'deny' }))
      .rejects.toThrow('Interaction already resolved');
    await expect(broker.respond(expired.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
    await expect(broker.respond('never-registered', { decision: 'allow' }))
      .rejects.toThrow('Unknown interaction');
  });

  it('bounds the tombstone set so forgotten ids degrade to unknown, never to retention', async () => {
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const first = registerOne(broker);
    await broker.respond(first.binding.interactionId, { decision: 'allow' });
    for (let i = 0; i < InteractionBroker.MAX_TOMBSTONES; i++) {
      const handle = registerOne(broker);
      await broker.respond(handle.binding.interactionId, { decision: 'allow' });
    }

    await expect(broker.respond(first.binding.interactionId, { decision: 'allow' }))
      .rejects.toThrow('Unknown interaction');
    expect(broker.size).toBe(0);
  });

  it('drops pending entries on epoch change and remembers them as expired', async () => {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
    const handle = registerOne(broker);
    broker.expireAll('epoch-2');

    expect(broker.size).toBe(0);
    await expect(broker.respond(handle.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
  });
});
