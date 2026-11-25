import { describe, expect, it } from 'vitest';

import { CodexRpcPeer } from '../../src/adapters/codex-control/rpc-peer.js';

describe('CodexRpcPeer', () => {
  it('keeps colliding client and server request ids in direction-separated maps', async () => {
    const writes: Array<Record<string, unknown>> = [];
    let releaseApproval!: () => void;
    const approvalReleased = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async (message) => { writes.push(message); },
      onServerRequest: async () => {
        await approvalReleased;
        return { decision: 'decline' };
      },
    });

    const outbound = peer.request('model/list', {});
    await Promise.resolve();
    const id = writes[0]?.id as string;
    expect(id).toBe('c:epoch-1:1');
    const inbound = peer.receive({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1', startedAtMs: 1, threadId: 'thread-1', turnId: 'turn-1' },
    });
    await peer.receive({ id, result: { data: ['gpt-5.6-sol'] } });

    await expect(outbound).resolves.toEqual({ data: ['gpt-5.6-sol'] });
    releaseApproval();
    await inbound;
    await peer.settled();
    expect(writes.at(-1)).toEqual({ id, result: { decision: 'decline' } });
  });

  it('always responds to an unhandled server request instead of leaving it pending', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async (message) => { writes.push(message); },
    });

    await peer.receive({
      id: 7,
      method: 'item/tool/call',
      params: { arguments: {}, callId: 'call-1', threadId: 'thread-1', turnId: 'turn-1', tool: 'echo' },
    });

    expect(writes).toEqual([{
      id: 7,
      error: { code: -32601, message: 'No handler for server request item/tool/call' },
    }]);
  });
});

describe('CodexRpcPeer inbound bookkeeping (R6)', () => {
  it('forgets a settled inbound id so the set stays flat and the id may be reused', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async (message) => { writes.push(message); },
      onServerRequest: async () => ({ decision: 'decline' }),
    });
    const params = { itemId: 'item-1', startedAtMs: 1, threadId: 'thread-1', turnId: 'turn-1' };

    for (let i = 0; i < 100; i++) {
      await peer.receive({ id: 's-1', method: 'item/commandExecution/requestApproval', params });
      await peer.settled();
    }

    expect(peer.inboundPending).toBe(0);
    expect(writes).toHaveLength(100);
  });
});

describe('CodexRpcPeer head-of-line (R2)', () => {
  const approvalParams = { itemId: 'item-1', startedAtMs: 1, threadId: 'thread-1', turnId: 'turn-1' };

  it('keeps notifications and responses flowing while a server request awaits the human', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const notifications: string[] = [];
    let releaseApproval!: () => void;
    const approvalReleased = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async (message) => { writes.push(message); },
      onServerRequest: async () => { await approvalReleased; return { decision: 'decline' }; },
      onNotification: (method) => { notifications.push(method); },
    });

    const started = Date.now();
    await peer.receive({ id: 's-1', method: 'item/commandExecution/requestApproval', params: approvalParams });
    await peer.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'hi' } });
    const outbound = peer.request('turn/interrupt', { threadId: 'thread-1' });
    await Promise.resolve();
    await peer.receive({ id: writes.find((w) => w.method === 'turn/interrupt')?.id as string, result: {} });

    expect(Date.now() - started).toBeLessThan(50);
    expect(notifications).toEqual(['item/agentMessage/delta']);
    await expect(outbound).resolves.toEqual({});
    expect(peer.inboundPending).toBe(1);

    releaseApproval();
    await peer.settled();
    expect(writes.at(-1)).toEqual({ id: 's-1', result: { decision: 'decline' } });
    expect(peer.inboundPending).toBe(0);
  });

  it('still rejects a duplicate inbound id synchronously as a typed protocol error', async () => {
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async () => undefined,
      onServerRequest: () => new Promise(() => undefined),
    });
    await peer.receive({ id: 's-1', method: 'item/commandExecution/requestApproval', params: approvalParams });

    await expect(peer.receive({ id: 's-1', method: 'item/commandExecution/requestApproval', params: approvalParams }))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('routes a wire failure of a late server answer to onAsyncError instead of losing it', async () => {
    const asyncErrors: unknown[] = [];
    let releaseApproval!: () => void;
    const approvalReleased = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async (message) => {
        if ('result' in message) throw new Error('stdin went away');
      },
      onServerRequest: async () => { await approvalReleased; return { decision: 'decline' }; },
      onAsyncError: (error) => { asyncErrors.push(error); },
    });
    await peer.receive({ id: 's-1', method: 'item/commandExecution/requestApproval', params: approvalParams });

    releaseApproval();
    await peer.settled();
    expect(asyncErrors).toHaveLength(1);
    expect((asyncErrors[0] as Error).message).toMatch(/stdin went away/);
  });
});
