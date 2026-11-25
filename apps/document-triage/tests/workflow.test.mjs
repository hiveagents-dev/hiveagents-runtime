import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Agent, UnsupportedCapabilityError } from 'hiveagents-runtime';
import { createAppRuntime } from '../dist/runtime.js';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(app, 'tests/fixtures/fake-gemini.mjs');
const model = 'gemini/gemini-2.5-flash';
const documents = [{ id: 'vpn', text: 'VPN acceso remoto' }, { id: 'backup', text: 'backup restauración' }];

async function sandbox(run) {
  const directory = await mkdtemp(join(tmpdir(), 'triage-app-test-'));
  try {
    const input = join(directory, 'input.json');
    await writeFile(input, JSON.stringify(documents));
    const calls = join(directory, 'calls.jsonl');
    const environment = { ...process.env, GEMINI_API_KEY: 'fixture-not-a-credential', GOOGLE_GENAI_USE_VERTEXAI: 'false',
      GEMINI_CLI_HOME: directory, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, 'absent-system-settings.json'),
      OAR_GEMINI_COMMAND: process.execPath, OAR_GEMINI_ARGS_JSON: JSON.stringify([fixture]), OAR_FIXTURE_CALLS: calls };
    const command = (args, expectSuccess = true) => {
      const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
        cwd: app, env: environment, encoding: 'utf8', timeout: 30_000,
      });
      if (expectSuccess) assert.equal(result.status, 0, result.stderr || result.stdout);
      return expectSuccess ? JSON.parse(result.stdout) : result;
    };
    await run({ directory, input, calls, command, environment });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('three independent processes pause, resume two branches, then reuse the durable report', async () => {
  await sandbox(async ({ directory, input, calls, command }) => {
    const args = ['triage', '--input', input, '--state-dir', join(directory, 'state'), '--cwd', directory, '--model', model];
    const paused = command([...args, '--stop-after-intake']);
    assert.equal(paused.status, 'cancelled');
    assert.deepEqual(paused.executedSteps, ['intake']);
    const resumed = command(args);
    assert.equal(resumed.status, 'completed');
    assert.deepEqual(resumed.executedSteps.sort(), ['backups', 'network', 'report']);
    assert.equal(resumed.admittedLaunches, 2);
    assert.equal(resumed.report.network.classification.category, 'network');
    assert.equal(resumed.report.backups.classification.category, 'backups');
    assert.equal(resumed.report.network.auth.source, 'api-key');
    const cached = command(args);
    assert.deepEqual(cached.executedSteps, []);
    assert.equal(cached.admittedLaunches, 2);
    assert.deepEqual(cached.report, resumed.report);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
  });
});

test('doctor and local workflow never invoke a model; changed input gets a fresh checkpoint', async () => {
  await sandbox(async ({ directory, input, calls, command }) => {
    const report = command(['doctor']);
    assert.ok(report.providers.some(provider => provider.provider === 'gemini' && provider.installation.installed));
    const args = ['triage', '--input', input, '--state-dir', join(directory, 'local-state'), '--cwd', directory];
    const first = command(args);
    assert.equal(first.status, 'completed');
    assert.deepEqual(command(args).executedSteps, []);
    await writeFile(input, JSON.stringify([{ id: 'new-vpn', text: 'VPN acceso remoto updated' }]));
    const changed = command(args);
    assert.notEqual(changed.runId, first.runId);
    assert.equal(changed.executedSteps.length, 4);
    await assert.rejects(readFile(calls), error => error.code === 'ENOENT');
  });
});

test('classify-one runs once, exports its session and resumes it with explicit cwd', async () => {
  await sandbox(async ({ directory, input, calls, command }) => {
    await writeFile(input, JSON.stringify([documents[0]]));
    const ref = join(directory, 'session.json');
    const first = command(['classify-one', '--input', input, '--model', model, '--cwd', directory, '--ref-out', ref]);
    assert.equal(first.classification.category, 'network');
    assert.equal(first.auth.source, 'api-key');
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
    const resumed = command(['resume-session', '--ref', ref, '--model', model, '--cwd', directory]);
    assert.equal(resumed.session.id, first.session.id);
    assert.equal(resumed.classification.category, 'network');
    const launches = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.ok(launches[1].args.includes('--resume'));
    const missingCwd = command(['resume-session', '--ref', ref, '--model', model], false);
    assert.notEqual(missingCwd.status, 0);
    assert.match(missingCwd.stderr, /--cwd/);
  });
});

test('public streaming delivers deltas; unavailable capability is rejected before a turn spawn', async () => {
  await sandbox(async ({ directory, calls, environment }) => {
    const runtime = createAppRuntime({ geminiExecutable: { command: process.execPath, argsPrefix: [fixture] } });
    const options = { model: runtime.resolveModel(model).provider + '/gemini-2.5-flash', cwd: directory,
      transport: 'exec', requireAuth: 'any', permissions: { mode: 'analyze' },
      environment: { mode: 'explicit', variables: environment } };
    const agent = new Agent(options, runtime);
    const session = await agent.openSession();
    const events = [];
    try {
      for await (const event of session.stream('Classify VPN notes. Return JSON.')) events.push(event);
      assert.ok(events.some(event => event.type === 'message.delta'));
      assert.equal(events.at(-1).type, 'turn.completed');
      assert.equal(session.export().provider, 'gemini');
    } finally { await session.close(); }
    const forbidden = new Agent({ ...options, capabilities: { steering: 'required' } }, runtime);
    await assert.rejects(forbidden.run('Must not launch'), error => error instanceof UnsupportedCapabilityError);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  });
});
