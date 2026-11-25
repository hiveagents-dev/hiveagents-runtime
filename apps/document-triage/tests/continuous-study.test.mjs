import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const main = new URL('../dist/main.js', import.meta.url).pathname;
const fixture = new URL('./fixtures/learning-cli.mjs', import.meta.url).pathname;
const prompt = detail => `CLASSIFICATION_TASK. Classify the incident into network, backups, or other. Return only JSON with exactly one field answer.\nDOCUMENT: The VPN certificate expired for ${detail} remote devices; their connections fail.`;
const task = (id, detail) => ({ id, text: prompt(detail), expected: { answer: 'network' } });
const hash = value => createHash('sha256').update(value).digest('hex');
async function stateFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(directory, prefix))) {
    const path = join(prefix, entry), absolute = join(directory, path), info = await lstat(absolute);
    assert.equal(info.isSymbolicLink(), false);
    if (info.isDirectory()) files.push(...await stateFiles(directory, path));
    else { assert.equal(info.isFile(), true); files.push({ path, sha256: hash(await readFile(absolute)) }); }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function scenario(body) {
  const directory = await mkdtemp(join(tmpdir(), 'oar-continuous-app-'));
  const config = join(directory, 'agent.json'), corpusPath = join(directory, 'corpus.json'), calls = join(directory, 'calls.jsonl');
  const corpus = { format: 1, id: 'supplied-network-study', oracle: 'json-exact-v1',
    study: { maxCycles: 4, maxLaunches: 160, minNewTasks: 2 }, evaluation: { repetitions: 1 },
    train: Array.from({ length: 16 }, (_, n) => task(`train-${n}`, n + 1)), fixed: [task('fixed', 101)],
    freshBatches: [{ id: 'batch-a', tasks: Array.from({ length: 8 }, (_, n) => task(`fresh-a-${n}`, n + 201)) }] };
  corpus.train[0].text += ' CANARY_STUDY_RAW_DO_NOT_PERSIST';
  await writeFile(config, JSON.stringify({ model: { mode: 'auto', allowUnverifiedModels: true, candidates: [
    { id: 'sol', model: 'codex/gpt-5.6-sol', effort: 'low' }, { id: 'sonnet', model: 'claude/claude-sonnet-5', effort: 'low' },
  ] }, transport: 'exec', requireAuth: 'subscription', permissions: { mode: 'analyze' } }));
  const save = () => writeFile(corpusPath, JSON.stringify(corpus)); await save();
  const env = { ...process.env, OAR_CODEX_COMMAND: process.execPath, OAR_CODEX_ARGS_JSON: JSON.stringify([fixture, 'codex']),
    OAR_CLAUDE_COMMAND: process.execPath, OAR_CLAUDE_ARGS_JSON: JSON.stringify([fixture, 'claude']),
    OAR_LEARNING_CALLS: calls, OAR_LEARNING_FIXTURE_MODE: 'normal' };
  const invoke = (command, args = [], extra = {}) => {
    const result = spawnSync(process.execPath, [main, command, '--config', config, '--corpus', corpusPath, '--state-dir', directory, ...args],
      { cwd: directory, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout) : undefined };
  };
  const count = async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
  try { await body({ directory, corpus, corpusPath, config, save, invoke, count }); }
  finally { if (process.env.OAR_CONSUMER_KEEP !== '1') await rm(directory, { recursive: true, force: true }); }
}

test('supplied studies resume across processes, append beyond three batches, defer repeated feedback and roll back', () => scenario(async ({ directory, corpus, save, invoke, count }) => {
  const chunk = invoke('study-cycle', ['--max-launches', '4', '--batch-id', 'batch-a']);
  assert.equal(chunk.status, 0, chunk.stderr);
  assert.equal(chunk.json.status, 'paused');
  assert.equal(chunk.json.invocationAttempts, 4);
  assert.equal(await count(), 4);
  const resumed = invoke('study-cycle', ['--max-launches', '100', '--batch-id', 'batch-a']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.status, 'completed');
  assert.equal(resumed.json.cycles[0].commit.status, 'promoted');
  assert.equal(await count(), 50, 'Only one16x2 calibration and first2+16 matrix');
  const domain = resumed.json.domain, active = resumed.json.pointer.active;
  const replay = invoke('study-cycle', ['--max-launches', '1', '--batch-id', 'batch-a']);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.json.invocationAttempts, 0);
  assert.deepEqual(replay.json.cycles, resumed.json.cycles);
  assert.equal(await count(), 50);
  const status = invoke('study-status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.domain, domain);
  assert.equal(status.json.pointer.active, active);

  corpus.freshBatches.push({ id: 'batch-b', tasks: Array.from({ length: 8 }, (_, n) => task(`fresh-b-${n}`, 301 + n)) }); await save();
  const input = join(directory, 'production.json');
  await writeFile(input, JSON.stringify(task('production-one', 1001)));
  const first = invoke('study-run', ['--input', input, '--auto-improve', '--max-launches', '100']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.observation.quality.passed, true);
  assert.equal(first.json.maintenance.status, 'deferred');
  assert.equal(await count(), 51);
  await writeFile(input, JSON.stringify(task('production-repeat', 1001)));
  const repeated = invoke('study-run', ['--input', input, '--auto-improve', '--max-launches', '100']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.json.maintenance.status, 'deferred');
  assert.equal(await count(), 52, 'Repeated content does not refresh cadence');
  await writeFile(input, JSON.stringify(task('production-two', 1002)));
  const maintained = invoke('study-run', ['--input', input, '--auto-improve', '--max-launches', '100']);
  assert.equal(maintained.status, 0, maintained.stderr);
  assert.equal(maintained.json.maintenance.status, 'completed');
  assert.equal(maintained.json.domain, domain);
  assert.equal(await count(), 71, 'Second calibration must not be launched');

  corpus.freshBatches.push({ id: 'batch-c', tasks: Array.from({ length: 8 }, (_, n) => task(`fresh-c-${n}`, 401 + n)) }); await save();
  const third = invoke('study-cycle', ['--max-launches', '18', '--batch-id', 'batch-c']);
  assert.equal(third.status, 0, third.stderr); assert.equal(third.json.domain, domain);
  assert.equal(await count(), 89);
  corpus.freshBatches.push({ id: 'batch-d', tasks: Array.from({ length: 8 }, (_, n) => task(`fresh-d-${n}`, 501 + n)) }); await save();
  const fourth = invoke('study-cycle', ['--max-launches', '18', '--batch-id', 'batch-d', '--operation', 'rollback'], { OAR_LEARNING_FIXTURE_MODE: 'drift' });
  assert.equal(fourth.status, 0, fourth.stderr);
  assert.equal(fourth.json.domain, domain);
  assert.equal(fourth.json.cycles[0].commit.status, 'rolled-back');
  assert.equal(fourth.json.pointer.active, null);
  assert.equal(await count(), 107);
  const modified = corpus.freshBatches[0].tasks[0].expected;
  corpus.freshBatches[0].tasks[0].expected = { answer: 'other' }; await save();
  const relabel = invoke('study-cycle', ['--max-launches', '1', '--batch-id', 'batch-a']);
  assert.notEqual(relabel.status, 0);
  assert.equal(await count(), 107, 'Changed history rejects before another model turn');
  corpus.freshBatches[0].tasks[0].expected = modified;
  await save();
  const final = invoke('study-status');
  assert.equal(final.status, 0, final.stderr);
  assert.equal(final.json.registeredBatches.length, 4);
  assert.equal(final.json.admittedAttempts, 107);
  const files = await stateFiles(directory);
  for (const file of files.filter(file => /^learning(?:-study)?[\\/]/.test(file.path))) {
    assert.equal((await readFile(join(directory, file.path))).includes(Buffer.from('CANARY_STUDY_RAW_DO_NOT_PERSIST')), false, file.path);
  }
  if (process.env.OAR_CONSUMER_KEEP === '1') {
    const receipt = { kind: 'installed-app-continuous-study-fixtures', passed: true, directory, node: process.version,
      domain, chunk: chunk.json, resumed: resumed.json, replay: replay.json,
      cadence: [first.json, repeated.json], maintained: maintained.json, third: third.json, fourth: fourth.json,
      final: final.json, fixtureCalls: 107, calibrationCalls: 32, registeredBatches: 4, realModelTurns: 0, routingApiCalls: 0,
      files };
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    await writeFile(join(directory, 'continuous-proof.json'), bytes, { mode: 0o600, flag: 'wx' });
    console.log('OAR_CONTINUOUS_PROOF ' + JSON.stringify({ directory, sha256: hash(bytes) }));
  }
}));

test('invalid or protected supplied data consumes no provider turns', () => scenario(async ({ directory, corpus, save, invoke, count }) => {
  corpus.id = 's'.repeat(128); await save();
  const inspect = invoke('study-status', [], { OAR_CLAUDE_COMMAND: 'relative-invalid-target' });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(await count(), 0, 'Status accepts the complete ID range without provider probes');
  corpus.freshBatches[0].tasks[0].text = corpus.train[0].text; await save();
  const duplicate = invoke('study-cycle', ['--max-launches', '4']);
  assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /duplicate|overlap|digest|unique/i); assert.equal(await count(), 0);
  corpus.freshBatches[0].tasks[0].text = prompt(201); await save();
  const input = join(directory, 'protected.json'); await writeFile(input, JSON.stringify({ ...corpus.fixed[0], id: 'renamed' }));
  const protectedRun = invoke('study-run', ['--input', input, '--max-launches', '1']);
  assert.notEqual(protectedRun.status, 0); assert.match(protectedRun.stderr, /protected|corpus/i); assert.equal(await count(), 0);
  corpus.id = 'budget-study'; corpus.study.maxLaunches = 1; await save();
  const insufficient = invoke('study-cycle', ['--max-launches', '1']);
  assert.notEqual(insufficient.status, 0); assert.match(insufficient.stderr, /budget|cap|limit|maxLaunches/i); assert.equal(await count(), 0);
}));

// An expected-value-only secret must be hashed even before any successful calibration.
test('study journal and evidence retain neither prompt nor expected-value canaries',()=>scenario(async({directory,corpus,save,invoke,count})=>{
  const expected='CANARY_EXPECTED_ONLY_DO_NOT_PERSIST';corpus.train[0].expected={answer:expected};await save();
  const result=invoke('study-cycle',['--max-launches','1']);assert.equal(result.status,0,result.stderr);assert.equal(await count(),1);
  const files=(await stateFiles(directory)).filter(file=>/^learning(?:-study)?[\\/]/.test(file.path));
  assert.ok(files.some(file=>file.path.startsWith('learning-study/')));assert.ok(files.some(file=>file.path.startsWith('learning/')));
  for(const file of files){const bytes=await readFile(join(directory,file.path));for(const canary of [expected,'CANARY_STUDY_RAW_DO_NOT_PERSIST'])assert.equal(bytes.includes(Buffer.from(canary)),false,file.path);}
}));
