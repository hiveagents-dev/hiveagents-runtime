import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as shared from '../../src/shared/json.ts';
import * as routing from '../../src/routing/json.ts';
import { canonical as tracingCanonical } from '../../src/orchestration/tracing/validation.ts';
import { checksum as workflowChecksum } from '../../src/orchestration/workflow/checkpoint.ts';

// Frozen copies of the serializers that `src/shared/json.ts` replaced, verbatim. Persisted
// digests (receipts, checkpoints, hash-chained logs, handoff bundles, evaluation hashes) were
// made with them, so the shared serializer must agree byte for byte on every input.
const before = {
  routing(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
    if (Array.isArray(value)) return `[${value.map(before.routing).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${before.routing((value as Record<string, unknown>)[key])}`).join(',')}}`;
  },
  tracing(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(before.tracing).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${before.tracing((value as Record<string, unknown>)[key])}`).join(',')}}`;
  },
  bundle(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(before.bundle).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${before.bundle(object[key])}`).join(',')}}`;
  },
  evaluation(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(before.evaluation).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${before.evaluation((value as Record<string, unknown>)[key])}`).join(',')}}`;
  },
  tools(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
    if (Array.isArray(value)) return `[${value.map(before.tools).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${before.tools((value as Record<string, unknown>)[key])}`).join(',')}}`;
  },
};
// Kept in src/adapters/codex-control/dynamic-tools.ts: it differs (see the last test).
function dynamicTools(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(dynamicTools).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${dynamicTools(record[key])}`).join(',')}}`;
}

function corpus(): Array<[string, unknown]> {
  const cycle: Record<string, unknown> = { a: 1 }; cycle.self = cycle;
  const arrayCycle: unknown[] = [1]; arrayCycle.push(arrayCycle);
  const shared1 = { x: 1 };
  const getter = { get value() { return 'computed'; } };
  const nullProto = Object.assign(Object.create(null), { z: 1, a: [null] });
  const symbolKey = { visible: 1, [Symbol('hidden')]: 2 };
  const nonEnumerable = Object.defineProperty({ a: 1 }, 'b', { value: 2, enumerable: false });
  const protoKey = JSON.parse('{"__proto__":{"polluted":true},"b":1}') as unknown;
  class Point { constructor(public x = 1, public y = 2) {} }
  return [
    ['null', null], ['true', true], ['false', false], ['empty string', ''], ['string', 'hello'],
    ['zero', 0], ['negative zero', -0], ['integer', 42], ['negative', -17], ['float', 3.141592653589793],
    ['small exponent', 1e-7], ['large exponent', 1e21], ['max safe', Number.MAX_SAFE_INTEGER], ['max value', Number.MAX_VALUE],
    ['min value', Number.MIN_VALUE], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['empty object', {}], ['empty array', []], ['nested empty', { a: {}, b: [], c: [[]], d: [{}] }],
    ['key order', { b: 1, a: 2, c: { z: 1, y: [3, 2, 1], x: null } }],
    ['numeric-like keys', { 10: 'a', 2: 'b', '1a': 'c', '-1': 'd', '': 'e' }],
    ['unicode keys', { 'é': 1, 'é': 2, '😀': 3, 'Z': 4, 'a': 5 }],
    ['escapes', { s: '"quoted" \\ back\nnew\rret\ttab\b\f\u0000\u001f\u007f  ' }],
    ['unicode', ['ñandú', '日本語', '😀', '😀', 'é']],
    ['lone surrogates', ['\ud800', '\udfff', 'a\ud83db']],
    ['deep nesting', { a: [{ b: [{ c: [{ d: 'deep' }] }] }] }],
    ['repeated reference', { a: shared1, b: shared1, c: [shared1, shared1] }],
    ['mixed array', [1, 'two', null, true, { three: 3 }, [4]]],
    ['null prototype', nullProto], ['__proto__ own key', protoKey],
    ['undefined', undefined], ['undefined property', { a: undefined, b: 1 }], ['undefined in array', [1, undefined, 2]],
    ['function', () => 1], ['function property', { f() {}, b: 1 }], ['function in array', [() => 1]],
    ['symbol value', Symbol('s')], ['symbol in array', [Symbol('s')]], ['symbol key', symbolKey],
    ['bigint', 10n], ['bigint property', { a: 10n }],
    ['sparse array', [1, , 3]], ['non-enumerable', nonEnumerable], ['getter', getter],
    ['Date', new Date(0)], ['Map', new Map([['a', 1]])], ['Set', new Set([1])], ['RegExp', /x/g],
    ['class instance', new Point()], ['boxed string', Object('str')], ['boxed number', Object(5)],
    ['typed array', new Uint8Array([1, 2])], ['toJSON object', { toJSON: () => 'replaced', a: 1 }],
    ['cycle', cycle], ['array cycle', arrayCycle],
  ];
}

function outcome(serialize: (value: unknown) => unknown, value: unknown): unknown {
  try { return { output: serialize(value) }; } catch (error) { return { error: (error as Error).constructor.name }; }
}

describe('shared canonical JSON', () => {
  for (const [name, reference] of Object.entries(before)) {
    it(`matches the replaced ${name} serializer byte for byte on the whole corpus`, () => {
      for (const [label, value] of corpus()) {
        expect(outcome(shared.canonical, value), `${name}: ${label}`).toEqual(outcome(reference, value));
      }
    });
  }

  it('is the very function behind every compatibility export', () => {
    expect(routing.canonical).toBe(shared.canonical);
    expect(routing.digest).toBe(shared.digest);
    expect(tracingCanonical).toBe(shared.canonical);
    expect(workflowChecksum).toBe(shared.checksum);
  });

  it('keeps the digests already stored', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(shared.checksum('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(shared.canonical({ b: [1, 'é', { d: -0, c: 1e21 }], a: null })).toBe('{"a":null,"b":[1,"é",{"c":1e+21,"d":0}]}');
    expect(shared.digest({ b: 1, a: [true, 'x'] })).toBe(sha('{"a":[true,"x"],"b":1}'));
    for (const [label, value] of corpus()) {
      let strict: unknown;
      try { strict = shared.jsonClone(value); } catch { continue; }
      expect(shared.digest(value), label).toBe(sha(before.routing(strict)));
    }
  });

  it('rejects in digest what the strict snapshot refuses', () => {
    const refused = ['undefined', 'function', 'NaN', 'Infinity', 'cycle', 'array cycle', 'Date', 'Map', 'class instance', 'sparse array',
      'getter', 'symbol key', 'non-enumerable', 'undefined property', 'undefined in array', 'bigint', 'toJSON object'];
    const values = new Map(corpus());
    for (const label of refused) expect(() => shared.digest(values.get(label)), label).toThrow(TypeError);
  });

  it('differs from the dynamic-tools serializer only where undefined, functions or symbols meet arrays or the top level', () => {
    const differing = new Set<string>();
    for (const [label, value] of corpus()) {
      const a = outcome(shared.canonical, value), b = outcome(dynamicTools, value);
      if (JSON.stringify(a) !== JSON.stringify(b)) differing.add(label);
    }
    expect([...differing].sort()).toEqual(['function', 'function in array', 'symbol in array', 'symbol value', 'undefined', 'undefined in array']);
  });
});
