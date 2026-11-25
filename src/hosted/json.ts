import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { ExecutionHaltedError } from '../public/execution-halt.js';
import type { HostedJson } from './types.js';
export const HOSTED_BOUNDS = Object.freeze({ metadataBytes: 2 * 1024 * 1024, valueBytes: 256 * 1024 * 1024, nodes: 1000000, depth: 128, promptBytes: 16 * 1024 * 1024, pending: 32 });
export function hostedHalt(reason = 'HOSTED_PROTOCOL_INVALID', cause?: unknown): ExecutionHaltedError { return new ExecutionHaltedError({ sanitizedDiagnostics: { reason } }, cause === undefined ? undefined : { cause }); }
export function invalid(): never { throw hostedHalt(); }
export function record(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        const d = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !fields.includes(key) || !Object.hasOwn(d, 'value'))
            invalid();
        result[key] = d.value;
    }
    for (const key of fields)
        if (!optional.includes(key) && !Object.hasOwn(result, key))
            invalid();
    return result;
}
export function integer(value: unknown, min = 1, max = 2 ** 31 - 1): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(); return value; }
export function text(value: unknown, max = 4096): string { if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    invalid(); return value; }
export function id(value: unknown): string { const s = text(value, 64); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s))
    invalid(); return s; }
export function digest(value: unknown): string { const s = text(value, 64); if (!/^[a-f0-9]{64}$/.test(s))
    invalid(); return s; }
export function absolute(value: unknown): string { const s = text(value); if (!s.startsWith('/') || s.split('/').includes('..') || s.split('/').includes('.'))
    invalid(); return s; }
export function array(value: unknown, max = 128): unknown[] {
    if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        invalid();
    const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
    if (length > max || Reflect.ownKeys(value).length !== length + 1)
        invalid();
    const values: unknown[] = [];
    for (let i = 0; i < length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !Object.hasOwn(d, 'value') || !d.enumerable)
            invalid();
        values.push(d.value);
    }
    return values;
}
export function strings(value: unknown, max = 128): string[] { return array(value, max).map(v => text(v)); }
/** Bounded canonical traversal. No object JSON hooks, getters, proxy traps or full escaped-string allocation. */
function inspect(value: unknown, maxBytes: number, freeze: boolean): {
    value: HostedJson;
    digest: string;
} {
    const hash = createHash('sha256'), ancestors = new Set<object>();
    let bytes = 0, nodes = 0;
    const write = (s: string) => { bytes += Buffer.byteLength(s); if (bytes > maxBytes)
        invalid(); hash.update(s); };
    const string = (s: string) => { write('"'); for (let offset = 0; offset < s.length;) {
        let end = Math.min(s.length, offset + 8192);
        if (end < s.length && s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff && s.charCodeAt(end) >= 0xdc00 && s.charCodeAt(end) <= 0xdfff)
            end--;
        write(JSON.stringify(s.slice(offset, end)).slice(1, -1));
        offset = end;
    } write('"'); };
    const visit = (v: unknown, depth: number): HostedJson => {
        if (++nodes > HOSTED_BOUNDS.nodes || depth > HOSTED_BOUNDS.depth)
            invalid();
        if (v === null || typeof v === 'boolean') {
            write(String(v));
            return v;
        }
        if (typeof v === 'string') {
            string(v);
            return v;
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
            write(JSON.stringify(v));
            return v;
        }
        if (!v || typeof v !== 'object' || types.isProxy(v) || ancestors.has(v))
            invalid();
        const array = Array.isArray(v), prototype = Object.getPrototypeOf(v);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
            invalid();
        const keys = Reflect.ownKeys(v);
        if (keys.length > HOSTED_BOUNDS.nodes || keys.some(k => typeof k !== 'string'))
            invalid();
        ancestors.add(v);
        const get = (k: string) => { const d = Object.getOwnPropertyDescriptor(v, k); if (!d || !Object.hasOwn(d, 'value') || !d.enumerable)
            invalid(); return d.value as unknown; };
        let result: HostedJson;
        if (array) {
            const n = Object.getOwnPropertyDescriptor(v, 'length')!.value as number;
            if (keys.length !== n + 1 || n > HOSTED_BOUNDS.nodes)
                invalid();
            const items: HostedJson[] = [];
            write('[');
            for (let i = 0; i < n; i++) {
                if (i)
                    write(',');
                const item = get(String(i));
                items.push(item === undefined ? null : visit(item, depth + 1));
            }
            write(']');
            result = items;
        }
        else {
            const data: Record<string, HostedJson> = Object.create(null);
            write('{');
            let count = 0;
            for (const key of (keys as string[]).sort()) {
                const item = get(key);
                if (item === undefined)
                    continue;
                if (count++)
                    write(',');
                string(key);
                write(':');
                data[key] = visit(item, depth + 1);
            }
            write('}');
            result = data;
        }
        ancestors.delete(v);
        if (freeze)
            Object.freeze(result);
        return result;
    };
    return { value: visit(value, 1), digest: hash.digest('hex') };
}
export function hostedDigest(value: unknown): string { return inspect(value, HOSTED_BOUNDS.valueBytes, false).digest; }
export function snapshot(value: unknown, maxBytes: number = HOSTED_BOUNDS.valueBytes, freeze = false): HostedJson { return inspect(value, integer(maxBytes, 1, HOSTED_BOUNDS.valueBytes), freeze).value; }

export function channelId(value:unknown):string {const s=text(value,32);if(!/^[a-f0-9]{32}$/.test(s))invalid();return s;}
