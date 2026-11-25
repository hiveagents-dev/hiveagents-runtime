import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { ControlSessionRequest } from '../../src/session/control-session.js';
import type { ApplicationTool } from '../../src/tools/types.js';
const tool = (): ApplicationTool => ({ name: 'read_note', description: 'read', inputSchema: { type: 'object' }, timeoutMs: 100, maxOutputBytes: 100, authorize: () => true, execute: () => null });
const adapter = { id: 'claude' as const, detect: async () => ({ installed: true, version: '1.0.0' }), auth: async () => ({ authenticated: true, source: 'subscription' as const }), models: async () => [], execute: async () => { throw Error('No prompt allowed'); } };
function runtime(support: 'partial' | 'none' = 'partial', capture?: (r: ControlSessionRequest) => void) { return new Runtime({ adapters: [adapter], controlAdapters: [{ token: 'claudeControlV1', provider: 'claude', packageName: 'core', adapterVersion: 'test', capabilityVerdicts: { inProcessTools: support, turns: 'full' }, evidenceSource: 'sdk-capability', createSession: async r => { capture?.(r); return { transportEpoch: 'e', identity: undefined, state: () => 'active', startTurn: async () => { throw Error('No prompt'); }, respond: async () => {}, fork: async () => { throw Error('No fork'); }, close: async () => {} }; } }] }); }
describe('Agent application tools', () => {
  it('snapshots callbacks and metadata and implies the control requirement', async () => {
    const tools = [tool()]; let captured: ControlSessionRequest | undefined;
    const agent = new Agent({ model: 'opus-5', tools, providerOptions: { experimentalControl: true } }, runtime('partial', r => { captured = r; }));
    tools[0]!.name = 'changed'; tools.length = 0;
    expect((await agent.ready()).plan.transport).toBe('control');
    const session = await agent.openSession(); expect(captured?.tools?.[0]?.name).toBe('read_note'); await session.close();
  });
  it('rejects explicit exec and unimplemented control before any prompt', async () => {
    await expect(new Agent({ model: 'opus-5', tools: [tool()], transport: 'exec' }, runtime()).ready()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(new Agent({ model: 'opus-5', tools: [tool()], providerOptions: { experimentalControl: true } }, runtime('none')).ready()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});
