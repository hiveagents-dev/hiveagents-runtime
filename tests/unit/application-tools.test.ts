import { describe, expect, it, vi } from 'vitest';
import { ApplicationToolRegistry, snapshotApplicationTools } from '../../src/tools/registry.js';
import type { ApplicationTool } from '../../src/tools/types.js';

const scope = { provider: 'codex', transport: 'control' as const, cwd: '/tmp/tools', sessionId: 's', turnId: 't', callId: 'c', authorityEpoch: 'a' };
const context = () => ({ signal: new AbortController().signal, scope });
const definition = (overrides: Partial<ApplicationTool> = {}): ApplicationTool => ({ name: 'read_note', description: 'Read one note',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  timeoutMs: 1000, maxOutputBytes: 1000, authorize: () => true, execute: input => input, ...overrides });

describe('application tool registry', () => {
  it('isolates schema IDs across snapshots, registries and distinct tools without changing local references', async () => {
    const inputSchema = { $id: 'https://example.test/tool-schema', type: 'object',
      definitions: { id: { type: 'string' } }, properties: { id: { $ref: '#/definitions/id' } }, required: ['id'] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = snapshotApplicationTools([definition({ inputSchema })]);
      const registry = new ApplicationToolRegistry(snapshot);
      await expect(registry.call('read_note', { id: 'yes' }, context())).resolves.toEqual({ id: 'yes' });
      await expect(registry.call('read_note', { id: 1 }, context())).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    }
    const different = new ApplicationToolRegistry([definition({ inputSchema: { $id: inputSchema.$id, type: 'number' } })]);
    await expect(different.call('read_note', 2, context())).resolves.toBe(2);
  });
  it('validates input before authorization and executes only when authorized', async () => {
    const authorize = vi.fn(() => false); const execute = vi.fn();
    const registry = new ApplicationToolRegistry([definition({ authorize, execute })]);
    await expect(registry.call('read_note', { id: 2 }, context())).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(authorize).not.toHaveBeenCalled();
    await expect(registry.call('read_note', { id: 'secret' }, context())).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('captures metadata and callback references without cloning functions', async () => {
    const tool = definition(); const tools = [tool];
    const snapshot = snapshotApplicationTools(tools);
    (tool.inputSchema.properties as Record<string, unknown>).id = { type: 'number' }; tool.name = 'mutated'; tools.length = 0;
    const registry = new ApplicationToolRegistry(snapshot);
    expect(registry.declarations()[0]?.name).toBe('read_note');
    await expect(registry.call('read_note', { id: 'yes' }, context())).resolves.toEqual({ id: 'yes' });
    const declarations = registry.declarations(); declarations[0]!.inputSchema.type = 'string';
    expect(registry.declarations()[0]?.inputSchema.type).toBe('object');
  });
  it('shares one deadline across authorization and execution and aborts the derived signal', async () => {
    let observed: AbortSignal | undefined; let execute = false;
    const registry = new ApplicationToolRegistry([definition({ timeoutMs: 20,
      authorize: async (_input, ctx) => { observed = ctx.signal; await new Promise(r => setTimeout(r, 35)); return true; },
      execute: () => { execute = true; },
    })]);
    await expect(registry.call('read_note', { id: 'x' }, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(observed?.aborted).toBe(true);
    await new Promise(r => setTimeout(r, 30)); expect(execute).toBe(false);
  });
  it('inherits parent cancellation and the earlier parent deadline', async () => {
    const controller = new AbortController(); let observed: AbortSignal | undefined;
    const registry = new ApplicationToolRegistry([definition({ execute: (_i, ctx) => { observed = ctx.signal; return new Promise(() => {}); } })]);
    const result = registry.call('read_note', { id: 'x' }, { signal: controller.signal, scope, deadline: Date.now() + 15 });
    await expect(result).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(observed?.aborted).toBe(true);
    controller.abort();
    await expect(registry.call('read_note', { id: 'x' }, { signal: controller.signal, scope })).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('binds frozen scope and input and returns detached bounded JSON', async () => {
    const output = { ok: true }; let bound: unknown;
    const registry = new ApplicationToolRegistry([definition({ execute: (input, ctx) => { bound = ctx.scope; expect(Object.isFrozen(input)).toBe(true); return output; } })]);
    const result = await registry.call('read_note', { id: 'x' }, context()); output.ok = false;
    expect(result).toEqual({ ok: true }); expect(bound).toEqual(scope); expect(Object.isFrozen(bound)).toBe(true);
  });
  it.each([undefined, 2n, NaN, { secret: undefined }, { f: () => 1 }])('rejects non JSON output without exposing payloads: %s', async output => {
    const registry = new ApplicationToolRegistry([definition({ execute: () => output })]);
    await expect(registry.call('read_note', { id: 'x' }, context())).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
  it('bounds output and sanitizes callback errors', async () => {
    const big = new ApplicationToolRegistry([definition({ maxOutputBytes: 2, execute: () => 'sensitive' })]);
    await expect(big.call('read_note', { id: 'x' }, context())).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    const bad = new ApplicationToolRegistry([definition({ authorize: () => { throw new Error('secret-payload'); } })]);
    try { await bad.call('read_note', { id: 'x' }, context()); } catch (error) { expect(String(error)).not.toContain('secret-payload'); }
  });
  it('rejects duplicate names, invalid schemas and unsafe limits at registration', () => {
    expect(() => new ApplicationToolRegistry([definition(), definition()])).toThrow();
    for (const tool of [definition({ name: '../bad' }), definition({ timeoutMs: 0 }), definition({ maxOutputBytes: Infinity }), definition({ inputSchema: { type: 'not-json-schema' } })]) {
      expect(() => new ApplicationToolRegistry([tool])).toThrow();
    }
  });
});

it('observes an unsettled callback after timeout and clears the pending record only at actual settlement', async () => {
  let finish!: (value: unknown) => void;
  const registry = new ApplicationToolRegistry([definition({ timeoutMs: 10, execute: () => new Promise(resolve => { finish = resolve; }) })]);
  await expect(registry.call('read_note', { id: 'x' }, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(registry.hasPending('s')).toBe(true);
  finish(null); await Promise.resolve(); await Promise.resolve();
  expect(registry.hasPending('s')).toBe(false);
});
it('sanitizes typed callback errors and revokes the completed callback signal', async () => {
  const { ProtocolError } = await import('../../src/public/errors.js');
  const registry = new ApplicationToolRegistry([definition({ execute: () => { throw new ProtocolError({ retryable: false, sanitizedDiagnostics: 'secret-payload' }, 'secret-payload'); } })]);
  try { await registry.call('read_note', { id: 'x' }, context()); } catch (error) { expect(JSON.stringify(error)).not.toContain('secret-payload'); expect(String(error)).not.toContain('secret-payload'); }
  let signal: AbortSignal | undefined;
  await new ApplicationToolRegistry([definition({ execute: (_i, ctx) => { signal = ctx.signal; return null; } })]).call('read_note', { id: 'x' }, context());
  expect(signal?.aborted).toBe(true);
});
