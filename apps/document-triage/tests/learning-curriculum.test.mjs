import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createSecretKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseStudyJson, captureCurriculum, curriculumIdentity, verifyStudyOutput,
  studyTask, assertStudyProductionTask } from '../dist/learning-curriculum.js';
import { captureStudyJson, canonicalStudyJson } from '../dist/learning-json.js';

const limit = 8 * 1024 * 1024;
const task = (id, text = `Solve ${id}`, expected = { result: 42 }) => ({ id, text, expected });
function corpus() {
  return { format: 1, id: 'math-classification', oracle: 'json-exact-v1',
    study: { maxCycles: 4, maxLaunches: 10000, minNewTasks: 1 }, evaluation: { repetitions: 2 },
    train: [task('train')], fixed: [task('fixed')],
    freshBatches: [{ id: 'batch1', tasks: Array.from({ length: 6 }, (_, n) => task(`fresh${n}`)) }] };
}
const rejectCorpus = change => { const value = corpus(); change(value); assert.throws(() => captureCurriculum(value)); };

test('oracle accepts complete arbitrary JSON and equivalent object key order', () => {
  for (const value of [null, true, false, 42, -3.5, 'a\nquote"', [], {}, [1, '1', false, null],
    { category: 'urgent', metadata: { b: [1, 2], a: null } }]) {
    assert.deepEqual(verifyStudyOutput(JSON.stringify(value), value), { value: 1, passed: true });
  }
  assert.deepEqual(verifyStudyOutput('{"b":[1,2],"a":{"y":false,"x":null}}',
    { a: { x: null, y: false }, b: [1, 2] }), { value: 1, passed: true });
  assert.equal(verifyStudyOutput(' -0 \n', 0).passed, true);
});

test('oracle rejects partial matches, extra keys, changed arrays and changed primitive types', () => {
  for (const [text, expected] of [['{"answer":42,"extra":true}', { answer: 42 }],
    ['{"answer":42}', { answer: 42, proof: true }], ['[2,1]', [1, 2]], ['[1]', [1, 2]],
    ['"42"', 42], ['false', 0], ['null', {}], ['{"A":1}', { a: 1 }]]) {
    assert.deepEqual(verifyStudyOutput(text, expected), { value: 0, passed: false });
  }
});

test('strict parser rejects prose, fences, duplicate decoded keys, malformed JSON and overflow numbers', () => {
  for (const text of ['', 'answer: 1', '```json\n1\n```', 'NaN', 'Infinity', '-Infinity',
    '1e999', '[1e999]', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
    '{"outer":{"a":1,"\\u0061":1}}', '{"x":1,}', '[1,]', '01', '+1', '.1',
    'true false', '{a:1}', '"bad\nstring"', '\ufeffnull', '/* comment */null']) {
    assert.throws(() => parseStudyJson(text), undefined, text);
    assert.deepEqual(verifyStudyOutput(text, null), { value: 0, passed: false });
  }
  assert.throws(() => parseStudyJson(1));
  assert.equal(verifyStudyOutput(new Proxy({}, {}), null).passed, false);
});

test('numeric lexemes that change decimal value during Number conversion reject without oracle credit', () => {
  for (const [raw, rounded] of [['9007199254740993', 9007199254740992],
    ['-9007199254740993', -9007199254740992], ['1e-400', 0], ['-1e-400', 0],
    ['4e-324', 5e-324], ['0.10000000000000001', 0.1],
    ['1.234567890123456789', 1.2345678901234567], ['1000000000000000000001', 1e21]]) {
    assert.throws(() => parseStudyJson(raw), undefined, raw);
    assert.throws(() => parseStudyJson(`{"ordinal":${raw}}`), undefined, raw);
    assert.deepEqual(verifyStudyOutput(raw, rounded), { value: 0, passed: false });
  }
});

test('exact decimal spelling survives ordinary fractions, exponents, redundant zeros and large magnitudes', () => {
  for (const [raw, expected] of [['1.0', 1], ['1e0', 1], ['0.1', 0.1], ['0.10000000000000000', 0.1],
    ['12300e-2', 123], ['1e100', 1e100], ['10e99', 1e100], ['9007199254740992', 9007199254740992],
    ['1000000000000000100', 1000000000000000100], ['5e-324', 5e-324], ['-0.0e999999999', -0]]) {
    assert.equal(parseStudyJson(raw), expected, raw);
    assert.deepEqual(verifyStudyOutput(raw, expected), { value: 1, passed: true });
  }
});

test('parsed corpus labels cannot silently collide after precision loss or underflow', () => {
  for (const [raw, rounded] of [['9007199254740993', 9007199254740992], ['1e-400', 0]]) {
    const value = corpus(); value.train[0].expected = 'precision-label';
    const json = JSON.stringify(value), unsafe = json.replace('"precision-label"', raw);
    const roundedText = json.replace('"precision-label"', JSON.stringify(rounded));
    const known = curriculumIdentity(captureCurriculum(parseStudyJson(roundedText)));
    assert.equal(typeof known.baseDigest, 'string');
    assert.throws(() => curriculumIdentity(captureCurriculum(parseStudyJson(unsafe))));
  }
  const value = corpus(); value.train[0].expected = 1;
  const text = JSON.stringify(value);
  assert.equal(curriculumIdentity(captureCurriculum(parseStudyJson(text.replace('"expected":1', '"expected":1.0')))).baseDigest,
    curriculumIdentity(captureCurriculum(parseStudyJson(text))).baseDigest);
});

test('extreme numeric exponents remain bounded in a64MiB child without decimal expansion', () => {
  const module = new URL('../dist/learning-curriculum.js', import.meta.url).href;
  const source = `import { parseStudyJson, verifyStudyOutput } from ${JSON.stringify(module)};
    const digits = '9'.repeat(250000);
    const results = [verifyStudyOutput('1e-' + digits, 0),
      verifyStudyOutput('0.' + '0'.repeat(250000) + '1', 0),
      parseStudyJson('0e' + digits), parseStudyJson('1' + '0'.repeat(250000) + 'e-250000')];
    console.log(JSON.stringify(results));`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, cwd: '/tmp' });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [{ value: 0, passed: false }, { value: 0, passed: false }, 0, 1]);
});

test('parser preserves dangerous JSON keys as own data and enforces container depth512', () => {
  const value = parseStudyJson('{"__proto__":{"polluted":true},"constructor":1}');
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(value.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
  const text = '['.repeat(512) + '0' + ']'.repeat(512);
  assert.equal(verifyStudyOutput(text, parseStudyJson(text)).passed, true);
  assert.throws(() => parseStudyJson('[' + text + ']'));
  const deepest = parseStudyJson(text);
  assert.equal(canonicalStudyJson(captureStudyJson(deepest)), text);
  assert.throws(() => captureStudyJson([deepest]));
  assert.throws(() => canonicalStudyJson([deepest]));
});

test('all JSON traversals enforce100000 value nodes including the root', () => {
  const boundary = Array(99999).fill(0), text = JSON.stringify(boundary);
  assert.equal(parseStudyJson(text).length, 99999);
  assert.equal(captureStudyJson(boundary).length, 99999);
  assert.equal(canonicalStudyJson(boundary), text);
  boundary.push(0);
  assert.throws(() => parseStudyJson(JSON.stringify(boundary)));
  assert.throws(() => captureStudyJson(boundary));
  assert.throws(() => canonicalStudyJson(boundary));
  assert.deepEqual(verifyStudyOutput(JSON.stringify(boundary), null), { value: 0, passed: false });
});

test('250000 unclosed arrays score zero without aborting a64MiB Node child', () => {
  const module = new URL('../dist/learning-curriculum.js', import.meta.url).href;
  const source = `import { verifyStudyOutput } from ${JSON.stringify(module)};
    console.log(JSON.stringify(verifyStudyOutput('['.repeat(250000), null)));`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, cwd: '/tmp' });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { value: 0, passed: false });
});

test('JSON parser enforces 8MiB UTF8 including string quotes', () => {
  assert.equal(parseStudyJson('"' + 'a'.repeat(limit - 2) + '"').length, limit - 2);
  assert.throws(() => parseStudyJson('"' + 'a'.repeat(limit - 1) + '"'));
  assert.throws(() => parseStudyJson('"' + 'é'.repeat(limit / 2) + '"'));
});

test('capture snapshots and freezes all caller-owned structures synchronously', async () => {
  const input = corpus(), captured = captureCurriculum(input);
  const capturedTask = studyTask(input.train[0]);
  input.train[0].expected.result = 0; input.freshBatches[0].tasks[0].text = 'changed';
  input.study.maxCycles = 64;
  await Promise.resolve();
  assert.equal(captured.train[0].expected.result, 42);
  assert.equal(capturedTask.expected.result, 42);
  assert.equal(captured.study.maxCycles, 4);
  assert.equal(captured.freshBatches[0].tasks[0].text, 'Solve fresh0');
  for (const obj of [captured, captured.study, captured.evaluation, captured.train, captured.train[0],
    captured.train[0].expected, captured.freshBatches, captured.freshBatches[0], captured.freshBatches[0].tasks,
    capturedTask, capturedTask.expected]) assert.equal(Object.isFrozen(obj), true);
});

test('strict own JSON rejects proxies and getters without executing their hooks', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('hook executed'); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const hostile of [proxy, revoked.proxy, { get value() { return trap(); } }]) {
    assert.throws(() => captureCurriculum(hostile));
    assert.throws(() => studyTask(task('outside', 'outside', hostile)));
    assert.throws(() => curriculumIdentity(hostile));
    assert.throws(() => assertStudyProductionTask(corpus(), hostile));
    assert.throws(() => verifyStudyOutput('null', hostile));
  }
  const withGetter = corpus();
  Object.defineProperty(withGetter.train[0], 'text', { get: trap, enumerable: true });
  assert.throws(() => captureCurriculum(withGetter));
  assert.equal(calls, 0);
});

test('capture rejects inherited proxy prototypes without reading their properties', () => {
  let calls = 0;
  const inherited = Object.create(new Proxy({}, { get() { calls++; return undefined; } }));
  assert.throws(() => studyTask(task('outside', 'outside', inherited)));
  assert.throws(() => verifyStudyOutput('{}', inherited));
  assert.equal(calls, 0);
});

test('capture rejects crypto brand symbol getters without reading them', () => {
  let calls = 0;
  const key = Reflect.ownKeys(createSecretKey(Buffer.from('x')))[0];
  assert.equal(typeof key, 'symbol');
  const expected = Object.defineProperty({}, key, { enumerable: true, get() { calls++; return undefined; } });
  assert.throws(() => studyTask(task('outside', 'outside', expected)));
  assert.throws(() => verifyStudyOutput('{}', expected));
  assert.equal(calls, 0);
});

test('strict JSON rejects nonplain objects, accessors, sparse arrays, symbols, cycles and nonJSON values', () => {
  const cycle = {}; cycle.self = cycle;
  const symbol = { [Symbol('hidden')]: true };
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
  const arrayExtra = [1]; arrayExtra.extra = true;
  const inherited = Object.create({ surprise: true });
  for (const expected of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, new Date(), new Map(),
    Object(1), cycle, symbol, hidden, Array(2), arrayExtra, inherited, { toJSON() { throw Error('hook'); } }]) {
    assert.throws(() => studyTask({ id: 'outside', text: 'outside', expected }));
  }
  const nullObject = Object.create(null); nullObject.answer = 1;
  assert.equal(studyTask(task('valid', 'valid', nullObject)).expected.answer, 1);
});

test('intrinsic brands reject after prototype erasure and cannot earn false oracle credit', () => {
  const factories = [() => new Map([['answer', 42]]), () => new Date(123), () => new Set([42]),
    () => Object(42), () => Object(true), () => Object('label'), () => /answer/,
    () => new WeakMap(), () => new WeakSet(), () => new Uint8Array(1), () => new ArrayBuffer(1),
    () => new DataView(new ArrayBuffer(1)), () => Promise.resolve(42), () => new Error('answer'),
    () => new Map().entries(), () => new Set().values()];
  for (const proto of [null, Object.prototype]) for (const factory of factories) {
    const value = factory(); Object.setPrototypeOf(value, proto);
    assert.throws(() => studyTask(task('outside', 'outside', value)));
    assert.throws(() => verifyStudyOutput('{}', value));
    rejectCorpus(corpus => { corpus.train[0].expected = value; });
  }
});

test('all corpus fields are required and unknown fields reject at every schema level', () => {
  for (const path of [[], ['study'], ['evaluation'], ['train', 0], ['freshBatches', 0]]) {
    rejectCorpus(value => { let target = value; for (const key of path) target = target[key]; target.extra = true; });
  }
  for (const key of Object.keys(corpus())) rejectCorpus(value => { delete value[key]; });
  for (const key of ['maxCycles', 'maxLaunches', 'minNewTasks']) rejectCorpus(value => { delete value.study[key]; });
  rejectCorpus(value => { delete value.evaluation.repetitions; });
  rejectCorpus(value => { delete value.freshBatches[0].id; });
  rejectCorpus(value => { delete value.freshBatches[0].tasks; });
  for (const key of ['id', 'text', 'expected']) assert.throws(() => {
    const value = task('outside'); delete value[key]; studyTask(value);
  });
  rejectCorpus(value => { value.format = 2; }); rejectCorpus(value => { value.oracle = 'self-grade'; });
});

test('IDs obey the complete ASCII identifier grammar at every boundary', () => {
  for (const id of ['', '-leading', ' space', 'a/b', 'a\n', 'é', 'a'.repeat(129)]) {
    assert.throws(() => studyTask(task(id)));
    rejectCorpus(value => { value.id = id; });
    rejectCorpus(value => { value.freshBatches[0].id = id; });
  }
  assert.equal(studyTask(task('A0._:-')).id, 'A0._:-');
  assert.equal(studyTask(task('a'.repeat(128))).id.length, 128);
});

test('prompt and overall corpus limits count UTF8 bytes', () => {
  assert.equal(studyTask(task('outside', 'é'.repeat(16384))).text.length, 16384);
  assert.throws(() => studyTask(task('outside', 'é'.repeat(16385))));
  assert.throws(() => studyTask(task('outside', 'x'.repeat(32769))));
  rejectCorpus(value => { value.train[0].expected = 'x'.repeat(limit); });
  rejectCorpus(value => { value.fixed[0].expected = { a: 'x'.repeat(limit / 2), b: 'x'.repeat(limit / 2) }; });
  assert.throws(() => studyTask(task('outside', 'outside', 'x'.repeat(limit))));
});

test('blank prompts reject while meaningful prompt whitespace remains unchanged', () => {
  for (const text of ['', ' ', '\t\r\n', '\u2003']) {
    assert.throws(() => studyTask(task('outside', text)));
    rejectCorpus(value => { value.train[0].text = text; });
  }
  assert.equal(studyTask(task('outside', '  Solve outside  ')).text, '  Solve outside  ');
});

test('integer study and evaluation bounds reject zero, overflow, fractions and coercion', () => {
  for (const [field, max] of [['maxCycles', 64], ['maxLaunches', 10000], ['minNewTasks', 128]]) {
    for (const bad of [0, -1, max + 1, 1.5, '1', NaN, Infinity]) rejectCorpus(value => { value.study[field] = bad; });
    const value = corpus(); value.study[field] = max; assert.doesNotThrow(() => captureCurriculum(value));
  }
  for (const bad of [0, 9, 1.5, '1']) rejectCorpus(value => { value.evaluation.repetitions = bad; });
  const value = corpus(); value.evaluation.repetitions = 8; assert.doesNotThrow(() => captureCurriculum(value));
});

test('split, batch, global count and fresh6 bounds reject empty or oversized plans', () => {
  for (const [field, max] of [['train', 128], ['fixed', 64]]) {
    rejectCorpus(value => { value[field] = []; });
    rejectCorpus(value => { value[field] = Array.from({ length: max + 1 }, (_, i) => task(`extra${i}`)); });
    const value = corpus(); value[field] = Array.from({ length: max }, (_, i) => task(`extra${i}`));
    assert.doesNotThrow(() => captureCurriculum(value));
  }
  rejectCorpus(value => { value.freshBatches = []; });
  rejectCorpus(value => { value.freshBatches[0].tasks.pop(); });
  rejectCorpus(value => { value.freshBatches[0].tasks = Array.from({ length: 129 }, (_, i) => task(`extra${i}`)); });
  const many = (batches, tasks) => Array.from({ length: batches }, (_, i) => ({ id: `batch${i}`,
    tasks: Array.from({ length: tasks }, (_, j) => task(`batch${i}-task${j}`)) }));
  rejectCorpus(value => { value.study.maxCycles = 1; value.freshBatches.push({ id: 'second', tasks: many(1, 6)[0].tasks }); });
  rejectCorpus(value => { value.study.maxCycles = 64; value.freshBatches = many(65, 6); });
  rejectCorpus(value => { value.study.maxCycles = 64; value.freshBatches = many(32, 128); });
  const boundary = corpus(); boundary.study.maxCycles = 64; boundary.freshBatches = many(31, 128);
  boundary.freshBatches.push({ id: 'last', tasks: Array.from({ length: 126 }, (_, i) => task(`last${i}`)) });
  assert.equal(curriculumIdentity(captureCurriculum(boundary)).batches.length, 32);
});

test('all task IDs, prompt hashes and batch IDs are unique across splits', () => {
  rejectCorpus(value => { value.fixed[0].id = value.train[0].id; });
  rejectCorpus(value => { value.fixed[0].text = value.train[0].text; value.fixed[0].expected = null; });
  rejectCorpus(value => { value.freshBatches[0].tasks[0].text = value.fixed[0].text; });
  rejectCorpus(value => { value.freshBatches[0].tasks[1].text = value.freshBatches[0].tasks[0].text; });
  rejectCorpus(value => { value.freshBatches.push({ id: 'batch1', tasks: Array.from({ length: 6 }, (_, i) => task(`new${i}`)) }); });
});

test('base identity survives appends and ignores object key order while batches bind all content', () => {
  const original = corpus(), first = curriculumIdentity(original);
  original.freshBatches.push({ id: 'batch2', tasks: Array.from({ length: 6 }, (_, i) => task(`next${i}`)) });
  const appended = curriculumIdentity(original);
  assert.equal(appended.baseDigest, first.baseDigest);
  assert.equal(appended.batches[0].digest, first.batches[0].digest);
  assert.equal(appended.batches.length, 2);
  original.train[0].expected = { z: 1, a: 2 };
  const order1 = curriculumIdentity(original);
  original.train[0].expected = { a: 2, z: 1 };
  assert.equal(curriculumIdentity(original).baseDigest, order1.baseDigest);
  const prior = curriculumIdentity(original);
  original.freshBatches[1].tasks[0].expected = false;
  assert.notEqual(curriculumIdentity(original).batches[1].digest, prior.batches[1].digest);
  original.freshBatches[1].id = 'renamed';
  assert.notEqual(curriculumIdentity(original).batches[1].digest, appended.batches[1].digest);
  for (const obj of [first, first.train, first.train[0], first.batches, first.batches[0], first.batches[0].tasks]) {
    assert.equal(Object.isFrozen(obj), true);
  }
});

test('every valid foundation mutation changes the base digest, including labels and ordered tasks', () => {
  const original = corpus(), initial = curriculumIdentity(original).baseDigest;
  for (const mutate of [v => { v.id = 'other'; }, v => { v.study.maxCycles++; },
    v => { v.study.maxLaunches--; }, v => { v.study.minNewTasks++; }, v => { v.evaluation.repetitions++; },
    v => { v.train[0].id = 'rename'; }, v => { v.train[0].text = 'other text'; },
    v => { v.train[0].expected = null; }, v => { v.fixed[0].id = 'rename'; },
    v => { v.fixed[0].text = 'other text'; }, v => { v.fixed[0].expected = 0; },
    v => { v.train.push(task('another')); }, v => { v.fixed.push(task('another')); }]) {
    const value = corpus(); mutate(value); assert.notEqual(curriculumIdentity(value).baseDigest, initial);
  }
  original.train.push(task('another')); const before = curriculumIdentity(original).baseDigest;
  original.train.reverse(); assert.notEqual(curriculumIdentity(original).baseDigest, before);
});

test('input SHA256 is prompt bytes only, independent of ID and expected JSON', () => {
  const value = corpus(); value.train[0] = task('abc1', 'abc', { b: 2, a: 1 });
  const first = curriculumIdentity(value).train[0];
  assert.equal(first.inputDigest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const knownExpected = createHash('sha256').update('{"a":1,"b":2}').digest('hex');
  assert.equal(first.expectedDigest, knownExpected);
  value.train[0] = task('abc2', 'abc', 99);
  const second = curriculumIdentity(value).train[0];
  assert.equal(second.inputDigest, first.inputDigest); assert.notEqual(second.expectedDigest, first.expectedDigest);
});

test('production rejects every protected prompt even after ID and label changes', () => {
  const value = corpus();
  for (const protectedTask of [...value.train, ...value.fixed, ...value.freshBatches[0].tasks]) {
    assert.throws(() => assertStudyProductionTask(value, task('new-id', protectedTask.text, 'wrong label')));
  }
  assert.doesNotThrow(() => assertStudyProductionTask(value, task('outside', 'entirely new', false)));
  assert.throws(() => assertStudyProductionTask(value, { id: 'outside', text: 'new', expected: null, extra: true }));
});
