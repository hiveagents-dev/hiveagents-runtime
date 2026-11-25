import { types } from 'node:util';

export type StudyJson = null | boolean | number | string | StudyJson[] | { [key: string]: StudyJson };
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 512, MAX_NODES = 100000;
function invalid(): never { throw new TypeError('Expected strict JSON within 8MiB UTF8, depth512 and100000 nodes'); }
// Native slot predicates do not consult caller getters or the current prototype.
const intrinsicBrands = [types.isArgumentsObject, types.isAnyArrayBuffer, types.isArrayBufferView,
  types.isBoxedPrimitive, types.isDate, types.isExternal, types.isGeneratorObject, types.isMap,
  types.isMapIterator, types.isModuleNamespaceObject, types.isNativeError, types.isPromise,
  types.isRegExp, types.isSet, types.isSetIterator, types.isWeakMap, types.isWeakSet];

/** Normalize decimal spelling without expanding exponents or constructing large integer powers. */
function decimalIdentity(raw: string): string {
  const exponentAt = raw.search(/[eE]/), mantissa = exponentAt < 0 ? raw : raw.slice(0, exponentAt);
  const negative = mantissa[0] === '-', point = mantissa.indexOf('.');
  const fraction = point < 0 ? 0 : mantissa.length - point - 1;
  const digits = mantissa.slice(negative ? 1 : 0).replace('.', '');
  let start = 0, end = digits.length;
  while (start < end && digits[start] === '0') start++;
  if (start === end) return '0';
  while (digits[end - 1] === '0') end--;
  const exponent = exponentAt < 0 ? 0 : Number(raw.slice(exponentAt + 1));
  // Within the input bound, a larger exponent cannot cancel a nonzero mantissa into Number's finite range.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_BYTES + 400) invalid();
  return `${negative ? '-' : ''}${digits.slice(start, end)}e${exponent - fraction + digits.length - end}`;
}

/** Parse full JSON, preserving own keys and rejecting duplicate decoded object keys. */
export function parseStudyJson(text: string): StudyJson {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) invalid();
  let offset = 0, nodes = 0;
  const whitespace = () => { while (offset < text.length && /[\x20\t\n\r]/.test(text[offset]!)) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (char === '\\') offset++;
    }
    return invalid();
  };
  type Frame = { value: StudyJson[] | { [key: string]: StudyJson }; state: string; key?: string; keys?: Set<string> };
  const stack: Frame[] = [];
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const readValue = (): StudyJson => {
    if (++nodes > MAX_NODES) invalid();
    whitespace(); const char = text[offset];
    if (char === '"') return string();
    if (char === '[' || char === '{') {
      if (stack.length >= MAX_DEPTH) invalid();
      offset++; const value = char === '[' ? [] : Object.create(null);
      stack.push(char === '[' ? { value, state: 'arrayFirst' } : { value, state: 'objectFirst', keys: new Set() });
      return value;
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, offset)) { offset += token.length; return value; }
    }
    number.lastIndex = offset; const match = number.exec(text);
    if (!match) return invalid();
    offset = number.lastIndex; const value = Number(match[0]);
    if (!Number.isFinite(value) || decimalIdentity(match[0]) !== decimalIdentity(value.toString())) invalid();
    return value;
  };
  const result = readValue();
  while (stack.length) {
    whitespace(); const frame = stack.at(-1)!, char = text[offset];
    if (Array.isArray(frame.value)) {
      if (frame.state === 'arrayFirst' && char === ']') { offset++; stack.pop(); continue; }
      if (frame.state === 'after') {
        if (char === ']') { offset++; stack.pop(); continue; }
        if (char !== ',') invalid();
        offset++; frame.state = 'arrayValue'; continue;
      }
      frame.state = 'after'; frame.value.push(readValue());
    } else {
      if (frame.state === 'objectFirst' && char === '}') { offset++; stack.pop(); continue; }
      if (frame.state === 'after') {
        if (char === '}') { offset++; stack.pop(); continue; }
        if (char !== ',') invalid();
        offset++; frame.state = 'objectKey'; continue;
      }
      if (frame.state === 'objectFirst' || frame.state === 'objectKey') {
        if (char !== '"') invalid();
        const key = string();
        if (frame.keys!.has(key)) throw new TypeError('Duplicate JSON object key');
        frame.keys!.add(key); frame.key = key; frame.state = 'colon'; continue;
      }
      if (frame.state === 'colon') {
        if (char !== ':') invalid();
        offset++; frame.state = 'objectValue'; continue;
      }
      frame.state = 'after';
      Object.defineProperty(frame.value, frame.key!, { value: readValue(), enumerable: true, writable: true, configurable: true });
    }
  }
  whitespace(); if (offset !== text.length) invalid();
  return result;
}

/** Copy only own plain JSON descriptor values; never execute getters, proxies or serialization hooks. */
export function captureStudyJson(value: unknown): StudyJson {
  const active = new Set<object>(); let bytes = 0, nodes = 1; let result: StudyJson = null;
  const charge = (amount: number) => { bytes += amount; if (bytes > MAX_BYTES) invalid(); };
  type Work = { value: unknown; depth: number; assign: (value: StudyJson) => void } | { exit: object; copy: object };
  const work: Work[] = [{ value, depth: 0, assign: copy => { result = copy; } }];
  while (work.length) {
    const entry = work.pop()!;
    if ('exit' in entry) { active.delete(entry.exit); Object.freeze(entry.copy); continue; }
    const item = entry.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      charge(Buffer.byteLength(JSON.stringify(item), 'utf8')); entry.assign(item); continue;
    }
    if (!item || typeof item !== 'object' || types.isProxy(item) || active.has(item)) invalid();
    if (entry.depth >= MAX_DEPTH || intrinsicBrands.some(predicate => predicate(item))) invalid();
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) invalid();
    const names = (keys as string[]).filter(key => !array || key !== 'length');
    nodes += names.length; if (nodes > MAX_NODES) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && (names.length !== (item as unknown[]).length || names.some((key, i) => key !== String(i)))) invalid();
    charge(2 + Math.max(0, names.length - 1));
    for (const key of names) {
      const descriptor = descriptors[key]!;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
      if (!array) charge(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
    }
    const copy: StudyJson[] | { [key: string]: StudyJson } = array ? [] : Object.create(null);
    entry.assign(copy); active.add(item); work.push({ exit: item, copy });
    for (let i = names.length - 1; i >= 0; i--) {
      const key = names[i]!;
      work.push({ value: descriptors[key]!.value, depth: entry.depth + 1, assign: child => {
        Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true });
      } });
    }
  }
  return result;
}

/** Canonical JSON for already captured data, with no recursion or serialization hooks. */
export function canonicalStudyJson(value: StudyJson): string {
  const output: string[] = [], work: ({ value: StudyJson; depth: number } | { text: string })[] = [{ value, depth: 0 }];
  let nodes = 1, bytes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8'); if (bytes > MAX_BYTES) invalid(); output.push(text);
  };
  while (work.length) {
    const entry = work.pop()!;
    if ('text' in entry) { append(entry.text); continue; }
    const item = entry.value;
    if (item === null || typeof item !== 'object') { append(JSON.stringify(item)); continue; }
    if (entry.depth >= MAX_DEPTH) invalid();
    const array = Array.isArray(item), keys = array ? Object.keys(item) : Object.keys(item).sort();
    nodes += keys.length; if (nodes > MAX_NODES) invalid();
    append(array ? '[' : '{'); work.push({ text: array ? ']' : '}' });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      if (i < keys.length - 1) work.push({ text: ',' });
      work.push({ value: (item as Record<string, StudyJson>)[key]!, depth: entry.depth + 1 });
      if (!array) work.push({ text: `${JSON.stringify(key)}:` });
    }
  }
  return output.join('');
}
