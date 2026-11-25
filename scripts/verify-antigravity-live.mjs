import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from '../dist/index.js';
import { verifyInstalledTarball } from './verify-package-contents.mjs';
import { auditDependencyPaths, hashApplicationCode } from './verify-external-consumer.mjs';

assert.equal(process.env.OAR_LIVE, '1', 'Set OAR_LIVE=1 for installed-provider validation');
assert.equal(process.env.OAR_LIVE_TURNS, '1', 'Set OAR_LIVE_TURNS=1 to permit model turns');
assert.ok(process.env.OAR_ANTIGRAVITY_EXTERNAL_APP, 'Set OAR_ANTIGRAVITY_EXTERNAL_APP to the npm-installed application');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = await realpath(process.env.OAR_ANTIGRAVITY_EXTERNAL_APP);
const fromCheckout = relative(await realpath(root), app);
assert.ok(fromCheckout === '..' || fromCheckout.startsWith(`..${sep}`), 'Live application must be outside the checkout');
const model = process.env.OAR_ANTIGRAVITY_MODEL;
assert.ok(model?.startsWith('antigravity/'), 'Set OAR_ANTIGRAVITY_MODEL=antigravity/<native-id>');
await access(join(app, 'dist/main.js'));
const artifacts = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/first-delivery');
const external = JSON.parse(await readFile(join(artifacts, 'external-receipt.json'), 'utf8'));
assert.equal(external.passed, true, 'The external npm consumer validation must pass first');
assert.ok(external.consumerDirectory, 'Retain the validated consumer with OAR_CONSUMER_KEEP=1');
assert.equal(await realpath(external.consumerDirectory), app, 'Use the exact independently installed application from the receipt');
await auditDependencyPaths(app, root);
const receiptPath = resolve(process.env.OAR_LIVE_RECEIPT ?? join(artifacts, 'antigravity-live.json'));
await mkdir(dirname(receiptPath), { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const native = resolveBinary('agy');
assert.ok(native, 'Antigravity CLI must be installed');
const nativeDigest = digest(await readFile(native.command));
const tarball = join(artifacts, 'core.tgz');
verifyInstalledTarball(tarball, join(app, 'node_modules/hiveagents-runtime'));
const hashes = { 'hiveagents-runtime': digest(await readFile(tarball)) };
hashes.applicationLock = digest(await readFile(join(app, 'package-lock.json')));
hashes.applicationCode = await hashApplicationCode(app);
assert.equal(external.core.sha256, hashes['hiveagents-runtime'], 'External receipt SDK digest differs');
assert.equal(external.lockSha256, hashes.applicationLock, 'External receipt lock digest differs');
assert.equal(external.applicationCodeSha256, hashes.applicationCode, 'External receipt app output differs');
const runLockPath = receiptPath + '.lock';
const runLock = await open(runLockPath, 'wx', 0o600);
let workspace;
try {
  let prior;
  try { prior = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior) {
    assert.equal(prior.executableSha256, nativeDigest, 'Prior launch budget belongs to another native executable');
    assert.equal(prior.model, model, 'Prior launch budget belongs to another model');
    assert.ok(!prior.passed, 'This live validation already passed; reuse its durable receipt');
  }
  const counter = receiptPath + '.launches.json';
  let count = prior?.launched ?? 0;
  try { count = Math.max(count, JSON.parse(await readFile(counter, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(Number.isInteger(count) && count >= 0 && count <= 2, 'Insufficient remaining budget for send and resume');
  await writeFile(counter, JSON.stringify(count), { mode: 0o600 });
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'oar-antigravity-live-')));
  workspace = cwd;
  const wrapper = join(cwd, 'supervised-agy.mjs');
  const kit = spawnSync(process.execPath, ['--input-type=module', '-e',
    "console.log(import.meta.resolve('hiveagents-runtime/adapter-kit'))"], { cwd: app, encoding: 'utf8' });
  assert.equal(kit.status, 0, kit.stderr);
  await writeFile(wrapper, `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import { readFile, writeFile } from 'node:fs/promises';
  import { runProcess } from ${JSON.stringify(kit.stdout.trim())};
  import { superviseNative } from ${JSON.stringify(new URL('./gemini-live-supervisor.mjs', import.meta.url).href)};
  const native = ${JSON.stringify(native)};
  assert.equal(createHash('sha256').update(await readFile(native.command)).digest('hex'), ${JSON.stringify(nativeDigest)}, 'Native executable changed');
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  try {
    const outcome = await superviseNative({ runner: runProcess, target: native,
      args: process.argv.slice(2), cwd: process.cwd(), env: process.env, signal: controller.signal,
      counterPath: ${JSON.stringify(counter)}, diagnosticPath: ${JSON.stringify(receiptPath + '.native.json')},
      stdout: chunk => process.stdout.write(chunk), stderr: chunk => process.stderr.write(chunk) });
    process.exitCode = outcome.code ?? 1;
  } catch (error) { console.error('Native supervisor:', error.code ?? 'SUPERVISOR_ERROR'); process.exitCode = 1; }
  `);

  const receipt = {
    kind: 'npm-installed-antigravity-send-resume', passed: false, checks: [], model,
    node: process.version, platform: process.platform, artifacts: hashes,
    executable: native.command, executableSha256: nativeDigest, launched: count,
    maximumLaunches: 4, timeoutMs: 60_000, maxOutputBytes: 1_048_576,
    permissions: 'edit; native request-review; no analyze or OS sandbox guarantee',
    ...(prior ? { priorAttempts: [...(prior.priorAttempts ?? []), {
      artifacts: prior.artifacts, launched: prior.launched, checks: prior.checks, failure: prior.failure,
    }] } : {}),
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });

  function runApp(args) {
    const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
      cwd: app, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, OAR_ANTIGRAVITY_COMMAND: process.execPath,
        OAR_ANTIGRAVITY_ARGS_JSON: JSON.stringify([wrapper]) },
    });
    assert.equal(result.status, 0, `App process failed (${result.status}): ${(result.stderr || result.stdout).slice(-1500)}`);
    return JSON.parse(result.stdout);
  }

  try {
    const nonce = 'OAR_' + randomBytes(10).toString('hex');
    const firstPrompt = join(cwd, 'first.txt'), resumePrompt = join(cwd, 'resume.txt');
    const reference = join(cwd, 'session.json');
    await writeFile(firstPrompt, `Remember this token: ${nonce}. Reply with exactly the token. Use no tools.`);
    await writeFile(resumePrompt, 'Reply with only the exact token from my previous message. Use no tools.');
    const args = ['session-send', '--model', model, '--cwd', cwd, '--ref-out', reference];
    const first = runApp([...args, '--prompt-file', firstPrompt]);
    assert.equal(first.status, 'completed');
    assert.equal(first.text.trim(), nonce, 'Initial turn did not return the nonce');
    assert.equal(first.session.provider, 'antigravity');
    receipt.first = { session: first.session, usage: first.usage, auth: first.auth, enforcement: first.enforcement };
    receipt.checks.push('first-turn');
    assert.equal(first.toolEvents, 0, 'Memory check must not use tools');
    await rm(firstPrompt);
    const resumed = runApp([...args, '--prompt-file', resumePrompt, '--ref', reference]);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.session.id, first.session.id, 'Resume changed native session identity');
    assert.equal(resumed.text.trim(), nonce, 'Resumed process did not retain the first process context');
    assert.equal(resumed.toolEvents, 0, 'Resume memory check must not use tools');
    receipt.resumed = { session: resumed.session, usage: resumed.usage, auth: resumed.auth, enforcement: resumed.enforcement };
    receipt.nonceSha256 = digest(nonce);
    receipt.checks.push('cross-process-native-resume', 'retained-nonce');
    assert.equal(JSON.parse(await readFile(counter, 'utf8')), count + 2,
      'Send/resume proof must observe exactly two new native prompt launches');
    receipt.passed = true;
  } catch (error) {
    receipt.failure = { name: error.name, code: error.code, message: error.message };
    process.exitCode = 1;
  } finally {
    receipt.launched = JSON.parse(await readFile(counter, 'utf8'));
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(receipt, null, 2));
  }
} finally {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  await runLock.close();
  await rm(runLockPath, { force: true });
}
