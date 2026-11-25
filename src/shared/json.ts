import { createHash } from 'node:crypto';
import { types } from 'node:util';
// Neutral leaf: strict JSON helpers shared by core, routing, orchestration and hosted code.
// It imports node builtins only, so no layer pulls another one in through it.
// Persisted digests (receipts, checkpoints, hash-chained logs) depend on `canonical` and
// `checksum` byte for byte: never change their output.
/** SHA-256 of a string, as 64 lowercase hex characters. */
export function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Snapshot own descriptor values without invoking getters, proxies or toJSON. */
export function snapshot<T>(value: T, callbacks = false): T {
  const seen = new Set<object>();
  const visit = (item: unknown, path: string[]): unknown => {
    if (typeof item === 'function' && !types.isProxy(item) && callbacks && path.length === 3 && path[0] === 'tools' && /^\d+$/.test(path[1]!) && ['authorize', 'execute'].includes(path[2]!)) return item;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item) || seen.has(item)) throw new TypeError('Expected strict JSON metadata');
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Expected plain JSON objects');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbols are unsupported');
    for (let proto = Object.getPrototypeOf(item); proto; proto = Object.getPrototypeOf(proto)) {
      for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
        if (name === 'toJSON' || name !== '__proto__' && !Object.hasOwn(desc, 'value')) throw new TypeError('Inherited accessors and toJSON are unsupported');
      }
    }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(item));
    for (const [key, desc] of entries) {
      if (array && key === 'length') continue;
      if (!Object.hasOwn(desc, 'value') || !desc.enumerable) throw new TypeError('Expected enumerable data descriptors');
    }
    if (array && (Object.keys(item).length !== item.length || Array.from({ length: item.length }, (_, i) => i).some(i => !Object.hasOwn(item, i)))) throw new TypeError('Sparse arrays are unsupported');
    seen.add(item); const copy = array ? [] : Object.create(null);
    for (const [key, desc] of entries) {
      if (array && key === 'length') continue;
      Object.defineProperty(copy, key, { value: visit(desc.value, [...path, key]), enumerable: true, configurable: true, writable: true });
    }
    seen.delete(item); return copy;
  };
  return visit(value, []) as T;
}
export function jsonClone<T>(value: T): T { return snapshot(value); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function digest(value: unknown): string { return checksum(canonical(jsonClone(value))); }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
export function object(value: unknown, allowed?: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected plain object');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbols are unsupported');
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(desc, 'value') || !desc.enumerable) throw new TypeError('Expected enumerable data descriptors');
    if (allowed && !allowed.includes(key)) throw new TypeError(`Unknown field ${key}`);
  }
}
export function ownObject<T>(value: T, allowed: readonly string[]): T {
  object(value, allowed); const copy = Object.create(null);
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(value))) Object.defineProperty(copy, key, desc);
  return copy as T;
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new TypeError('Invalid identifier');
}
export function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid SHA256 digest');
}
export function strings(value: unknown, limit: number, nonempty = false): asserts value is string[] {
  jsonClone(value);
  if (!Array.isArray(value) || value.length > limit || (nonempty && !value.length)
    || value.some(entry => typeof entry !== 'string' || !entry.trim()) || new Set(value).size !== value.length) throw new TypeError('Invalid or duplicate list entries');
}
export function method<T extends (...args: never[]) => unknown>(owner: object, key: string): T {
  if (types.isProxy(owner)) throw new TypeError('Proxy methods are unsupported');
  for (let cursor: object | null = owner; cursor; cursor = Object.getPrototypeOf(cursor)) {
    if (types.isProxy(cursor)) throw new TypeError('Proxy prototypes are unsupported');
    const desc = Object.getOwnPropertyDescriptor(cursor, key);
    if (!desc) continue;
    if (!Object.hasOwn(desc, 'value') || typeof desc.value !== 'function' || types.isProxy(desc.value)) throw new TypeError(`Invalid ${key} method`);
    return desc.value.bind(owner) as T;
  }
  throw new TypeError(`Missing ${key} method`);
}
