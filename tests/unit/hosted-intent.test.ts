import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Agent, isExecutionHalted } from '../../src/index.js';
import { createHostedRuntime, withHostedTurnIntent, type HostedReply } from '../../src/hosted-runtime.js';
import { fixture } from './hosted-runtime.test.js';
// Protocol-only: correlation is DATA and never proves Host admission, settlement or permission.
function configured() {
    const f = fixture(), original = f.context.client.call, intentId = randomUUID();
    f.context.client.call = async (request) => request.method === 'intent-begin' ? { schemaVersion: 1, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId, ok: true, data: { intentId } } : request.method === 'intent-finish' ? { schemaVersion: 1, channelId: request.channelId, systemId: request.systemId, generation: request.generation, bindingId: request.bindingId, requestId: request.requestId, ok: true, data: { state: 'closed' } } : original(request);
    const calls: Parameters<typeof original>[0][] = [];
    const captured = f.context.client.call;
    f.context.client.call = async (request) => { calls.push(request); return captured(request) as Promise<HostedReply>; };
    const runtime = createHostedRuntime(f.context), agent = () => new Agent({ model: 'claude/claude-test', cwd: realpathSync(tmpdir()), transport: 'exec' }, runtime);
    return { ...f, runtime, agent, calls, intentId };
}
describe('explicit hosted logical turn correlation', () => {
    it('uses one begin/finish and the same server correlation for awaited Agent operations', async () => {
        const f = configured();
        await withHostedTurnIntent(f.runtime, {}, async () => { await f.agent().send('same'); await f.agent().send('same'); });
        const turns = f.calls.filter(r => r.method === 'execute');
        expect(turns).toHaveLength(2);
        expect(turns.every(r => 'turn' in r && r.turn.intentId === f.intentId)).toBe(true);
        expect(f.calls.filter(r => r.method === 'intent-begin')).toHaveLength(1);
        expect(f.calls.filter(r => r.method === 'intent-finish')).toHaveLength(1);
    });
    it('rejects a changed semantic turn before sending its second generation request', async () => {
        const f = configured();
        await expect(withHostedTurnIntent(f.runtime, {}, async () => { await f.agent().send('same'); await f.agent().send('changed'); })).rejects.toSatisfy(isExecutionHalted);
        expect(f.calls.filter(r => r.method === 'execute')).toHaveLength(1);
    });
    it('does not create an intent or native call for a callback without a real adapter operation', async () => { const f = configured(); expect(await withHostedTurnIntent(f.runtime, {}, () => 7)).toBe(7); expect(f.calls).toHaveLength(0); });
    it('rejects a copied/non-hosted runtime and nested intent without invoking callbacks', async () => { const f = configured(); let calls = 0; await expect(withHostedTurnIntent({ ...f.runtime } as never, {}, () => { calls++; })).rejects.toSatisfy(isExecutionHalted); await expect(withHostedTurnIntent(f.runtime, {}, () => withHostedTurnIntent(f.runtime, {}, () => { calls++; }))).rejects.toSatisfy(isExecutionHalted); expect(calls).toBe(0); });
    it('preserves a caller failure and finishes correlation without granting fallback authority', async () => { const f = configured(), cause = Error('owned callback failure'); await expect(withHostedTurnIntent(f.runtime, {}, async () => { await f.agent().send('same'); throw cause; })).rejects.toBe(cause); expect(f.calls.filter(r => r.method === 'intent-finish')).toHaveLength(1); });
    it('rejects an already aborted signal without an RPC or callback', async () => { const f = configured(), controller = new AbortController(), cause = Error('owned abort'); controller.abort(cause); let called = false; await expect(withHostedTurnIntent(f.runtime, { signal: controller.signal }, () => { called = true; })).rejects.toBe(cause); expect(called).toBe(false); expect(f.calls).toHaveLength(0); });
    it('captures stream factory correlation but sends nothing when returned before its first next', async () => { const f = configured(); await withHostedTurnIntent(f.runtime, {}, async () => { const iterator = f.agent().stream('same')[Symbol.asyncIterator](); await iterator.return?.(); }); expect(f.calls).toHaveLength(0); });
    it('bounds concurrent correlation callbacks even before any native work exists', async () => { const f = configured(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const first = Array.from({ length: 32 }, () => withHostedTurnIntent(f.runtime, {}, () => gate)); try {
        await expect(withHostedTurnIntent(f.runtime, {}, () => 7)).rejects.toSatisfy(isExecutionHalted);
    }
    finally {
        release();
        await Promise.all(first);
    } expect(f.calls).toHaveLength(0); });
    it('fences escaped asynchronous work after the logical callback has completed', async () => { const f = configured(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let escaped!: Promise<unknown>; await withHostedTurnIntent(f.runtime, {}, async () => { escaped = (async () => { await gate; return f.agent().send('late'); })(); void escaped.catch(() => { }); }); release(); await expect(escaped).rejects.toSatisfy(isExecutionHalted); expect(f.calls.filter(r => r.method === 'execute')).toHaveLength(0); });
});
