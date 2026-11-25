import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const main = new URL('../dist/main.js', import.meta.url).pathname;
const fixture = new URL('./fixtures/learning-cli.mjs', import.meta.url).pathname;
async function scenario(run) {
  const directory = await mkdtemp(join(tmpdir(), 'oar-learning-app-'));
  const calls = join(directory, 'calls.jsonl'), config = join(directory, 'agent.json');
  await writeFile(config, JSON.stringify({ model: { mode: 'auto', allowUnverifiedModels: true,
    candidates: [{ id: 'sol', model: 'codex/gpt-5.6-sol', effort: 'low' }, { id: 'sonnet', model: 'claude/claude-sonnet-5', effort: 'low' }] },
    transport: 'exec', requireAuth: 'subscription', permissions: { mode: 'analyze' } }));
  const env = { ...process.env, OAR_CODEX_COMMAND: process.execPath, OAR_CODEX_ARGS_JSON: JSON.stringify([fixture, 'codex']),
    OAR_CLAUDE_COMMAND: process.execPath, OAR_CLAUDE_ARGS_JSON: JSON.stringify([fixture, 'claude']), OAR_LEARNING_CALLS: calls,
    OAR_LEARNING_FIXTURE_MODE: 'normal' };
  const invoke = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [main, ...args], { cwd: directory, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout) : undefined };
  };
  const count = async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length; }
    catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
  try { await run({ directory, config, calls, invoke, count }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('learning preflights the complete launch budget before any model turn', () => scenario(async ({ directory, config, invoke, count }) => {
  const result = invoke(['learn-cycle', '--config', config, '--state-dir', directory, '--max-launches', '1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /budget|max-launches/i);
  assert.equal(await count(), 0);
  const total = invoke(['learn-cycle', '--config', config, '--state-dir', directory, '--max-launches', '128', '--total-launches', '1']);
  assert.notEqual(total.status, 0);
  assert.match(total.stderr, /total-launches/i);
  assert.equal(await count(), 0);
  const input = join(directory, 'task.json'); await writeFile(input, JSON.stringify({ kind: 'arithmetic', seed: 78 }));
  const automatic = invoke(['learn-run', '--config', config, '--state-dir', directory, '--input', input, '--auto-improve', '--max-launches', '1']);
  assert.notEqual(automatic.status, 0);
  assert.match(automatic.stderr, /budget|max-launches/i);
  assert.equal(await count(), 0);
}));

test('measured task outcomes learn different model choices, promote and survive another process', () => scenario(async ({ directory, config, invoke, count }) => {
  const firstInput = join(directory, 'production.json');
  await writeFile(firstInput, JSON.stringify({ kind: 'classification', seed: 20 }));
  const automatic = invoke(['learn-run', '--config', config, '--state-dir', directory, '--input', firstInput, '--auto-improve', '--max-launches', '128']);
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(automatic.json.maintenance.status, 'completed');
  const cycle = { json: automatic.json.improvement };
  assert.equal(cycle.json.routingApiCalls, 0);
  assert.equal(cycle.json.gate.status, 'promoted');
  assert.equal(cycle.json.pointer.generation, 1);
  assert.ok(cycle.json.requestedModelTurns <= 128);
  assert.equal(await count(), cycle.json.requestedModelTurns);
  assert.ok(cycle.json.comparison.learnedPassRate > cycle.json.comparison.incumbentPassRate);
  assert.ok(cycle.json.comparison.learnedPassRate > cycle.json.comparison.bestFixedPassRate);
  const status = invoke(['learn-status', '--config', config, '--state-dir', directory]);
  assert.equal(status.status, 0, status.stderr);
  assert.notEqual(status.json.pid, cycle.json.pid);
  assert.equal(status.json.pointer.active, cycle.json.pointer.active);
  for (const [kind, expected] of [['classification', 'claude'], ['arithmetic', 'codex']]) {
    const input = join(directory, `${kind}.json`);
    await writeFile(input, JSON.stringify({ kind, seed: 811 }));
    const result = invoke(['learn-run', '--config', config, '--state-dir', directory, '--input', input, '--max-launches', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.receipt.selected.provider, expected);
    assert.equal(result.json.observation.quality.state, 'verified');
    assert.equal(result.json.observation.quality.passed, true);
    assert.equal(result.json.pointer.active, cycle.json.pointer.active, 'New feedback changes shadow, not the frozen active model');
  }
  assert.equal(await count(), cycle.json.requestedModelTurns + 2);
  const original = await readFile(config, 'utf8'), changed = JSON.parse(original);
  changed.model.candidates[0].effort = 'medium';
  await writeFile(config, JSON.stringify(changed));
  const incompatible = invoke(['learn-cycle', '--config', config, '--state-dir', directory, '--max-launches', '128']);
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /lineage.*separate --state-dir/i);
  assert.equal(await count(), cycle.json.requestedModelTurns + 2, 'Incompatible lineage must reject before another model turn');
  await writeFile(config, original);
  const rollback = invoke(['learn-cycle', '--config', config, '--state-dir', directory, '--max-launches', '64', '--operation', 'rollback'],
    { OAR_LEARNING_FIXTURE_MODE: 'drift' });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(rollback.json.gate.status, 'rolled-back');
  assert.equal(rollback.json.pointer.generation, 2);
  assert.equal(rollback.json.pointer.active, null);
}));

test('censored execution records no fabricated quality and performs no fallback turn', () => scenario(async ({ directory, config, invoke, count }) => {
  const input = join(directory, 'input.json'); await writeFile(input, JSON.stringify({ kind: 'arithmetic', seed: 71 }));
  const result = invoke(['learn-run', '--config', config, '--state-dir', directory, '--input', input,
    '--max-launches', '1', '--timeout-ms', '5000'], { OAR_LEARNING_FIXTURE_MODE: 'wait' });
  assert.notEqual(result.status, 0);
  assert.equal(await count(), 1);
  const status = invoke(['learn-status', '--config', config, '--state-dir', directory, '--timeout-ms', '5000']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.observations.length, 1);
  assert.equal(status.json.observations[0].observation.quality.state, 'unknown');
  assert.notEqual(status.json.observations[0].observation.latency.state, 'observed');
}));
