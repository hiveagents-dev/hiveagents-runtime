import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTarball } from './verify-package-contents.mjs';
import { captureSourceState, sourceIdentity } from './source-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/framework-completion');
await mkdir(output, { recursive: true });
const checks = [];
const hash = value => createHash('sha256').update(value).digest('hex');

function run(name, command, args) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 480_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OAR_LIVE: '0', OAR_LIVE_TURNS: '0',
      OAR_ARTIFACT_DIR: output, OAR_CONSUMER_KEEP: '1' },
  });
  checks.push({ name, exitCode: result.status, durationMs: Math.round(performance.now() - start) });
  return { ...result, name };
}

async function checked(name, command, args) {
  const result = run(name, command, args);
  await writeFile(join(output, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.status, 0, `${name} failed; inspect ${join(output, `${name}.log`)}`);
}

const initial = await sourceIdentity(root);
const receipt = { kind: 'local-release-candidate', passed: false, node: process.version,
  platform: process.platform, architecture: process.arch, checks, modelLaunches: 0,
  publication: { authorized: false, performed: false, channel: 'local-tarball',
    ownerDecisions: ['public version', 'npm names and ownership', 'license/governance confirmation', 'publication approval'] } };
try {
  await checked('build', 'npm', ['run', 'build']);
  await checked('typecheck', 'npm', ['run', 'typecheck']);
  await checked('sdk-tests', 'npm', ['test', '--', '--maxWorkers=2']);
  await checked('orchestration-consumer', 'npm', ['run', 'verify:orchestration']);
  await checked('external-consumer', 'npm', ['run', 'verify:first-delivery']);
  await checked('harness-consumer', 'npm', ['run', 'verify:harness']);
  await checked('routing-consumer', 'npm', ['run', 'verify:routing']);
  await checked('learning-consumer', 'npm', ['run', 'verify:learning']);
  await checked('continuous-consumer', 'npm', ['run', 'verify:continuous']);
  // Host admission is verified in the platform repository, where the Host lives (31b47c6).
  const external = JSON.parse(await readFile(join(output, 'external-receipt.json'), 'utf8'));
  assert.equal(external.passed, true);
  assert.equal(external.modelTurns, 0);
  // npm normalizes the app manifest and records current artifact integrity.
  // Bring those portable inputs back to the sample without changing its code.
  const app = join(root, 'apps/document-triage');
  for (const file of ['package.json', 'package-lock.json']) {
    await cp(join(external.consumerDirectory, file), join(app, file));
  }
  assert.equal(hash(await readFile(join(app, 'package-lock.json'))), external.lockSha256, 'Copied consumer lock differs');
  await mkdir(join(app, 'vendor'), { recursive: true });
  const file = 'core.tgz';
  const path = join(output, file);
  const inventory = verifyTarball(path);
  const digest = hash(await readFile(path));
  assert.equal(digest, external.core.sha256, `Artifact differs from installed consumer: ${file}`);
  await cp(path, join(app, 'vendor', file));
  assert.equal(hash(await readFile(join(app, 'vendor', file))), digest, `Copied artifact differs: ${file}`);
  const source = await captureSourceState(root, output);
  const allowedUpdates = new Set(['apps/document-triage/package.json', 'apps/document-triage/package-lock.json']);
  const before = new Map(initial.files.map(file => [file.path, file.sha256]));
  const after = new Map(source.files.map(file => [file.path, file.sha256]));
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    assert.ok(before.get(path) === after.get(path) || allowedUpdates.has(path), `Source changed during verification: ${path}`);
  }
  const sdk = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(sdk.publishConfig?.tag, 'beta', 'The beta candidate must declare its registry tag');
  assert.equal(sdk.private, false, 'The checked tarball must be publishable');
  receipt.source = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'files'));
  receipt.artifacts = [{ file, sha256: digest, ...inventory }];
  receipt.externalConsumer = { passed: true, lockSha256: external.lockSha256,
    applicationCodeSha256: external.applicationCodeSha256, directory: external.consumerDirectory };
  receipt.package = { name: sdk.name, version: sdk.version, license: sdk.license, private: sdk.private, exports: Object.keys(sdk.exports) };
  receipt.passed = true;
} catch (error) {
  receipt.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'release-candidate.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
