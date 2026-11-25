import { describe, it, expect } from 'vitest';
import { createClaudeToolServer } from '../../src/adapters/claude-control/tools.js';
import { ApplicationToolRegistry } from '../../src/tools/registry.js';
import type { SdkMcpServerConfig, ClaudeAgentSdk } from '../../src/adapters/claude-control/sdk.js';
const scope = { provider: 'claude', transport: 'control' as const, cwd: '/tmp', sessionId: 'session', turnId: 'turn', authorityEpoch: 'authority' };
describe('Claude exact JSON Schema application tool binding', () => {
  it('registers public MCP handlers preserving oneOf, refs, constraints and JSON output', async () => {
    const handlers = new Map<unknown, (request: any, extra: any) => Promise<any>>();
    const list = {}; const call = {}; let createOptions: unknown;
    const schema = { type: 'object', $defs: { value: { type: 'string', pattern: '^ok$' } }, properties: { value: { $ref: '#/$defs/value' } }, required: ['value'], additionalProperties: false };
    const registry = new ApplicationToolRegistry([{ name: 'read_note', description: 'read', inputSchema: schema, timeoutMs: 100, maxOutputBytes: 100, authorize: () => true, execute: (_i, ctx) => ({ call: ctx.scope.callId }) }]);
    const sdk = { createSdkMcpServer: (opts: unknown) => { createOptions = opts; return { type: 'sdk', name: 'oar_application', instance: { server: { setRequestHandler: (key: unknown, handler: any) => { handlers.set(key, handler); } } } } as SdkMcpServerConfig; } } as unknown as ClaudeAgentSdk;
    const server = await createClaudeToolServer(sdk, registry, () => ({ signal: new AbortController().signal, scope }), async () => ({ ListToolsRequestSchema: list, CallToolRequestSchema: call }));
    expect(server.name).toBe('oar_application'); expect(createOptions).toEqual({ name: 'oar_application', version: '1.0.0', tools: [] });
    expect((await handlers.get(list)!({}, {})).tools[0].inputSchema).toEqual(schema);
    const response = await handlers.get(call)!({ params: { name: 'read_note', arguments: { value: 'ok' } } }, { requestId: 'call-1', signal: new AbortController().signal });
    expect(response).toEqual({ content: [{ type: 'text', text: '{"call":"call-1"}' }] });
    const invalid = await handlers.get(call)!({ params: { name: 'read_note', arguments: { value: 'secret' } } }, { signal: new AbortController().signal });
    expect(invalid.isError).toBe(true); expect(JSON.stringify(invalid)).not.toContain('secret');
  });
  it('reports an absent public SDK MCP surface before query submission', async () => {
    await expect(createClaudeToolServer({} as ClaudeAgentSdk, new ApplicationToolRegistry([]), () => ({ signal: new AbortController().signal, scope }))).rejects.toMatchObject({ code: 'REQUIRED_TRANSPORT_UNAVAILABLE' });
  });
});

import { ClaudeControlSession } from '../../src/adapters/claude-control/session.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
it('binds Agent tools to the active Claude turn and rejects calls after terminal', async () => {
  const handlers = new Map<unknown, any>(); const list = {}; const call = {}; let queryOptions: any; let observed: any;
  const sdk: ClaudeAgentSdk = {
    createSdkMcpServer: () => ({ type: 'sdk', name: 'oar_application', instance: { server: { setRequestHandler: (key, handler) => { handlers.set(key, handler); } } } }),
    query({ prompt, options }) {
      queryOptions = options;
      const generator = (async function* () {
        for await (const _user of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'native-claude' };
          expect(await options!.canUseTool!('mcp__oar_application__read_note', {}, { signal: new AbortController().signal })).toMatchObject({ behavior: 'allow' });
          await handlers.get(call)({ params: { name: 'read_note', arguments: {} } }, { requestId: 'mcp-call', signal: new AbortController().signal });
          yield { type: 'result', subtype: 'success', result: 'ok' };
        }
      })();
      return Object.assign(generator, { close: () => { void generator.return(undefined); }, interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {} });
    },
  };
  const session = new ClaudeControlSession({ sessionId: 'local', cwd: '/tmp', persistence: 'process', sdk,
    broker: new InteractionBroker({ provider: 'claude', epoch: 'transport' }), authorityEpoch: 'authority',
    tools: [{ name: 'read_note', description: 'read', inputSchema: { type: 'object' }, timeoutMs: 100, maxOutputBytes: 100, authorize: (_i, context) => { observed = context; return true; }, execute: () => null }],
    loadMcpSchemas: async () => ({ ListToolsRequestSchema: list, CallToolRequestSchema: call }),
  });
  await session.send('use tool', { timeoutMs: 100 });
  expect(queryOptions.mcpServers.oar_application.type).toBe('sdk');
  expect(observed.scope).toMatchObject({ sessionId: 'native-claude', turnId: 'turn-0', callId: 'mcp-call', authorityEpoch: 'authority' });
  expect(observed.deadline).toBeGreaterThan(Date.now());
  expect(await handlers.get(call)({ params: { name: 'read_note', arguments: {} } }, {})).toMatchObject({ isError: true });
  await session.close();
});

import { ClaudeToolLifecycle } from '../../src/adapters/claude-control/tool-lifecycle.js';
it('refuses Claude reuse until a timed out callback actually settles', async () => {
  const handlers = new Map<unknown, any>(); const list = {}; const call = {}; let finish!: () => void;
  const lifecycle = new ClaudeToolLifecycle([{ name: 'read_note', description: 'read', inputSchema: { type: 'object' }, timeoutMs: 10, maxOutputBytes: 100, authorize: () => true, execute: () => new Promise<void>(resolve => { finish = resolve; }) }], () => scope, async () => ({ ListToolsRequestSchema: list, CallToolRequestSchema: call }));
  await lifecycle.server({ createSdkMcpServer: () => ({ type: 'sdk', name: 'oar_application', instance: { server: { setRequestHandler: (key: unknown, handler: any) => { handlers.set(key, handler); } } } }) } as unknown as ClaudeAgentSdk);
  lifecycle.start(100);
  expect(await handlers.get(call)({ params: { name: 'read_note', arguments: {} } }, {})).toMatchObject({ isError: true });
  lifecycle.end(); expect(() => lifecycle.start(100)).toThrow();
  finish(); await Promise.resolve(); await Promise.resolve();
  lifecycle.start(100); expect(lifecycle.ownsSdkName('mcp__oar_application__not_registered')).toBe(false); lifecycle.end();
});

it('retires Claude tool authority at native terminal while its public output is paused', async () => {
  const handlers = new Map<unknown, any>(), list = {}, call = {};
  let markStarted!: () => void, finish!: () => void, markTerminal!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const terminal = new Promise<void>(resolve => { markTerminal = resolve; });
  let signal: AbortSignal | undefined, execution: Promise<unknown> | undefined;
  const sdk: ClaudeAgentSdk = {
    createSdkMcpServer: () => ({ type: 'sdk', name: 'oar_application', instance: { server: { setRequestHandler: (key, handler) => { handlers.set(key, handler); } } } }),
    query({ prompt }) {
      const generator = (async function* () {
        for await (const _user of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'native-claude' };
          execution = handlers.get(call)({ params: { name: 'read_note', arguments: {} } }, {}); void execution?.catch(() => undefined);
          await started;
          yield { type: 'result', subtype: 'success', result: 'done' }; markTerminal();
        }
      })();
      return Object.assign(generator, { interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {} });
    },
  };
  const session = new ClaudeControlSession({ sessionId: 'local', cwd: '/tmp', persistence: 'process', sdk,
    broker: new InteractionBroker({ provider: 'claude', epoch: 'transport' }),
    tools: [{ name: 'read_note', description: 'read', inputSchema: { type: 'object' }, timeoutMs: 3000, maxOutputBytes: 100,
      authorize: () => true, execute: (_input, context) => { signal = context.signal; markStarted(); return new Promise<void>(resolve => { finish = resolve; }); } }],
    loadMcpSchemas: async () => ({ ListToolsRequestSchema: list, CallToolRequestSchema: call }),
  });
  const iterator = session.stream('fixture')[Symbol.asyncIterator]();
  await iterator.next(); await terminal;
  try {
    expect(signal?.aborted).toBe(true);
    await expect(execution).resolves.toMatchObject({ isError: true });
    expect(await handlers.get(call)({ params: { name: 'read_note', arguments: {} } }, {})).toMatchObject({ isError: true });
    for (;;) { if ((await iterator.next()).done) break; }
    await expect(session.send('overlap with uncooperative callback')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  } finally { finish(); await iterator.return?.(undefined); await session.close(); }
});
