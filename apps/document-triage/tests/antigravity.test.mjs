import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Agent, UnsupportedCapabilityError } from 'hiveagents-runtime';
import { createAppRuntime } from '../dist/runtime.js';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(app, 'tests/fixtures/fake-antigravity.mjs');
const geminiFixture = join(app, 'tests/fixtures/fake-gemini.mjs');
const model = 'antigravity/gemini-3.8-flash-low';
const uuid = '11111111-2222-4333-8444-555555555555';

async function sandbox(run) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'triage-antigravity-test-')));
  try {
    const prompt = join(directory, 'prompt.txt');
    await writeFile(prompt, '/literal @data');
    const calls = join(directory, 'calls.jsonl');
    const environment = { ...process.env, OAR_ANTIGRAVITY_COMMAND: process.execPath,
      OAR_ANTIGRAVITY_ARGS_JSON: JSON.stringify([fixture]), OAR_GEMINI_COMMAND: process.execPath,
      OAR_GEMINI_ARGS_JSON: JSON.stringify([geminiFixture]), OAR_FIXTURE_CALLS: calls };
    const command = (args, expectSuccess = true, extraEnvironment = {}) => {
      const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
        cwd: app, env: { ...environment, ...extraEnvironment }, encoding: 'utf8', timeout: 30_000,
      });
      if (expectSuccess) assert.equal(result.status, 0, result.stderr || result.stdout);
      return expectSuccess ? JSON.parse(result.stdout) : result;
    };
    const sendArgs = ['session-send', '--prompt-file', prompt, '--model', model, '--cwd', directory,
      '--ref-out', join(directory, 'ref.json')];
    await run({ directory, prompt, calls, command, environment, sendArgs });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('doctor registers four providers without prompting either external native fixture', async () => {
  await sandbox(async ({ command, calls }) => {
    const report = command(['doctor']);
    assert.deepEqual(report.providers.map(provider => provider.provider).sort(), ['antigravity', 'claude', 'codex', 'gemini']);
    const antigravity = report.providers.find(provider => provider.provider === 'antigravity');
    assert.equal(antigravity.installation.installed, true);
    assert.equal(antigravity.installation.version, '1.5.3');
    await assert.rejects(readFile(calls), error => error.code === 'ENOENT');
  });
});

test('session-send uses two independent processes to recover only the persisted native nonce', async () => {
  await sandbox(async ({ directory, prompt, calls, command, sendArgs }) => {
    const nonce = 'fixture-hidden-nonce-69731';
    await writeFile(prompt, `MEMORIZE ${nonce}`);
    const first = command(sendArgs);
    assert.equal(first.text, 'saved');
    assert.equal(first.status, 'completed');
    assert.equal(first.toolEvents, 0);
    assert.equal(first.session.id, uuid);
    assert.equal(first.session.provider, 'antigravity');
    assert.equal(first.session.cwd, directory);
    assert.equal(first.enforcement.requested.mode, 'edit');
    assert.match(first.enforcement.effective.approvals, /request-review/);
    const savedRef = JSON.parse(await readFile(join(directory, 'ref.json'), 'utf8'));
    assert.equal(savedRef.id, uuid);
    assert.equal(savedRef.transport, 'exec');
    await writeFile(prompt, 'Return the stored nonce.');
    const resumed = command([...sendArgs, '--ref', join(directory, 'ref.json')]);
    assert.equal(resumed.text, nonce);
    assert.equal(resumed.session.id, uuid);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.toolEvents, 0);
    assert.equal(resumed.usage.costMeaning, 'unavailable');
    assert.equal(resumed.usage.inputTokens, undefined);
    const launches = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].args.some(argument => argument === '--conversation'), false);
    assert.equal(launches[1].args[launches[1].args.indexOf('--conversation') + 1], uuid);
    assert.equal(launches[1].prompt.includes(nonce), false);
  });
});

test('session-send preserves literal prompt text without classification output validation', async () => {
  await sandbox(async ({ command, sendArgs }) => {
    const result = command(sendArgs);
    assert.equal(result.text, 'literal:/literal @data');
    assert.equal(result.status, 'completed');
  });
});

test('prompt bounds and required, duplicate, or invalid arguments fail before a native turn', async () => {
  await sandbox(async ({ prompt, calls, command, sendArgs }) => {
    for (const content of ['', '  \n', 'a\0b', 'a'.repeat(65_537), Buffer.from([0xc3, 0x28])]) {
      await writeFile(prompt, content);
      const result = command(sendArgs, false);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /prompt/i);
    }
    await writeFile(prompt, 'Valid prompt');
    for (const flag of ['--cwd', '--ref-out', '--model', '--prompt-file']) {
      const index = sendArgs.indexOf(flag);
      const args = [...sendArgs.slice(0, index), ...sendArgs.slice(index + 2)];
      const result = command(args, false);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(flag));
    }
    const duplicate = command([...sendArgs, '--model', model], false);
    assert.match(duplicate.stderr, /duplicate/);
    const relativeExecutable = command(sendArgs, false, { OAR_ANTIGRAVITY_COMMAND: 'relative-agy' });
    assert.match(relativeExecutable.stderr, /OAR_ANTIGRAVITY_COMMAND/);
    const invalidPrefix = command(sendArgs, false, { OAR_ANTIGRAVITY_ARGS_JSON: '{"not":"array"}' });
    assert.match(invalidPrefix.stderr, /OAR_ANTIGRAVITY_ARGS_JSON/);
    await assert.rejects(readFile(calls), error => error.code === 'ENOENT');
  });
});

test('invalid native references and unsuccessful results cannot overwrite a saved reference', async () => {
  await sandbox(async ({ directory, calls, command, sendArgs }) => {
    const refPath = join(directory, 'input-ref.json');
    await writeFile(refPath, JSON.stringify({ schemaVersion: 1, provider: 'antigravity', id: 'not-a-uuid',
      model: 'gemini-3.8-flash-low', cwd: directory, transport: 'exec', persistence: 'provider',
      createdAt: '2026-11-08T00:00:00.000Z' }));
    const invalid = command([...sendArgs, '--ref', refPath], false);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /UUID|session reference/i);
    await assert.rejects(readFile(calls), error => error.code === 'ENOENT');
    const failed = command(sendArgs, false, { OAR_ANTIGRAVITY_FIXTURE_MODE: 'failure' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Provider is unavailable/);
    await assert.rejects(readFile(join(directory, 'ref.json')), error => error.code === 'ENOENT');
  });
});

test('Antigravity classification and workflow share explicit edit with observable policy', async () => {
  await sandbox(async ({ directory, command }) => {
    const input = join(directory, 'documents.json');
    await writeFile(input, JSON.stringify([{ id: 'vpn', text: 'VPN acceso remoto' }]));
    const classified = command(['classify-one', '--input', input, '--model', model, '--cwd', directory]);
    assert.equal(classified.classification.category, 'network');
    assert.equal(classified.enforcement.requested.mode, 'edit');
    const workflow = command(['triage', '--input', input, '--model', model, '--cwd', directory,
      '--state-dir', join(directory, 'state')]);
    assert.equal(workflow.status, 'completed');
    assert.equal(workflow.report.network.enforcement.requested.mode, 'edit');
    assert.match(workflow.report.backups.enforcement.effective.approvals, /request-review/);
  });
});

test('SIGTERM requests cooperative cancellation and does not persist an incomplete native reference', async () => {
  await sandbox(async ({ directory, calls, environment, sendArgs }) => {
    const child = spawn(process.execPath, ['dist/main.js', ...sendArgs], {
      cwd: app, env: { ...environment, OAR_ANTIGRAVITY_FIXTURE_MODE: 'wait' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    try {
      const deadline = Date.now() + 5_000;
      for (;;) {
        try { await readFile(calls); break; } catch (error) {
          if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 1, stderr);
      assert.match(stderr, /interrupted|abort|cancel/i);
      await assert.rejects(readFile(join(directory, 'ref.json')), error => error.code === 'ENOENT');
      assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  });
});

test('public Antigravity streaming emits text; required unavailable capabilities and analyze reject before spawning', async () => {
  await sandbox(async ({ directory, calls, environment }) => {
    const runtime = createAppRuntime({ antigravityExecutable: { command: process.execPath, argsPrefix: [fixture] } });
    const options = { model, cwd: directory, transport: 'exec', requireAuth: 'any', permissions: { mode: 'edit' },
      environment: { mode: 'explicit', variables: environment } };
    const agent = new Agent(options, runtime);
    const session = await agent.openSession();
    try {
      const events = [];
      for await (const event of session.stream('Hello literal')) events.push(event);
      assert.equal(events.filter(event => event.type === 'message.delta').map(event => event.text).join(''), 'literal:Hello literal');
      assert.equal(events.at(-1).type, 'turn.completed');
      assert.equal(session.export().id, uuid);
    } finally { await session.close(); }
    const forbidden = new Agent({ ...options, capabilities: { steering: 'required' } }, runtime);
    await assert.rejects(forbidden.run('Must not launch'), error => error instanceof UnsupportedCapabilityError);
    const analyze = new Agent({ ...options, permissions: { mode: 'analyze' } }, runtime);
    await assert.rejects(analyze.run('Must not launch'), error => error instanceof UnsupportedCapabilityError);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  });
});
