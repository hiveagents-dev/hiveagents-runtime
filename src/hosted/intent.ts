import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { Runtime } from '../core/runtime.js';
import type { HostedTurnPayload } from './types.js';
import type { createHostedCaller } from './client.js';
import { hostedDigest, hostedHalt, id, integer, record } from './json.js';
type Caller = ReturnType<typeof createHostedCaller>;
interface Intent {
    port: object;
    turnId: string;
    controller: AbortController;
    closed: boolean;
    pending: number;
    digest?: string;
    deadline?: number;
    opened?: Promise<string>;
    intentId?: string;
    bindingId?: string;
    /** Set once when the intent is created. Every turn of the intent carries it; nothing can clear or raise it. */
    priority?: 'low';
}
const ambient = new AsyncLocalStorage<Intent>(), runtimes = new WeakMap<Runtime, object>();
const fail = () => hostedHalt('HOSTED_INTENT_UNKNOWN');
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function signal(input: unknown): AbortSignal | undefined { if (input === undefined)
    return undefined; if (!input || typeof input !== 'object' || types.isProxy(input))
    throw fail(); try {
    aborted.call(input);
}
catch {
    throw fail();
} return input as AbortSignal; }
/** Provider independent, closed correlation data. It grants no admission, retry or settlement authority. */
export function hostedTurnSemanticDigest(t: HostedTurnPayload): string { return hostedDigest({ mode: t.mode, cwd: t.cwd, prompt: t.prompt, sessionId: t.sessionId ?? null, instructions: t.instructions ?? null, outputSchema: t.outputSchema ?? null }); }
export function createHostedIntentPort(rpc: Caller, close: () => void) {
    const port = Object.freeze({}), guard = (state: Intent | undefined) => { if (state && (state.port !== port || state.closed))
        throw fail(); if (state?.controller.signal.aborted)
        throw state.controller.signal.reason; };
    const call: Caller = (binding, body, remaining, original) => { const state = ambient.getStore(); guard(state); return rpc(binding, body, state?.deadline === undefined ? remaining : Math.min(remaining, integer(Math.ceil(state.deadline - performance.now()))), state ? AbortSignal.any([state.controller.signal, ...(original ? [original] : [])]) : original); };
    return Object.freeze({ call,
        bind(runtime: Runtime) { if (runtimes.has(runtime))
            throw fail(); runtimes.set(runtime, port); },
        capture() { const state = ambient.getStore(); guard(state); return state; },
        async open(state: Intent | undefined, bindingId: string, turn: HostedTurnPayload, deadline: number, requestSignal?: AbortSignal) {
            guard(state);
            if (!state)
                return { turn, signal: requestSignal, remaining: () => integer(Math.ceil(deadline - performance.now())), finish() { } };
            const digest = hostedTurnSemanticDigest(turn);
            if (state.digest !== undefined && state.digest !== digest)
                throw fail();
            state.digest = digest;
            state.deadline ??= deadline;
            const remaining = () => integer(Math.ceil(Math.min(state.deadline!, deadline) - performance.now())), combined = AbortSignal.any([state.controller.signal, ...(requestSignal ? [requestSignal] : [])]);
            if (combined.aborted)
                throw combined.reason;
            state.pending++;
            let ended = false;
            const finish = () => { if (!ended) {
                ended = true;
                state.pending--;
            } };
            try {
                state.bindingId ??= bindingId;
                state.opened ??= (async () => { const reply = record(await rpc(bindingId, { method: 'intent-begin', turnId: state.turnId, semanticDigest: digest }, remaining(), combined), ['intentId']); state.intentId = id(reply.intentId); return state.intentId; })();
                const intentId = await state.opened;
                guard(state);
                if (combined.aborted)
                    throw combined.reason;
                return { turn: { ...turn, intentId, ...(state.priority === undefined ? {} : { priority: state.priority }) }, signal: combined, remaining, finish };
            }
            catch (cause) {
                finish();
                throw cause;
            }
        },
        async finish(state: Intent) {
            if (state.pending) {
                state.controller.abort(fail());
                close();
                throw fail();
            }
            if (state.opened) {
                const intentId = await state.opened;
                const reply = record(await rpc(state.bindingId!, { method: 'intent-finish', intentId }, Math.max(1, Math.ceil((state.deadline ?? performance.now() + 1000) - performance.now()))), ['state']);
                if (!['settled', 'closed'].includes(reply.state as string))
                    throw fail();
            }
        },
    });
}
const ports = new WeakMap<object, ReturnType<typeof createHostedIntentPort>>(), active = new WeakMap<object, number>();
/** Called only by the real hosted Runtime factory; copied descriptors cannot register a runtime. */
export function bindHostedIntentRuntime(runtime: Runtime, port: ReturnType<typeof createHostedIntentPort>): void { port.bind(runtime); ports.set(runtimes.get(runtime)!, port); }
/**
 * `priority: 'low'` makes every turn of this intent wait behind default turns for the host's admission
 * (a rehearsal). It is the only accepted value: a caller can lower its own turns, never raise them.
 */
export async function withHostedTurnIntent<T>(runtime: Runtime, options: {
    turnId?: string;
    signal?: AbortSignal;
    priority?: 'low';
}, work: () => T | Promise<T>): Promise<T> {
    const key = runtime && typeof runtime === 'object' && !types.isProxy(runtime) ? runtimes.get(runtime) : undefined, port = key ? ports.get(key) : undefined;
    if (!port || ambient.getStore() || typeof work !== 'function' || (active.get(key!) ?? 0) >= 32)
        throw fail();
    const c = record(options, ['turnId', 'signal', 'priority'], ['turnId', 'signal', 'priority']), outer = signal(c.signal), controller = new AbortController();
    if (c.priority !== undefined && c.priority !== 'low')
        throw fail();
    const state: Intent = { port: key!, turnId: c.turnId === undefined ? randomUUID() : id(c.turnId), controller, closed: false, pending: 0, ...(c.priority === undefined ? {} : { priority: 'low' as const }) };
    const cancel = () => controller.abort(outer!.reason);
    if (outer?.aborted)
        throw outer.reason;
    if (outer)
        EventTarget.prototype.addEventListener.call(outer, 'abort', cancel, { once: true });
    active.set(key!, (active.get(key!) ?? 0) + 1);
    let value: T | undefined, cause: unknown, failed = false;
    try {
        try {
            value = await ambient.run(state, work);
        }
        catch (error) {
            failed = true;
            cause = error;
        }
        state.closed = true;
        try {
            await port.finish(state);
        }
        catch (error) {
            throw hostedHalt('HOSTED_INTENT_UNKNOWN', error);
        }
        if (failed)
            throw cause;
        return value as T;
    }
    finally {
        active.set(key!, active.get(key!)! - 1);
        state.closed = true;
        controller.abort(fail());
        if (outer)
            EventTarget.prototype.removeEventListener.call(outer, 'abort', cancel);
    }
}
