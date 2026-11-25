import { describe, expect, it } from 'vitest';
import { openCodexControlSession, type CodexTransportStartOptions } from '../../src/adapters/codex-control/factory.js';
import type { CodexDynamicToolDefinition } from '../../src/adapters/codex-control/dynamic-tools.js';
import type { ControlSessionRequest } from '../../src/session/control-session.js';

// The pinned rust-v0.149.0 protocol requires DynamicToolCallResponse:
// { contentItems: (inputText | inputImage | inputAudio)[], success: boolean }.
// Source: codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts
// The real server's dynamic_tools.rs::decode_response rejects arbitrary JSON results.
function request(): ControlSessionRequest {
  return {
    model: { provider: 'codex', id: 'gpt-5.2-codex', aliases: [], source: 'explicit', availability: 'unverified' },
    cwd: '/fixture', persistence: 'provider', env: {}, experimentalApi: true, capabilities: {},
    envelope: {
      filesystem: { readonlyRoots: ['/fixture'], writableRoots: [] },
      authorityEpoch: 'fixture-epoch', network: [], tools: [], executables: [], mcpServers: [],
      environmentVariables: [], settingsPersistence: 'none', enforcedBy: ['sandbox'], permissionModeCeiling: 'plan',
    },
  };
}

async function fixture(handler: CodexDynamicToolDefinition['handler'], experimentalApi = true) {
  let hooks: CodexTransportStartOptions | undefined;
  let calls = 0;
  const session = await openCodexControlSession({ ...request(), experimentalApi }, {
    tools: [{ name: 'lookup', description: 'fixture lookup', inputSchema: { type: 'object' },
      timeoutMs: 1000, maxOutputBytes: 4096, handler: async (input, context) => { calls += 1; return handler(input, context); } }],
    startTransport: async options => {
      hooks = options;
      return { request: async (method) => ({ thread: { id: method === 'thread/fork' ? 'sibling-thread' : 'fixture-thread' } }), close: async () => undefined };
    },
  });
  return {
    session,
    calls: () => calls,
    disconnect: () => hooks!.onUnexpectedExit(),
    terminal: (threadId='fixture-thread') => hooks!.onNotification('turn/completed',{threadId,turn:{id:'fixture-turn',status:'completed',items:[]}}),
    call: (input: unknown = {}, threadId='fixture-thread') => hooks!.onServerRequest('item/tool/call', {
      threadId, turnId: 'fixture-turn', callId: 'fixture-call',
      tool: 'lookup', arguments: input,
    }, 'fixture-rpc'),
  };
}

describe('Codex dynamic tool response contract through the registered factory', () => {
  it.each([
    [{ value: 'found:alpha' }, '{"value":"found:alpha"}'],
    ['found:alpha', 'found:alpha'],
    [null, 'null'],
    [undefined, 'null'],
  ])('encodes a successful host result as protocol content (%j)', async (result, text) => {
    const f = await fixture(async () => result);
    try {
      await expect(f.call()).resolves.toEqual({ success: true, contentItems: [{ type: 'inputText', text }] });
      expect(f.calls()).toBe(1);
    } finally { await f.session.close(); }
  });

  it('keeps a thrown handler failure on the error channel', async () => {
    const f = await fixture(async () => { throw new Error('fixture failure'); });
    try {
      await expect(f.call()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', message: 'fixture failure' });
      expect(f.calls()).toBe(1);
    } finally { await f.session.close(); }
  });

  it('rejects invalid input without running the handler', async () => {
    const f = await fixture(async () => 'must not run');
    try {
      await expect(f.call('not an object')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      expect(f.calls()).toBe(0);
    } finally { await f.session.close(); }
  });

  it('does not turn transport cancellation into a successful response', async () => {
    let handlerSignal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    const f = await fixture(async (_input, context) => {
      handlerSignal = context.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    try {
      const response = f.call();
      const rejected = expect(response).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      f.disconnect();
      finish('late result');
      await rejected;
      expect(handlerSignal?.aborted).toBe(true);
      expect(f.calls()).toBe(1);
    } finally { await f.session.close(); }
  });

  it('refuses a dynamic tool before invocation without the experimental gate', async () => {
    let calls = 0;
    await expect(fixture(async () => { calls += 1; }, false))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls).toBe(0);
  });
});

it('retires one thread tool at terminal without aborting a sibling thread', async () => {
  const signals: AbortSignal[]=[];
  const f=await fixture(async(_input,context)=>{signals.push(context.signal);return new Promise(()=>{});});
  const child=await f.session.fork({});
  try {
    await f.session.startTurn({input:'one'});await child.startTurn({input:'two'});
    const one=f.call();const oneRejected=expect(one).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
    const two=f.call({},'sibling-thread');const twoRejected=expect(two).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
    f.terminal();await oneRejected;
    expect(signals[0]?.aborted).toBe(true);expect(signals[1]?.aborted).toBe(false);
    expect(f.session.state()).toBe('unknown');
    await expect(f.session.startTurn({input:'unsafe'})).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
    await child.close();await twoRejected;expect(signals[1]?.aborted).toBe(true);
  } finally {await child.close();await f.session.close();}
});
