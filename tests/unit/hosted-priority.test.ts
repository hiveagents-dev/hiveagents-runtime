import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Agent, isExecutionHalted } from '../../src/index.js';
import { captureHostedRequest, createHostedRuntime, withHostedTurnIntent, type HostedReply, type HostedRequest } from '../../src/hosted-runtime.js';
import { hostedTurnSemanticDigest } from '../../src/hosted/intent.js';
import { fixture } from './hosted-runtime.test.js';

// Protocol-only: the priority is a request to wait behind others. It never proves or grants admission.
const cwd = realpathSync(tmpdir());
const turn = { mode: 'open' as const, modelId: 'claude-test', cwd, prompt: 'x', timeoutMs: 1000, maxOutputBytes: 1000 };
const request = (extra: Record<string, unknown>) => ({ schemaVersion: 1, channelId: 'a'.repeat(32), systemId: 'fixture', generation: 1, bindingId: randomUUID(), requestId: randomUUID(), remainingMs: 1000, method: 'execute', recipeId: randomUUID(), turn: { ...turn, ...extra } });

function configured() {
    const f = fixture(), original = f.context.client.call, intentId = randomUUID(), calls: HostedRequest[] = [];
    f.context.client.call = async (r) => {
        calls.push(r);
        const base = { schemaVersion: 1 as const, channelId: r.channelId, systemId: r.systemId, generation: r.generation, bindingId: r.bindingId, requestId: r.requestId };
        if (r.method === 'intent-begin') return { ...base, ok: true, data: { intentId } } as HostedReply;
        if (r.method === 'intent-finish') return { ...base, ok: true, data: { state: 'closed' } } as HostedReply;
        return original(r);
    };
    const runtime = createHostedRuntime(f.context), agent = () => new Agent({ model: 'claude/claude-test', cwd, transport: 'exec' }, runtime);
    const turns = () => calls.flatMap(r => r.method === 'execute' || r.method === 'stream-open' ? [r.turn] : []);
    return { runtime, agent, calls, turns };
}

describe('hosted turn priority on the wire', () => {
    it('accepts a turn that asks to wait behind the others', () => {
        const captured = captureHostedRequest(request({ priority: 'low' }));
        expect('turn' in captured && captured.turn.priority).toBe('low');
        const plain = captureHostedRequest(request({}));
        expect('turn' in plain && Object.hasOwn(plain.turn, 'priority')).toBe(false);
    });
    it('refuses every other priority value: nothing on the wire can raise a turn', () => {
        for (const priority of ['normal', 'high', 'urgent', 'LOW', ' low', '', 0, 1, true, null, ['low'], { level: 'low' }])
            expect(() => captureHostedRequest(request({ priority })), JSON.stringify(priority)).toThrowError(expect.toSatisfy(isExecutionHalted));
    });
    it('keeps the priority out of the turn semantic digest, so no existing correlation changes', () => {
        expect(hostedTurnSemanticDigest({ ...turn, priority: 'low' })).toBe(hostedTurnSemanticDigest(turn));
    });
});

describe('hosted turn intent priority', () => {
    it('marks every turn of a low-priority intent and no turn of a default one', async () => {
        const f = configured();
        await withHostedTurnIntent(f.runtime, { priority: 'low' }, async () => { await f.agent().send('same'); await f.agent().send('same'); });
        expect(f.turns().map(t => t.priority)).toEqual(['low', 'low']);
        await withHostedTurnIntent(f.runtime, {}, async () => { await f.agent().send('other'); });
        expect(Object.hasOwn(f.turns()[2]!, 'priority')).toBe(false);
    });
    it('sends no priority for a turn outside an intent', async () => {
        const f = configured();
        await f.agent().send('alone');
        expect(f.turns()).toHaveLength(1);
        expect(Object.hasOwn(f.turns()[0]!, 'priority')).toBe(false);
    });
    it('refuses any other priority before the callback or any request runs', async () => {
        const f = configured();
        let called = 0;
        for (const priority of ['normal', 'high', '', 0, null, { level: 'low' }])
            await expect(withHostedTurnIntent(f.runtime, { priority } as never, () => { called++; }), JSON.stringify(priority)).rejects.toSatisfy(isExecutionHalted);
        expect(called).toBe(0);
        expect(f.calls).toHaveLength(0);
    });
});
