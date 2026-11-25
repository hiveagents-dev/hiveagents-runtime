import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MCP_LEGACY_VERSIONS, MCP_SUPPORTED_VERSIONS, memoryMcpRecipe, serveMemoryMcp, type MemoryMcpLogEntry, type MemoryMcpServerOptions,
} from '../../src/memory-tools/index.js';
import { claudeMcpConfig } from '../../src/orchestration/memory/index.js';
import type { AgentMemoryProvider, MemoryProposeRequest, MemoryRecallRequest } from '../../src/public/memory-types.js';

const SCOPE = Object.freeze({ tenant: 'acme', namespace: 'agents', subject: 'grow' });
const MODERN_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

/** A server over in-memory streams, and a client that reads every output line as JSON. */
function harness(options: Partial<MemoryMcpServerOptions> = {}, memory?: Partial<AgentMemoryProvider>) {
  const recalls: MemoryRecallRequest[] = [];
  const proposals: MemoryProposeRequest[] = [];
  const provider: AgentMemoryProvider = {
    id: 'test-memory',
    recall: async (request) => { recalls.push(request); return [{ id: 'm1', source: 'store', text: 'remembered' }]; },
    propose: async (request) => { proposals.push(request); return { id: 'cand-1' }; },
    ...memory,
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: MemoryMcpLogEntry[] = [];
  const raw: string[] = [];
  let buffered = '';
  const waiters: Array<() => void> = [];
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) { raw.push(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1); }
    waiters.splice(0).forEach((wake) => wake());
  });
  const server = serveMemoryMcp({ provider, scope: SCOPE, input, output, log: (entry) => logs.push(entry), agentProvider: 'claude', cwd: '/work', ...options });
  let read = 0;
  async function next(): Promise<Record<string, any>> {
    while (raw.length <= read) await new Promise<void>((wake) => waiters.push(wake));
    return JSON.parse(raw[read++]!) as Record<string, any>;
  }
  const send = (message: unknown) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  async function request(message: Record<string, unknown>) { send({ jsonrpc: '2.0', ...message }); return next(); }
  async function initialize(protocolVersion = '2025-11-25') {
    const response = await request({ id: 0, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  }
  return { server, input, output, logs, raw, recalls, proposals, next, send, request, initialize, pending: () => raw.length - read };
}

describe('serveMemoryMcp: lifecycle', () => {
  it.each(MCP_LEGACY_VERSIONS)('answers initialize %s with the same version', async (version) => {
    const client = harness();
    const response = await client.initialize(version);
    expect(response).toEqual({ jsonrpc: '2.0', id: 0, result: {
      protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'oar-memory', version: '1.0.0' },
      instructions: expect.stringMatching(/reference data/),
    } });
    await client.server.close();
  });

  it('answers an unsupported requested version with its latest legacy version', async () => {
    const client = harness();
    expect((await client.initialize('1999-01-01')).result.protocolVersion).toBe('2025-11-25');
    await client.server.close();
    const modern = harness();
    expect((await modern.initialize('2026-07-28')).result.protocolVersion).toBe('2025-11-25');
    await modern.server.close();
  });

  it('refuses tool requests before initialize and a second initialize', async () => {
    const client = harness();
    expect(await client.request({ id: 1, method: 'tools/list' })).toMatchObject({ id: 1, error: { code: -32600, data: { supported: [...MCP_SUPPORTED_VERSIONS] } } });
    expect(await client.request({ id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    await client.initialize();
    expect(await client.request({ id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).toMatchObject({ id: 3, error: { code: -32600 } });
    await client.server.close();
  });

  it('closes when the input ends, and writes nothing but JSON-RPC lines', async () => {
    const client = harness({ propose: true });
    await client.initialize();
    await client.request({ id: 1, method: 'tools/list' });
    await client.request({ id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
    client.send('not json');
    await client.next();
    client.input.end();
    await client.server.closed;
    for (const line of client.raw) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(client.logs.some((entry) => entry.message.includes('input ended'))).toBe(true);
    expect(JSON.stringify(client.logs)).not.toContain('not json');
  });

  it('answers the calls it already received when the input ends, then closes', async () => {
    let release!: () => void;
    const client = harness({}, { recall: () => new Promise((resolve) => { release = () => resolve([{ id: 'late', source: 's', text: 'late item' }]); }) });
    await client.initialize();
    client.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
    client.input.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    let closed = false;
    void client.server.closed.then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(closed).toBe(false);
    release();
    expect((await client.next())).toMatchObject({ id: 7, result: { structuredContent: { items: [{ id: 'late' }] } } });
    await client.server.closed;
  });

  it('cancels a running call on close and sends nothing after it', async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const client = harness({}, { recall: (request) => { started(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))); } });
    await client.initialize();
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
    await begun;
    await client.server.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.pending()).toBe(0);
  });
});

describe('serveMemoryMcp: tools', () => {
  it('lists the tools with JSON Schema inputs, titles from 2025-06-18 on, and propose only when offered', async () => {
    const client = harness();
    await client.initialize('2025-06-18');
    const listed = await client.request({ id: 1, method: 'tools/list' });
    expect(listed.result.tools).toEqual([{ name: 'memory_search', title: 'Search memory', description: expect.any(String), inputSchema: expect.objectContaining({ type: 'object', required: ['query'], additionalProperties: false }) }]);
    await client.server.close();
    const old = harness({ propose: true });
    await old.initialize('2024-11-05');
    const tools = (await old.request({ id: 1, method: 'tools/list' })).result.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(['memory_search', 'memory_propose']);
    expect(tools.every((tool) => !('title' in tool))).toBe(true);
    await old.server.close();
  });

  it('calls memory_search with the fixed scope and returns text plus structuredContent', async () => {
    const client = harness();
    await client.initialize();
    const response = await client.request({ id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'terms', limit: 1 } } });
    const expected = { notice: expect.stringMatching(/not instructions/), items: [{ id: 'm1', source: 'store', text: 'remembered' }], omitted: 0 };
    expect(response.result.structuredContent).toEqual(expected);
    expect(JSON.parse(response.result.content[0].text)).toEqual(expected);
    expect(response.result.content[0].type).toBe('text');
    expect(response.result.isError).toBeUndefined();
    expect(client.recalls[0]).toMatchObject({ scope: SCOPE, text: 'terms', limit: 1, provider: 'claude', transport: 'exec', cwd: '/work' });
    await client.server.close();
  });

  it('omits structuredContent before 2025-06-18', async () => {
    const client = harness();
    await client.initialize('2025-03-26');
    const response = await client.request({ id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
    expect(response.result).not.toHaveProperty('structuredContent');
    await client.server.close();
  });

  it('reports a tool failure as isError with a bounded message, and a scope argument as invalid input', async () => {
    const client = harness({}, { recall: async () => { throw new Error('db password hunter2'); } });
    await client.initialize();
    const failed = await client.request({ id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
    expect(failed.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'PROVIDER_FAILED' } } });
    expect(JSON.stringify(failed)).not.toContain('hunter2');
    expect(client.logs).toContainEqual({ level: 'error', message: 'memory provider failed: Error' });
    expect(JSON.stringify(client.logs)).not.toContain('hunter2');
    const widened = await client.request({ id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x', scope: { tenant: 'other' } } } });
    expect(widened.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await client.server.close();
  });

  it('logs a provider error only as its class name, never its message, its fields or the client input', async () => {
    const SECRET = 'customer card 4111-1111-1111-1111';
    const onError: unknown[] = [];
    const client = harness({ onError: (error) => onError.push(error) }, {
      recall: async (request) => { throw Object.assign(new Error(`no lesson matches "${request.text}"`), { code: 'SQLITE_BUSY' }); },
      propose: async (request) => { throw Object.assign(new TypeError(`refused ${request.text}`), { code: request.text }); },
    });
    await client.initialize();
    await client.request({ id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: SECRET } } });
    const proposing = harness({ propose: true, onError: (error) => onError.push(error) }, {
      propose: async (request) => { throw Object.assign(new TypeError(`refused ${request.text}`), { code: request.text }); },
    });
    await proposing.initialize();
    await proposing.request({ id: 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { text: 'CARD_4111' } } });
    expect(client.logs).toContainEqual({ level: 'error', message: 'memory provider failed: Error' });
    expect(proposing.logs).toContainEqual({ level: 'error', message: 'memory provider failed: TypeError' });
    const logged = JSON.stringify([...client.logs, ...proposing.logs]);
    expect(logged).not.toContain('4111');
    expect(logged).not.toMatch(/lesson|refused|SQLITE_BUSY|CARD/);
    expect(onError).toHaveLength(2);
    await client.server.close();
    await proposing.server.close();
  });

  it('a persistence-only provider (propose, no recall) serves memory_propose alone', async () => {
    const noRecall = { recall: undefined } as unknown as Partial<AgentMemoryProvider>;
    const client = harness({ propose: true }, noRecall);
    await client.initialize();
    const listed = await client.request({ id: 1, method: 'tools/list' });
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['memory_propose']);
    expect(await client.request({ id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } })).toMatchObject({ error: { code: -32602, message: 'Unknown tool' } });
    expect((await client.request({ id: 3, method: 'tools/call', params: { name: 'memory_propose', arguments: { text: 'likes tea' } } })).result.structuredContent).toMatchObject({ status: 'candidate' });
    await client.server.close();
    expect(() => harness({}, noRecall)).toThrow(/recall function, or propose: true/);
  });

  it('proposes with origin mcp:<name> only when offered', async () => {
    const client = harness({ propose: true, name: 'grow-memory' });
    await client.initialize();
    const response = await client.request({ id: 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { text: 'likes tea' } } });
    expect(response.result.structuredContent).toEqual({ id: 'cand-1', status: 'candidate', notice: 'not recallable until the application promotes it' });
    expect(client.proposals[0]).toMatchObject({ scope: SCOPE, text: 'likes tea', origin: 'mcp:grow-memory' });
    await client.server.close();
    const readOnly = harness();
    await readOnly.initialize();
    expect(await readOnly.request({ id: 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { text: 'x' } } })).toMatchObject({ error: { code: -32602, message: 'Unknown tool' } });
    await readOnly.server.close();
  });

  it('refuses unknown tools and malformed call params as protocol errors', async () => {
    const client = harness();
    await client.initialize();
    expect(await client.request({ id: 1, method: 'tools/call', params: { name: 'rm_rf' } })).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(await client.request({ id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: 'x' } })).toMatchObject({ id: 2, error: { code: -32602 } });
    expect(await client.request({ id: 3, method: 'tools/call', params: [] })).toMatchObject({ id: 3, error: { code: -32602 } });
    await client.server.close();
  });

  it('runs at most maxConcurrency calls at once and drops a cancelled one without a response', async () => {
    let running = 0, peak = 0;
    const releases: Array<() => void> = [];
    const client = harness({ maxConcurrency: 2 }, { recall: () => { running += 1; peak = Math.max(peak, running); return new Promise((resolve) => releases.push(() => { running -= 1; resolve([]); })); } });
    await client.initialize();
    for (let id = 1; id <= 4; id += 1) client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBe(2);
    while (releases.length > 0 || running > 0) { releases.splice(0).forEach((release) => release()); await new Promise((resolve) => setTimeout(resolve, 5)); }
    const ids = [(await client.next()).id, (await client.next()).id, (await client.next()).id].sort();
    expect(ids).toEqual([1, 2, 3]);
    expect(peak).toBe(2);
    expect(client.pending()).toBe(0);
    await client.server.close();
  });
});

describe('serveMemoryMcp: JSON-RPC framing', () => {
  it('answers malformed JSON with -32700, unknown methods with -32601, and invalid requests with -32600', async () => {
    const client = harness();
    client.send('{"jsonrpc":"2.0",');
    expect(await client.next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    await client.initialize();
    expect(await client.request({ id: 'a', method: 'resources/list' })).toMatchObject({ id: 'a', error: { code: -32601 } });
    client.send({ id: 5, method: 'ping' });
    expect(await client.next()).toMatchObject({ id: 5, error: { code: -32600 } });
    client.send({ jsonrpc: '2.0', id: null, method: 'ping' });
    expect(await client.next()).toMatchObject({ id: null, error: { code: -32600 } });
    client.send('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
    expect(await client.next()).toMatchObject({ id: null, error: { code: -32600 } });
    client.send({ jsonrpc: '2.0', method: 'notifications/unknown' });
    client.send({ jsonrpc: '2.0', id: 9, result: {} });
    expect(await client.request({ id: 10, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 10, result: {} });
    await client.server.close();
  });

  it('refuses an oversized line without reading it and keeps serving', async () => {
    const client = harness({ maxLineBytes: 1024 });
    await client.initialize();
    client.input.write(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${'x'.repeat(600)}`);
    client.input.write(`${'y'.repeat(600)}"}}\n`);
    expect(await client.next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message exceeds 1024 bytes' } });
    expect(await client.request({ id: 2, method: 'ping' })).toMatchObject({ id: 2, result: {} });
    expect(JSON.stringify(client.logs)).not.toContain('xxxx');
    await client.server.close();
  });

  it('accepts CRLF and split chunks, and answers a 2025-03-26 batch with one array', async () => {
    const client = harness();
    const line = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
    client.input.write(line.slice(0, 10));
    client.input.write(`${line.slice(10)}\r\n`);
    expect((await client.next()).result.protocolVersion).toBe('2025-03-26');
    client.send([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const batch = await client.next() as unknown as Array<Record<string, unknown>>;
    expect(batch.map((entry) => entry.id)).toEqual([1, 2]);
    await client.server.close();
  });
});

describe('serveMemoryMcp: bounds and back-pressure', () => {
  const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } });
  const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A recall that answers only when released. */
  function held() {
    const releases: Array<() => void> = [];
    let started = 0;
    const recall = () => { started += 1; return new Promise<never[]>((resolve) => releases.push(() => resolve([]))); };
    return { recall, releases, started: () => started, releaseAll: () => releases.splice(0).forEach((release) => release()) };
  }

  it('refuses a 2025-03-26 batch over 64 messages whole, and answers one of 64', async () => {
    const client = harness();
    await client.initialize('2025-03-26');
    const pings = (count: number) => Array.from({ length: count }, (_, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'ping' }));
    client.send(pings(65));
    expect(await client.next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch exceeds 64 messages' } });
    client.send(pings(64));
    expect(((await client.next()) as unknown as unknown[]).length).toBe(64);
    await client.server.close();
  });

  it('refuses a call past 32 waiting per slot with -32000; the batch answers the rest', async () => {
    const memory = held();
    const client = harness({ maxConcurrency: 1 }, { recall: memory.recall });
    await client.initialize('2025-03-26');
    client.send(Array.from({ length: 64 }, (_, index) => call(index + 1)));
    await tick();
    expect(memory.started()).toBe(1);
    while (client.pending() === 0) { memory.releaseAll(); await tick(1); }
    const batch = await client.next() as unknown as Array<Record<string, any>>;
    const busy = batch.filter((entry) => entry.error?.code === -32000);
    expect(busy.map((entry) => entry.id)).toEqual(Array.from({ length: 31 }, (_, index) => index + 34));
    expect(busy[0]!.error.message).toMatch(/busy/);
    expect(batch.filter((entry) => entry.result).length).toBe(33);
    expect(memory.started()).toBe(33);
    expect(client.logs.some((entry) => entry.message.includes('too many calls waiting'))).toBe(true);
    await client.server.close();
  });

  it('stops reading a chunk once 16 calls per slot wait, and reads the rest as they drain', async () => {
    const memory = held();
    const client = harness({ maxConcurrency: 1 }, { recall: memory.recall });
    await client.initialize();
    const lines = Array.from({ length: 40 }, (_, index) => JSON.stringify(call(index + 1)));
    client.input.write(`${[...lines, JSON.stringify({ jsonrpc: '2.0', id: 'last', method: 'ping' })].join('\n')}\n`);
    await tick(10);
    // 1 running and 16 waiting: the ping after them in the same chunk is not read yet.
    expect(memory.started()).toBe(1);
    expect(client.pending()).toBe(0);
    const ids: unknown[] = [];
    while (ids.length < 41) {
      memory.releaseAll();
      await tick(1);
      while (client.pending() > 0) ids.push((await client.next()).id);
    }
    expect(ids.filter((id) => typeof id === 'number').sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(ids).toContain('last');
    expect(memory.started()).toBe(40);
    await client.server.close();
  });

  it('stops reading while the output is not drained (a slow consumer), then reads on after drain', async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const pendingWrites: Array<() => void> = [];
    const output = new Writable({ highWaterMark: 16, write(chunk: Buffer, _encoding, callback) { written.push(chunk.toString('utf8')); pendingWrites.push(() => callback()); } });
    let recalls = 0;
    const server = serveMemoryMcp({ provider: { id: 'p', recall: async () => { recalls += 1; return []; } }, scope: SCOPE, input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })}\n`);
    await tick();
    expect(written).toHaveLength(1);
    // The initialize response is over the 16-byte buffer and the consumer has not taken it: write() returned false.
    input.write(`${[1, 2, 3, 4, 5].map((id) => JSON.stringify(call(id))).join('\n')}\n`);
    await tick(20);
    expect(recalls).toBe(0);
    while (written.length < 6) { pendingWrites.splice(0).forEach((done) => done()); await tick(1); }
    expect(recalls).toBe(5);
    expect(written.slice(1).map((line) => JSON.parse(line).id)).toEqual([1, 2, 3, 4, 5]);
    pendingWrites.splice(0).forEach((done) => done());
    await server.close();
  });
});

describe('serveMemoryMcp: 2026-07-28 per-request metadata', () => {
  it('serves server/discover, ping, tools/list and tools/call statelessly with resultType', async () => {
    const client = harness();
    const discover = await client.request({ id: 1, method: 'server/discover', params: { _meta: MODERN_META } });
    expect(discover.result).toEqual({
      resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, instructions: expect.any(String),
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'oar-memory', version: '1.0.0' } },
    });
    expect((await client.request({ id: 2, method: 'ping', params: { _meta: MODERN_META } })).result.resultType).toBe('complete');
    const listed = await client.request({ id: 3, method: 'tools/list', params: { _meta: MODERN_META } });
    expect(listed.result.tools[0]).toMatchObject({ name: 'memory_search', title: 'Search memory' });
    const called = await client.request({ id: 4, method: 'tools/call', params: { _meta: MODERN_META, name: 'memory_search', arguments: { query: 'x' } } });
    expect(called.result).toMatchObject({ resultType: 'complete', structuredContent: { items: [{ id: 'm1' }] } });
    await client.server.close();
  });

  it('answers an unsupported version with -32022 and missing capabilities with -32602', async () => {
    const client = harness();
    const unsupported = await client.request({ id: 1, method: 'tools/list', params: { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
    expect(unsupported.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: [...MCP_SUPPORTED_VERSIONS], requested: '1900-01-01' } });
    const missing = await client.request({ id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    expect(missing.error.code).toBe(-32602);
    await client.server.close();
  });
});

describe('serveMemoryMcp options and memoryMcpRecipe', () => {
  it('refuses bad options at construction', () => {
    const input = new PassThrough(), output = new PassThrough();
    const provider = { id: 'p', recall: async () => [] };
    expect(() => serveMemoryMcp({ provider, scope: SCOPE, input, output, propose: true })).toThrow(/propose function/);
    expect(() => serveMemoryMcp({ provider, scope: SCOPE, input, output, name: 'bad name' })).toThrow(/name/);
    expect(() => serveMemoryMcp({ provider, scope: SCOPE, input, output, maxLineBytes: 10 })).toThrow(/maxLineBytes/);
    expect(() => serveMemoryMcp({ provider, scope: SCOPE, input, output, extra: 1 } as never)).toThrow(/unknown field/);
  });

  it('builds a recipe claudeMcpConfig accepts', () => {
    const recipe = memoryMcpRecipe({ name: 'grow-memory', executable: '/usr/local/bin/node', script: '/opt/app/memory-server.mjs', env: { MEMORY_DB: '/var/app/grow.db' } });
    expect(recipe).toEqual({ name: 'grow-memory', command: '/usr/local/bin/node', args: ['/opt/app/memory-server.mjs'], env: { MEMORY_DB: '/var/app/grow.db' } });
    expect(Object.isFrozen(recipe) && Object.isFrozen(recipe.args) && Object.isFrozen(recipe.env)).toBe(true);
    expect(JSON.parse(claudeMcpConfig([recipe]))).toEqual({ mcpServers: { 'grow-memory': { command: '/usr/local/bin/node', args: ['/opt/app/memory-server.mjs'], env: { MEMORY_DB: '/var/app/grow.db' } } } });
    expect(memoryMcpRecipe({ executable: 'C:\\node\\node.exe', script: 'C:/app/server.mjs' }).name).toBe('oar-memory');
    expect(() => memoryMcpRecipe({ executable: 'node', script: '/opt/s.mjs' })).toThrow(/absolute/);
    expect(() => memoryMcpRecipe({ executable: '/bin/node', script: 'server.mjs' })).toThrow(/absolute/);
    expect(() => memoryMcpRecipe({ executable: '/bin/node', script: '/s.mjs', env: { 'BAD-NAME': 'x' } })).toThrow(/env/);
    expect(() => memoryMcpRecipe({ executable: '/bin/node', script: '/s.mjs', version: '1.0.0' } as never)).toThrow(/do not accept/);
  });
});
