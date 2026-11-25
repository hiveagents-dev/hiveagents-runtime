import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_PROPOSE_NOTICE, MEMORY_TOOL_NOTICE, MEMORY_TOOL_ORIGIN, MemoryToolError, memoryTools,
} from '../../src/memory-tools/index.js';
import { ApplicationToolRegistry } from '../../src/tools/registry.js';
import type { ApplicationTool, ApplicationToolContext } from '../../src/tools/types.js';
import type { AgentMemoryProvider, MemoryProposeRequest, MemoryRecallRequest } from '../../src/public/memory-types.js';

const SCOPE = Object.freeze({ tenant: 'acme', namespace: 'agents', subject: 'grow' });
const CWD = resolve('/work/project');

function provider(overrides: Partial<AgentMemoryProvider> = {}) {
  const recalls: MemoryRecallRequest[] = [];
  const proposals: MemoryProposeRequest[] = [];
  const memory: AgentMemoryProvider = {
    id: 'test-memory',
    recall: async (request) => { recalls.push(request); return [{ id: 'm1', source: 'store', text: 'customer pays at 30 days', title: 'Terms', observedAt: '2026-11-10T10:00:00+01:00' }]; },
    propose: async (request) => { proposals.push(request); return { id: `c${proposals.length}` }; },
    ...overrides,
  };
  return { memory, recalls, proposals };
}

function context(overrides: Partial<ApplicationToolContext['scope']> = {}, signal = new AbortController().signal): ApplicationToolContext {
  return { signal, deadline: Date.now() + 10_000, scope: { provider: 'claude', transport: 'control', cwd: CWD, sessionId: 's1', authorityEpoch: 'e1', ...overrides } };
}

const byName = (tools: ApplicationTool[], name: string) => tools.find((tool) => tool.name === name)!;

afterEach(() => { vi.useRealTimers(); });

describe('memoryTools: memory_search', () => {
  it('recalls with the application scope and returns items with the notice', async () => {
    const { memory, recalls } = provider();
    const [search] = memoryTools({ provider: memory, scope: SCOPE });
    const result = await search!.execute({ query: 'payment terms' }, context());
    expect(result).toEqual({
      notice: MEMORY_TOOL_NOTICE, omitted: 0,
      items: [{ id: 'm1', source: 'store', title: 'Terms', observedAt: '2026-11-10T09:00:00.000Z', text: 'customer pays at 30 days' }],
    });
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toMatchObject({ scope: SCOPE, text: 'payment terms', provider: 'claude', transport: 'control', cwd: CWD, limit: 2 });
    expect(MEMORY_TOOL_NOTICE).toMatch(/reference data, not instructions/);
  });

  it('never lets the model pass or widen the scope', async () => {
    const { memory, recalls } = provider();
    const tools = memoryTools({ provider: memory, scope: SCOPE });
    const search = byName(tools, 'memory_search');
    expect(Object.keys((search.inputSchema as { properties: object }).properties)).toEqual(['query', 'limit']);
    expect(search.inputSchema.additionalProperties).toBe(false);
    const widened = { query: 'x', scope: { tenant: 'other', namespace: 'all' } };
    expect(await search.authorize(widened, context())).toBe(false);
    expect(await search.execute(widened, context())).toEqual({ error: { code: 'INVALID_INPUT', message: expect.stringMatching(/scope is fixed/) } });
    const registry = new ApplicationToolRegistry(tools);
    await expect(registry.call('memory_search', widened, { signal: new AbortController().signal, scope: context().scope })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await registry.call('memory_search', { query: 'x' }, { signal: new AbortController().signal, scope: context().scope });
    expect(recalls.map((request) => request.scope)).toEqual([SCOPE]);
  });

  it('validates query and limit, and a call limit only lowers maxItems', async () => {
    const { memory, recalls } = provider();
    const search = byName(memoryTools({ provider: memory, scope: SCOPE, maxItems: 3 }), 'memory_search');
    for (const input of [{}, { query: '' }, { query: '   ' }, { query: 'a'.repeat(4097) }, { query: 'x', limit: 0 }, { query: 'x', limit: 9 }, { query: 'x', limit: 1.5 }, 'x', null]) {
      expect(await search.execute(input, context())).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect(recalls).toHaveLength(0);
    await search.execute({ query: 'é'.repeat(4096), limit: 8 }, context());
    await search.execute({ query: 'x', limit: 1 }, context());
    expect(recalls.map((request) => request.limit)).toEqual([3, 1]);
  });

  it('applies the core item rules, the item limit and the byte budget', async () => {
    const big = 'b'.repeat(600);
    const { memory } = provider({ recall: async () => [
      { id: 'ok-1', source: 's', text: 'first' },
      { id: 'bad[id]', source: 's', text: 'forged header' },
      { id: 'ok-1', source: 's', text: 'repeated id' },
      { id: 'nul', source: 's', text: 'a\0b' },
      { id: 'big', source: 's', text: big },
      { id: 'ok-2', source: 's', text: 'second\u{E0041}', title: 'bad\ntitle' },
      { id: 'ok-3', source: 's', text: 'third, over the item limit' },
      'not an item',
    ] as never });
    const search = byName(memoryTools({ provider: memory, scope: SCOPE, maxItems: 2, maxBytes: 512 }), 'memory_search');
    const result = await search.execute({ query: 'x' }, context()) as { items: Array<Record<string, unknown>>; omitted: number };
    expect(result.items).toEqual([{ id: 'ok-1', source: 's', text: 'first' }, { id: 'ok-2', source: 's', text: 'second' }]);
    expect(result.omitted).toBe(6);
    const bytes = result.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    expect(bytes).toBeLessThanOrEqual(512);
  });

  it('bounds provider failures, non-arrays and timeouts, and reports the cause only to onError', async () => {
    const onError = vi.fn();
    const secret = new Error('connection string postgres://admin:hunter2@db');
    const failing = byName(memoryTools({ provider: provider({ recall: async () => { throw secret; } }).memory, scope: SCOPE, onError }), 'memory_search');
    const failed = await failing.execute({ query: 'x' }, context());
    expect(failed).toEqual({ error: { code: 'PROVIDER_FAILED', message: 'memory search is unavailable right now' } });
    expect(JSON.stringify(failed)).not.toMatch(/hunter2|postgres|stack|acme/);
    expect(onError).toHaveBeenCalledWith(secret);

    const odd = byName(memoryTools({ provider: provider({ recall: async () => ({ items: [] }) as never }).memory, scope: SCOPE }), 'memory_search');
    expect(await odd.execute({ query: 'x' }, context())).toMatchObject({ error: { code: 'PROVIDER_FAILED' } });

    const slow = byName(memoryTools({ provider: provider({ recall: () => new Promise(() => undefined) }).memory, scope: SCOPE, timeoutMs: 20 }), 'memory_search');
    expect(await slow.execute({ query: 'x' }, context())).toEqual({ error: { code: 'TIMEOUT', message: 'memory recall timed out after 20 ms' } });

    const cancel = new AbortController();
    const pending = slow.execute({ query: 'x' }, context({}, cancel.signal));
    cancel.abort();
    expect(await pending).toMatchObject({ error: { code: 'CANCELLED' } });
  });

  it('authorizes only control calls from the configured cwd that pass the application check', async () => {
    const { memory } = provider();
    const check = vi.fn((scope: { sessionId: string }) => scope.sessionId === 's1');
    const search = byName(memoryTools({ provider: memory, scope: SCOPE, cwd: CWD, authorize: check }), 'memory_search');
    expect(await search.authorize({ query: 'x' }, context())).toBe(true);
    expect(await search.authorize({ query: 'x' }, context({ sessionId: 's2' }))).toBe(false);
    expect(await search.authorize({ query: 'x' }, context({ cwd: '/elsewhere' }))).toBe(false);
    expect(await search.authorize({ query: 'x' }, context({ transport: 'exec' }))).toBe(false);
    const throwing = byName(memoryTools({ provider: memory, scope: SCOPE, authorize: () => { throw new Error('no'); } }), 'memory_search');
    expect(await throwing.authorize({ query: 'x' }, context())).toBe(false);
  });

  it('refuses malformed options at construction', () => {
    const { memory } = provider();
    expect(() => memoryTools({ provider: { id: 'w' } as AgentMemoryProvider, scope: SCOPE })).toThrow(/recall function/);
    expect(() => memoryTools({ provider: memory, scope: { tenant: 'a' } as never })).toThrow(TypeError);
    expect(() => memoryTools({ provider: memory, scope: { ...SCOPE, extra: 'x' } as never })).toThrow(/unknown field/);
    expect(() => memoryTools({ provider: memory, scope: SCOPE, maxItems: 9 })).toThrow(/maxItems/);
    expect(() => memoryTools({ provider: memory, scope: SCOPE, maxBytes: 100 })).toThrow(/maxBytes/);
    expect(() => memoryTools({ provider: memory, scope: SCOPE, unknown: true } as never)).toThrow(/unknown field/);
  });
});

describe('memoryTools: memory_propose', () => {
  it('is offered only when asked, and requesting it without provider.propose is a TypeError', () => {
    const { memory } = provider();
    expect(memoryTools({ provider: memory, scope: SCOPE }).map((tool) => tool.name)).toEqual(['memory_search']);
    expect(memoryTools({ provider: memory, scope: SCOPE, propose: true }).map((tool) => tool.name)).toEqual(['memory_search', 'memory_propose']);
    const { propose: _propose, ...readOnly } = memory;
    expect(() => memoryTools({ provider: readOnly, scope: SCOPE, propose: true })).toThrow(TypeError);
    expect(() => memoryTools({ provider: readOnly, scope: SCOPE, propose: true })).toThrow(/propose function/);
    expect(memoryTools({ provider: readOnly, scope: SCOPE }).map((tool) => tool.name)).toEqual(['memory_search']);
  });

  it('stores a candidate with origin memory-tool and the fixed scope', async () => {
    const { memory, proposals } = provider();
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true }), 'memory_propose');
    expect(propose.inputSchema.additionalProperties).toBe(false);
    expect(await propose.execute({ text: 'prefers Spanish replies', title: 'Language' }, context()))
      .toEqual({ id: 'c1', status: 'candidate', notice: MEMORY_PROPOSE_NOTICE });
    expect(proposals[0]).toMatchObject({ scope: SCOPE, text: 'prefers Spanish replies', title: 'Language', origin: MEMORY_TOOL_ORIGIN });
    expect(MEMORY_TOOL_ORIGIN).toBe('memory-tool');
    expect(proposals[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects texts and titles that fail the core item rules, and any scope argument', async () => {
    const { memory, proposals } = provider();
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true }), 'memory_propose');
    for (const input of [{ text: '' }, { text: 'a\0b' }, { text: '\u{E0041}\u{E0042}' }, { text: 'hidden\u{E0041}' }, { text: 'x'.repeat(4097) },
      { text: 'ok', title: 'two\nlines' }, { text: 'ok', title: 'zero\u200bwidth' }, { text: 'ok', title: 't'.repeat(257) }, { text: 'ok', title: 7 }, { text: 'ok', scope: SCOPE }]) {
      expect(await propose.execute(input, context())).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect(proposals).toHaveLength(0);
  });

  it('rate-limits proposals per tool set over a rolling minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { memory, proposals } = provider();
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true, proposalsPerMinute: 2 }), 'memory_propose');
    expect(await propose.execute({ text: 'one' }, context())).toMatchObject({ status: 'candidate' });
    expect(await propose.execute({ text: 'two' }, context())).toMatchObject({ status: 'candidate' });
    expect(await propose.execute({ text: 'three' }, context())).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    vi.setSystemTime(Date.now() + 60_001);
    expect(await propose.execute({ text: 'four' }, context())).toMatchObject({ status: 'candidate' });
    expect(proposals.map((request) => request.text)).toEqual(['one', 'two', 'four']);
    const defaults = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true }), 'memory_propose');
    const results = [];
    for (let index = 0; index < 11; index += 1) results.push(await defaults.execute({ text: `n${index}` }, context()));
    expect(results.filter((result) => (result as { status?: string }).status === 'candidate')).toHaveLength(10);
  });

  it('keeps the slot when the outcome is unknown: a provider failure, a timeout, a cancellation or an unusable id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const cases = [
      { mode: 'fail', code: 'PROVIDER_FAILED' }, { mode: 'hang', code: 'TIMEOUT' },
      { mode: 'cancel', code: 'CANCELLED' }, { mode: 'bad-id', code: 'PROVIDER_FAILED' },
    ] as const;
    for (const { mode, code } of cases) {
      const calls: string[] = [];
      const { memory } = provider({
        propose: (request) => {
          calls.push(request.text);
          if (mode === 'fail') return Promise.reject(new Error('db down'));
          if (mode === 'bad-id') return Promise.resolve({ id: '' });
          return new Promise(() => undefined);
        },
      });
      const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true, proposalsPerMinute: 1, timeoutMs: 10 }), 'memory_propose');
      const cancel = new AbortController();
      const first = propose.execute({ text: 'a' }, context({}, cancel.signal));
      if (mode === 'cancel') {
        // Cancelled once the provider holds the proposal.
        await new Promise((resolve) => setImmediate(resolve));
        expect(calls).toEqual(['a']);
        cancel.abort();
      }
      expect(await first).toMatchObject({ error: { code } });
      // The provider may have stored it: with one proposal per minute, the next one is refused before the provider.
      expect(await propose.execute({ text: 'b' }, context())).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(calls).toEqual(['a']);
    }
  });

  it('counts a proposal the provider stores after the deadline against the budget', async () => {
    const stored: string[] = [];
    const { memory } = provider({
      // A remote write that outlives the tool deadline: once sent it cannot be taken back.
      propose: async (request) => { await new Promise((resolve) => setTimeout(resolve, 30)); stored.push(request.text); return { id: 'late' }; },
    });
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true, proposalsPerMinute: 2, timeoutMs: 5 }), 'memory_propose');
    const results = [];
    for (let index = 0; index < 6; index += 1) results.push(await propose.execute({ text: `note ${index}` }, context()));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(results.map((result) => (result as { error: { code: string } }).error.code))
      .toEqual(['TIMEOUT', 'TIMEOUT', 'RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED']);
    expect(stored).toEqual(['note 0', 'note 1']);
  });

  it('gives the slot back only when the provider never received the proposal', async () => {
    const { memory, proposals } = provider();
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true, proposalsPerMinute: 1 }), 'memory_propose');
    const cancel = new AbortController();
    cancel.abort();
    expect(await propose.execute({ text: 'early' }, context({}, cancel.signal))).toMatchObject({ error: { code: 'CANCELLED' } });
    expect(await propose.execute({ text: 'kept' }, context())).toMatchObject({ status: 'candidate' });
    expect(proposals.map((request) => request.text)).toEqual(['kept']);
  });

  it('maps a TypeError from provider.propose to INVALID_INPUT with the SDK message, gives the slot back, and keeps other errors PROVIDER_FAILED', async () => {
    const onError = vi.fn();
    let error: Error = new TypeError('proposal text "secret card 4111" does not fit the 6144-byte episode bound');
    const { memory } = provider({ propose: async () => { throw error; } });
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true, proposalsPerMinute: 1, onError }), 'memory_propose');
    const refused = await propose.execute({ text: 'secret card 4111' }, context());
    expect(refused).toEqual({ error: { code: 'INVALID_INPUT', message: 'the memory store refused this proposal as written; shorten or rephrase it' } });
    expect(JSON.stringify(refused)).not.toMatch(/4111|6144|episode/);
    expect(onError).toHaveBeenCalledWith(error);
    // The refusal gave its slot back: with one proposal per minute, the next one still reaches the provider.
    error = new Error('db down');
    expect(await propose.execute({ text: 'x' }, context())).toEqual({ error: { code: 'PROVIDER_FAILED', message: 'memory proposal is unavailable right now' } });
    // A recall TypeError stays PROVIDER_FAILED: only a refused proposal is the model's input.
    const search = byName(memoryTools({ provider: provider({ recall: async () => { throw new TypeError('bad'); } }).memory, scope: SCOPE }), 'memory_search');
    expect(await search.execute({ query: 'x' }, context())).toMatchObject({ error: { code: 'PROVIDER_FAILED' } });
  });

  it('reserves the slot before the provider answers, so concurrent proposals cannot overrun the budget', async () => {
    const releases: Array<() => void> = [];
    const { memory } = provider({ propose: () => new Promise((resolve) => { releases.push(() => resolve({ id: `c${releases.length}` })); }) });
    const propose = byName(memoryTools({ provider: memory, scope: SCOPE, propose: true, proposalsPerMinute: 2 }), 'memory_propose');
    const pending = [1, 2, 3].map((n) => propose.execute({ text: `n${n}` }, context()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.forEach((release) => release());
    const results = await Promise.all(pending);
    expect(results.filter((result) => (result as { status?: string }).status === 'candidate')).toHaveLength(2);
    expect(results.filter((result) => (result as { error?: { code: string } }).error?.code === 'RATE_LIMITED')).toHaveLength(1);
  });

  it('a persistence-only provider (propose, no recall) serves memory_propose alone; no tool at all is a TypeError', async () => {
    const { memory, proposals } = provider();
    const { recall: _recall, ...persistenceOnly } = memory;
    const tools = memoryTools({ provider: persistenceOnly, scope: SCOPE, propose: true });
    expect(tools.map((tool) => tool.name)).toEqual(['memory_propose']);
    expect(await tools[0]!.execute({ text: 'likes tea' }, context())).toMatchObject({ status: 'candidate' });
    expect(proposals[0]).toMatchObject({ scope: SCOPE, text: 'likes tea', origin: MEMORY_TOOL_ORIGIN });
    expect(() => memoryTools({ provider: persistenceOnly, scope: SCOPE })).toThrow(TypeError);
    expect(() => memoryTools({ provider: persistenceOnly, scope: SCOPE })).toThrow(/recall function, or propose: true/);
    expect(() => memoryTools({ provider: { id: 'p', recall: 'x' } as never, scope: SCOPE })).toThrow(/recall must be a function/);
    expect(() => memoryTools({ provider: { id: 'p', recall: async () => [], propose: 'x' } as never, scope: SCOPE })).toThrow(/propose must be a function/);
  });

  it('refuses an unusable id from the provider and bounds its failures', async () => {
    const bad = byName(memoryTools({ provider: provider({ propose: async () => ({ id: '' }) }).memory, scope: SCOPE, propose: true }), 'memory_propose');
    expect(await bad.execute({ text: 'x' }, context())).toMatchObject({ error: { code: 'PROVIDER_FAILED' } });
    const throwing = byName(memoryTools({ provider: provider({ propose: async () => { throw new Error('secret table name'); } }).memory, scope: SCOPE, propose: true }), 'memory_propose');
    const failed = await throwing.execute({ text: 'x' }, context());
    expect(failed).toEqual({ error: { code: 'PROVIDER_FAILED', message: 'memory proposal is unavailable right now' } });
  });

  it('MemoryToolError serializes to its code and bounded message only', () => {
    const error = new MemoryToolError('INVALID_INPUT', `line\nbreak ${'x'.repeat(400)}`);
    expect(error.message).not.toMatch(/\n/);
    expect(error.message.length).toBeLessThanOrEqual(203);
    expect(Object.keys(JSON.parse(JSON.stringify(error)))).toEqual(['code', 'message']);
  });
});

describe('memory-tools entry packaging', () => {
  it('is a package export and a build entry', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { exports: Record<string, unknown> };
    expect(manifest.exports['./memory-tools']).toEqual({ types: './dist/memory-tools.d.ts', import: './dist/memory-tools.js' });
    expect(readFileSync('tsup.config.ts', 'utf8')).toContain("'memory-tools': 'src/memory-tools/index.ts'");
  });

  it('imports no orchestration code', () => {
    const sources = ['index', 'core', 'application-tools', 'mcp-server', 'mcp-protocol', 'recipe']
      .map((name) => readFileSync(`src/memory-tools/${name}.ts`, 'utf8'));
    for (const source of sources) expect(source).not.toMatch(/from '\.\.\/orchestration|node:sqlite/);
  });
});
