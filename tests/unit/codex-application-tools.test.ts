import { describe, it, expect } from 'vitest';
import { bindCodexApplicationTools, createCodexApplicationToolBinding } from '../../src/adapters/codex-control/application-tools.js';
import { CodexDynamicToolHost } from '../../src/adapters/codex-control/dynamic-tools.js';
import { CodexInteractionBridge } from '../../src/adapters/codex-control/interactions.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
describe('Codex common application tool binding', () => {
  it('binds trusted authority and active turn scope, then authorizes and executes exactly once', async () => {
    const seen: unknown[] = []; let executions = 0;
    const dynamicTools = new CodexDynamicToolHost({ experimentalApi: true, tools: bindCodexApplicationTools([{ name: 'read_note', description: 'Read', inputSchema: { type: 'object' }, timeoutMs: 100, maxOutputBytes: 100,
      authorize: (_i, context) => { seen.push(context.scope); return true; }, execute: () => { executions++; return { value: 1 }; } }]) });
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'transport' });
    const bridge = new CodexInteractionBridge({ broker, dynamicTools, toolContext: binding => ({ deadline: Date.now() + 100,
      scope: { provider: 'codex', transport: 'control', cwd: '/trusted', sessionId: binding.sessionId, ...(binding.turnId === undefined ? {} : { turnId: binding.turnId }), ...(binding.itemId === undefined ? {} : { callId: binding.itemId }), authorityEpoch: 'authority' } }) });
    await expect(bridge.handleServerRequest('item/tool/call', { threadId: 'session', turnId: 'turn', callId: 'call', cwd: '/forged', tool: 'read_note', arguments: {} }, 42)).resolves.toEqual({ success: true, contentItems: [{ type: 'inputText', text: '{"value":1}' }] });
    expect(seen).toEqual([{ provider: 'codex', transport: 'control', cwd: '/trusted', sessionId: 'session', turnId: 'turn', callId: 'call', authorityEpoch: 'authority' }]);
    expect(executions).toBe(1);
  });
  it('refuses application tools without a trusted binding scope', async () => {
    const dynamicTools = new CodexDynamicToolHost({ experimentalApi: true, tools: bindCodexApplicationTools([{ name: 'read_note', description: 'Read', inputSchema: { type: 'object' }, timeoutMs: 100, maxOutputBytes: 100, authorize: () => true, execute: () => null }]) });
    await expect(dynamicTools.call('read_note', {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
});

 it('keeps an underlying common callback pending beyond the legacy wrapper timeout', async () => {
  let finish!: (output: unknown) => void;
  const binding = createCodexApplicationToolBinding([{ name: 'slow', description: 'slow', inputSchema: { type: 'object' }, timeoutMs: 15, maxOutputBytes: 100, authorize: () => true, execute: () => new Promise(resolve => { finish = resolve; }) }]);
  const host = new CodexDynamicToolHost({ experimentalApi: true, tools: binding.definitions, hasExternalPending: binding.hasPending });
  await expect(host.call('slow', {}, { signal: new AbortController().signal, scope: { provider: 'codex', transport: 'control', cwd: '/tmp', sessionId: 'session', authorityEpoch: 'a' } })).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(host.hasPending('session')).toBe(true); finish(null); await Promise.resolve(); await Promise.resolve();
  expect(host.hasPending('session')).toBe(false);
});
