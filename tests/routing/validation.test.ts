import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { createAgent, validateRoutingReceipt, type RoutingAgentDefinition } from '../../src/routing/index.js';
const runtime = new Runtime(); const receipts = { async save() {}, async load() { return undefined; } };
afterEach(() => vi.restoreAllMocks());
const validTool = () => ({ name: 'tool', description: 'tool', inputSchema: { type: 'object' }, timeoutMs: 1, maxOutputBytes: 1, authorize: vi.fn(() => true), execute: vi.fn() });
it('rejects every proxy before invoking traps, including nested metadata', async () => {
  const traps = { get: vi.fn(), ownKeys: vi.fn(), getPrototypeOf: vi.fn(), getOwnPropertyDescriptor: vi.fn() };
  for (const definition of [new Proxy({ model: 'codex/gpt-5.4' }, traps), { model: 'codex/gpt-5.4', context: new Proxy({}, traps) }]) {
    await expect(createAgent(definition as RoutingAgentDefinition, { runtime, receipts })).rejects.toThrow();
  }
  for (const trap of Object.values(traps)) expect(trap).not.toHaveBeenCalled();
  expect(() => validateRoutingReceipt(new Proxy({}, traps))).toThrow();
  for (const trap of Object.values(traps)) expect(trap).not.toHaveBeenCalled();
});
it('never reads inherited optional getters or inherited toJSON', async () => {
  const getter = vi.fn(() => { throw Error('inherited getter executed'); });
  Object.defineProperty(Object.prototype, 'sourceDigest', { configurable: true, get: getter });
  try { await expect(createAgent({ model: { mode: 'auto', candidates: [] } }, { runtime, receipts })).rejects.toThrow(); }
  finally { delete (Object.prototype as Record<string, unknown>).sourceDigest; }
  expect(getter).not.toHaveBeenCalled();
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get: getter });
  try { await expect(createAgent({ model: 'codex/gpt-5.4', tools: [validTool()] }, { runtime, receipts })).rejects.toThrow(); }
  finally { delete (Object.prototype as Record<string, unknown>).toJSON; }
  expect(getter).not.toHaveBeenCalled();
});
it('rejects unknown metadata and descriptors before reading callbacks or probing', async () => {
  const p = vi.spyOn(Agent.prototype, 'ready'); const callback = vi.fn(); const getter = vi.fn(() => callback);
  const tool = validTool(); Object.defineProperty(tool, 'execute', { enumerable: true, get: getter });
  const definitions = [
    { model: 'codex/gpt-5.4', unexpected: true }, { model: 'codex/gpt-5.4', tools: [tool] },
    { model: 'codex/gpt-5.4', tools: [{ ...validTool(), unexpected: true }] },
    { model: 'codex/gpt-5.4', tools: [{ ...validTool(), inputSchema: { toJSON: callback } }] },
    { model: 'codex/gpt-5.4', context: { unknown: true } },
  ];
  for (const definition of definitions) await expect(createAgent(definition as RoutingAgentDefinition, { runtime, receipts })).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled(); expect(p).not.toHaveBeenCalled();
});
it('rejects sparse arrays, cycles, symbols, undefined and nonfinite JSON', async () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const config of [cyclic, { value: undefined }, { value: NaN }, { value: [,'x'] }, { [Symbol('x')]: true }]) {
    await expect(createAgent({ model: 'codex/gpt-5.4', providerOptions: { external: { custom: config } } }, { runtime, receipts })).rejects.toThrow();
  }
});
