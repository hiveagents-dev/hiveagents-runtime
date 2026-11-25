import { describe, it, expect } from 'vitest';
import { openCodexControlSession, CODEX_CONTROL_CAPABILITY_VERDICTS, type CodexTransportStartOptions } from '../../src/adapters/codex-control/factory.js';
import { Session } from '../../src/session/session.js';
import type { ControlSessionRequest } from '../../src/session/control-session.js';
const model = { provider: 'codex', id: 'gpt-5.2-codex', aliases: [], source: 'explicit' as const, availability: 'unverified' as const };
async function fixture(texts: string[], prelude = false) {
  const calls: Array<Record<string, unknown>> = []; let hooks!: CodexTransportStartOptions; let turn = 0;
  const request: ControlSessionRequest = { model, cwd: '/tmp', persistence: 'process', env: {}, experimentalApi: false, capabilities: {}, envelope: { authorityEpoch: 'a', filesystem: { readonlyRoots: ['/tmp'], writableRoots: [] }, network: [], tools: [], executables: [], mcpServers: [], environmentVariables: [], settingsPersistence: 'none', enforcedBy: ['sandbox'], permissionModeCeiling: 'plan' } };
  const control = await openCodexControlSession(request, { startTransport: async options => { hooks = options; return { close: async () => {}, request: async (method, params) => {
    if (method === 'turn/start') { calls.push(params as Record<string, unknown>); const id = `turn-${turn}`; const text = texts[turn++]!;
      if (prelude) {
        hooks.onNotification('item/completed', { threadId: 'thread', turnId: id, item: { type: 'agentMessage', id: 'commentary', text: 'Checking the document before the final answer.' } });
        hooks.onNotification('item/completed', { threadId: 'thread', turnId: id, item: { type: 'mcpToolCall', id: 'tool', tool: 'read_note', result: 'ok' } });
      }
      hooks.onNotification('item/completed', { threadId: 'thread', turnId: id, item: { type: 'agentMessage', id: 'm', text } });
      hooks.onNotification('thread/tokenUsage/updated', { threadId: 'thread', turnId: id, tokenUsage: { last: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 } } });
      hooks.onNotification('turn/completed', { threadId: 'thread', turn: { id, status: 'completed' } }); return { turn: { id } }; }
    return { thread: { id: 'thread' } };
  } }; } });
  const session = new Session({ adapter: { id: 'codex', detect: async () => ({ installed: true }), auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [], execute: async () => { throw Error('exec'); } }, model, cwd: '/tmp', transport: 'control', persistence: 'process', control, negotiated: { structuredOutput: { support: 'full', evidence: [] } }, env: {}, contextArgs: [], permissionArgs: [], warnings: [], features: { structuredOutput: 'supported' } });
  return { session, calls };
}
const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
describe('Codex structured control output', () => {
  it('declares support and forwards a fresh per-turn outputSchema', async () => {
    expect(CODEX_CONTROL_CAPABILITY_VERDICTS.structuredOutput).toBe('full');
    const f = await fixture(['{"count":1}', '{"label":"ok"}']);
    try {
      expect((await f.session.send('one', { outputSchema: schema })).output).toEqual({ count: 1 });
      const second = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
      expect((await f.session.send('two', { outputSchema: second })).output).toEqual({ label: 'ok' });
      expect(f.calls.map(c => c.outputSchema)).toEqual([schema, second]);
    } finally { await f.session.close(); }
  });
  it.each(['not JSON', '{"count":"wrong"}'])('rejects malformed or mismatched JSON and preserves observed usage: %s', async text => {
    const f = await fixture([text]);
    try { await expect(f.session.send('one', { outputSchema: schema })).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_ERROR', context: { observedUsage: { inputTokens: 7, outputTokens: 3 } } }); }
    finally { await f.session.close(); }
  });
  it('parses the authoritative final JSON after commentary and tool events', async () => {
    const f = await fixture(['{"count":2}'], true);
    try { const turn = await f.session.send('one', { outputSchema: schema });
      expect(turn.output).toEqual({ count: 2 }); expect(turn.text).toBe('{"count":2}');
      expect(turn.events.some(event => event.type === 'message.completed' && event.text.startsWith('Checking'))).toBe(true);
    } finally { await f.session.close(); }
  });
  it('leaves ordinary text output unparsed', async () => {
    const f = await fixture(['ordinary']);
    try { expect((await f.session.send('one')).text).toBe('ordinary'); expect(f.calls[0]).not.toHaveProperty('outputSchema'); }
    finally { await f.session.close(); }
  });
});
