import { expect, it } from 'vitest';
import { openCodexControlSession, type CodexTransportStartOptions } from '../../src/adapters/codex-control/factory.js';
import type { ControlSessionRequest } from '../../src/session/control-session.js';

it('admits common tools only for a provider-confirmed active turn on a live handle', async () => {
  let hooks!: CodexTransportStartOptions, callbacks = 0;
  const request: ControlSessionRequest = {
    model: { provider: 'codex', id: 'fixture', aliases: [], source: 'explicit', availability: 'unverified' },
    cwd: '/tmp', persistence: 'process', env: {}, experimentalApi: true, capabilities: {},
    tools: [{ name: 'read_note', description: 'Read', inputSchema: { type: 'object' }, timeoutMs: 100, maxOutputBytes: 100,
      authorize: () => { callbacks++; return true; }, execute: () => { callbacks++; return null; } }],
    envelope: { authorityEpoch: 'a', filesystem: { readonlyRoots: ['/tmp'], writableRoots: [] }, network: [], tools: ['read_note'], executables: [], mcpServers: [], environmentVariables: [], settingsPersistence: 'none', enforcedBy: ['sandbox'], permissionModeCeiling: 'plan' },
  };
  let n = 0;
  const session = await openCodexControlSession(request, { startTransport: async options => {
    hooks = options;
    return { close: async () => {}, request: async method => method === 'turn/start'
      ? { turn: { id: `turn-${++n}` } } : { thread: { id: 'thread' } } };
  } });
  let call = 0;
  const invoke = (threadId = 'thread', turnId?: string) => hooks.onServerRequest('item/tool/call',
    { threadId, ...(turnId ? { turnId } : {}), callId: `call-${++call}`, tool: 'read_note', arguments: {} }, call);
  const denied = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  try {
    await denied(invoke('missing', 'turn-1'));
    await denied(invoke('thread', 'turn-1'));
    const first = await session.startTurn({ input: 'one', timeoutMs: 1000 });
    await denied(invoke());
    await denied(invoke('thread', 'old'));
    await expect(invoke('thread', 'turn-1')).resolves.toMatchObject({ success: true });
    hooks.onNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } });
    for await (const _ of first.stream) { /* drain terminal */ }
    await denied(invoke('thread', 'turn-1'));
    const second = await session.startTurn({ input: 'two', timeoutMs: 1000 });
    await denied(invoke('thread', 'turn-1'));
    await expect(invoke('thread', 'turn-2')).resolves.toMatchObject({ success: true });
    hooks.onNotification('turn/completed', { threadId: 'thread', turn: { id: 'turn-2', status: 'completed' } });
    for await (const _ of second.stream) { /* drain terminal */ }
    await session.close();
    await denied(invoke('thread', 'turn-2'));
    expect(callbacks).toBe(4);
  } finally { await session.close(); }
});
