import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveBinary } from '../dist/index.js';

assert.equal(process.env.OAR_LIVE, '1', 'Set OAR_LIVE=1 for installed-provider validation');
assert.equal(process.env.OAR_LIVE_TURNS, '1', 'Set OAR_LIVE_TURNS=1 to permit model turns');
const app = await realpath(process.env.OAR_GEMINI_EXTERNAL_APP ?? '');
const model = process.env.OAR_GEMINI_MODEL;
assert.ok(model?.startsWith('gemini/'), 'Set an explicit OAR_GEMINI_MODEL=gemini/<native-id>');
await access(join(app, 'dist/main.js'));
const cwd = await realpath(await mkdtemp(join(tmpdir(), 'oar-gemini-live-')));
const receiptPath = resolve(process.env.OAR_LIVE_RECEIPT ?? '.artifacts/first-delivery/gemini-live.json');
await mkdir(dirname(receiptPath), { recursive: true });
let prior;
try { prior = JSON.parse(await readFile(receiptPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.ok(!prior?.passed, 'This live validation already completed; reuse its receipt');
const previousLaunches = prior?.launched ?? 0;
assert.ok(previousLaunches <= 2, 'The remaining launch budget cannot cover the application and its resume');
const native = resolveBinary('gemini');
assert.ok(native, 'Gemini CLI must be installed');
const counter = join(cwd, 'launches.json');
const wrapper = join(cwd, 'gemini-supervised.mjs');
await writeFile(counter, JSON.stringify(previousLaunches));
const kit = spawnSync(process.execPath, ['--input-type=module', '-e',
  "console.log(import.meta.resolve('hiveagents-runtime/adapter-kit'))"], { cwd: app, encoding: 'utf8' });
assert.equal(kit.status, 0, kit.stderr);
await writeFile(wrapper, `
import { runProcess } from ${JSON.stringify(kit.stdout.trim())};
import { superviseNative } from ${JSON.stringify(new URL('./gemini-live-supervisor.mjs', import.meta.url).href)};
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  const result = await superviseNative({ runner: runProcess,
    target: ${JSON.stringify(native)}, args: process.argv.slice(2),
    counterPath: ${JSON.stringify(counter)}, diagnosticPath: ${JSON.stringify(receiptPath + '.native.json')},
    cwd: process.cwd(), env: process.env, signal: controller.signal,
    stdout: chunk => process.stdout.write(chunk), stderr: chunk => process.stderr.write(chunk)
  });
  process.exitCode = result.code ?? 1;
} catch (error) {
  console.error('Native supervisor:', error.code ?? 'SUPERVISOR_ERROR');
  process.exitCode = 1;
}
`);
const receipt = { kind: 'installed-external-gemini-live', model, node: process.version,
  launched: previousLaunches, maximumLaunches: 4, passed: false, checks: [],
  timeoutMs: 60_000, maxOutputBytes: 1_048_576,
  ...(prior ? { priorFailure: prior.failure } : {}) };

const program = `
import { Agent } from 'hiveagents-runtime';
import { createAppRuntime } from './dist/runtime.js';
import { readFile } from 'node:fs/promises';
const input = JSON.parse(await readFile(0, 'utf8'));
const agent = new Agent({ model: input.model, cwd: input.cwd, requireAuth: 'any',
  permissions: { mode: 'analyze' } }, createAppRuntime({
    geminiExecutable: { command: process.execPath, argsPrefix: [input.wrapper] }
  }));
const readiness = await agent.ready();
const session = await agent.openSession(input.ref ? { resume: input.ref } : {});
try {
  const turn = await session.send(input.prompt, { timeoutMs: 60000 });
  console.log(JSON.stringify({ status: turn.status, text: turn.text, ref: session.export(),
    fingerprint: readiness.plan.fingerprint, auth: readiness.auth,
    toolEvents: turn.events.filter(event => event.type.startsWith('tool.'))
      .map(event => ({ type: event.type, name: event.name, error: !!event.error })) }));
} finally { await session.close(); }
`;

function launch(args, input = '') {
  const result = spawnSync(process.execPath, args, {
    cwd: app, input, encoding: 'utf8', timeout: 100_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true',
      OAR_GEMINI_COMMAND: process.execPath, OAR_GEMINI_ARGS_JSON: JSON.stringify([wrapper]) },
  });
  assert.equal(result.status, 0, `Live child failed (${result.status}): ${(result.stderr || result.stdout).slice(-1500)}`);
  return JSON.parse(result.stdout);
}

function send(prompt, ref) {
  const result = launch(['--input-type=module', '-'],
    // Code and input use separate channels to keep the model prompt out of argv.
    program.replace("JSON.parse(await readFile(0, 'utf8'))", () => JSON.stringify({ model, cwd, wrapper, prompt, ...(ref ? { ref } : {}) })));
  assert.equal(result.status, 'completed', `Gemini ended ${result.status}: ${result.text.slice(0, 400)}`);
  return result;
}

try {
  const input = join(cwd, 'documents.json');
  await writeFile(input, JSON.stringify([{ id: 'vpn', text: 'VPN remote access troubleshooting notes.' }]));
  if (previousLaunches === 2) {
    const reference = join(cwd, 'session.json');
    const first = launch(['dist/main.js', 'classify-one', '--input', input, '--model', model,
      '--cwd', cwd, '--ref-out', reference]);
    assert.equal(first.classification.category, 'network');
    receipt.checks.push('independent-app-classify-one');
    const resumed = launch(['dist/main.js', 'resume-session', '--ref', reference, '--model', model, '--cwd', cwd]);
    assert.equal(resumed.session.id, first.session.id);
    assert.equal(resumed.classification.category, 'network');
    receipt.checks.push('cross-process-native-resume');
    receipt.auth = first.auth;
    receipt.policyEvidence = 'installed-engine-contract; live canary omitted to preserve total launch budget';
  } else {
    const token = 'OAR_' + createHash('sha256').update(cwd).digest('hex').slice(0, 12);
    const first = send(`Remember this exact token for our next message: ${token}. Reply with only the token. Use no tools.`);
    assert.ok(first.text.includes(token), 'First turn did not return the fixture token');
    receipt.fingerprint = first.fingerprint;
    receipt.auth = first.auth;
    receipt.checks.push('first-turn');
    const resumed = send('Reply with only the exact token from my previous message. Use no tools.', first.ref);
    assert.equal(resumed.ref.id, first.ref.id);
    assert.ok(resumed.text.includes(token), 'Native resume did not retain context');
    receipt.checks.push('cross-process-native-resume');

    if (previousLaunches === 0) {
      const canary = join(cwd, 'oar-write-canary.txt');
      const restricted = send('Use write_file to create oar-write-canary.txt containing CANARY. If the tool is unavailable or denied, explain that.');
      await assert.rejects(access(canary));
      receipt.checks.push('write-canary-absent');
      receipt.writeToolRequestObserved = restricted.toolEvents.some(event => event.name === 'write_file');
    } else receipt.policyEvidence = 'installed-engine-contract; live canary omitted to preserve the total launch budget';

    const classification = launch(['dist/main.js', 'classify-one', '--input', input, '--model', model, '--cwd', cwd]);
    assert.equal(classification.classification.category, 'network');
    assert.equal(typeof classification.classification.summary, 'string');
    receipt.checks.push('independent-app-classify-one');
  }
  receipt.passed = ['first-turn', 'cross-process-native-resume', 'write-canary-absent',
    'independent-app-classify-one'].every(check => receipt.checks.includes(check));
  if (!receipt.passed) {
    receipt.partial = true;
    process.exitCode = 1;
  }
} catch (error) {
  receipt.failure = { name: error.name, code: error.code, message: error.message };
  process.exitCode = 1;
} finally {
  receipt.launched = JSON.parse(await readFile(counter, 'utf8'));
  receipt.nativeExecutable = native.command;
  receipt.nativeExecutableSha256 = createHash('sha256').update(await readFile(native.command)).digest('hex');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await rm(cwd, { recursive: true, force: true });
  console.log(JSON.stringify(receipt, null, 2));
}
