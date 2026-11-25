/** Exercise measured learning through the installed public package, with subprocess fixtures. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDependencyPaths, hashApplicationCode } from './verify-external-consumer.mjs';
import { verifyInstalledTarball } from './verify-package-contents.mjs';
import { sourceIdentity } from './source-state.mjs';
import { assertRoutingSource } from './routing-proof-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/harness-delivery');
await mkdir(out, { recursive: true });
const external = JSON.parse(await readFile(join(out, 'external-receipt.json'), 'utf8'));
const packed = JSON.parse(await readFile(join(out, 'artifact-source.json'), 'utf8'));
assert.equal(external.passed, true);
assert.equal(packed.kind, 'artifact-build-source');
assert.equal(packed.source.sourceManifestSha256, external.artifactSourceManifestSha256);
const hash = value => createHash('sha256').update(value).digest('hex');
const app = await realpath(external.consumerDirectory), rel = relative(await realpath(root), app);
assert.ok(rel === '..' || rel.startsWith(`..${sep}`), 'Application must be outside checkout');
await auditDependencyPaths(app, root);
async function verifyArtifacts() {
  const tarball = join(out, 'core.tgz');
  assert.equal(packed.coreSha256, external.core.sha256);
  assert.equal(hash(await readFile(tarball)), external.core.sha256);
  verifyInstalledTarball(tarball, join(app, 'node_modules/hiveagents-runtime'));
}
await verifyArtifacts();
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256);
assert.equal(hash(await readFile(join(app, 'package-lock.json'))), external.lockSha256);
const sourceBefore = await sourceIdentity(root);
const normalizedAppInputs = assertRoutingSource(packed.source, sourceBefore, {
  'apps/document-triage/package.json': hash(await readFile(join(app, 'package.json'))),
  'apps/document-triage/package-lock.json': external.lockSha256,
});
const fixture = join(app, 'tests/fixtures/learning-cli.mjs');
const expectedFixture = packed.source.files.find(file => file.path === 'apps/document-triage/tests/fixtures/learning-cli.mjs')?.sha256;
assert.ok(expectedFixture, 'Missing pack-time learning fixture');
assert.equal(hash(await readFile(fixture)), expectedFixture);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-learning-proof-')));
const calls = join(directory, 'calls.jsonl'), config = join(directory, 'agent.json');
await writeFile(config, JSON.stringify({ model: { mode: 'auto', allowUnverifiedModels: true, candidates: [
  { id: 'sol', model: 'codex/gpt-5.6-sol', effort: 'low' },
  { id: 'sonnet', model: 'claude/claude-sonnet-5', effort: 'low' },
] }, transport: 'exec', requireAuth: 'subscription', permissions: { mode: 'analyze' } }), { mode: 0o600 });
const env = { ...process.env, OAR_LIVE: '0', OAR_LIVE_TURNS: '0', OAR_LEARNING_FIXTURE_MODE: 'normal',
  OAR_CODEX_COMMAND: process.execPath, OAR_CODEX_ARGS_JSON: JSON.stringify([fixture, 'codex']),
  OAR_CLAUDE_COMMAND: process.execPath, OAR_CLAUDE_ARGS_JSON: JSON.stringify([fixture, 'claude']), OAR_LEARNING_CALLS: calls };
function invoke(args, extra = {}) {
  const result = spawnSync(process.execPath, ['dist/main.js', ...args], { cwd: app, encoding: 'utf8',
    env: { ...env, ...extra }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
const common = ['--config', config, '--state-dir', directory];
const cycle = invoke(['learn-cycle', ...common, '--max-launches', '128']);
assert.equal(cycle.gate.status, 'promoted');
assert.equal(cycle.pointer.generation, 1);
assert.ok(cycle.comparison.learnedPassRate > cycle.comparison.incumbentPassRate);
assert.ok(cycle.comparison.learnedPassRate > cycle.comparison.bestFixedPassRate);
const inspector = invoke(['learn-status', ...common]);
assert.notEqual(inspector.pid, cycle.pid);
assert.equal(inspector.pointer.active, cycle.pointer.active);
const choices = [];
for (const [kind, expected] of [['classification', 'claude'], ['arithmetic', 'codex']]) {
  const input = join(directory, `${kind}.json`);
  await writeFile(input, JSON.stringify({ kind, seed: 811 }), { mode: 0o600 });
  const result = invoke(['learn-run', ...common, '--input', input, '--max-launches', '1']);
  assert.equal(result.receipt.selected.provider, expected);
  assert.equal(result.observation.quality.state, 'verified');
  assert.equal(result.observation.quality.passed, true);
  assert.equal(result.pointer.active, cycle.pointer.active);
  choices.push({ kind, provider: expected, decisionDigest: result.receipt.digest,
    observationDigest: result.observation.digest, shadowDigest: result.shadowDigest });
}
const rollback = invoke(['learn-cycle', ...common, '--max-launches', '64', '--operation', 'rollback'], { OAR_LEARNING_FIXTURE_MODE: 'drift' });
assert.equal(rollback.gate.status, 'rolled-back');
assert.equal(rollback.pointer.generation, 2);
assert.equal(rollback.pointer.active, null);
const inspected = invoke(['learn-status', ...common]);
assert.deepEqual(inspected.pointer, rollback.pointer);
assert.equal(inspected.pending.length, 0);
const log = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
assert.equal(log.length, cycle.requestedModelTurns + 2 + rollback.requestedModelTurns);
assert.equal(inspected.observations.length, log.length);
assert.ok(inspected.observations.every(row => row.observation.quality.state === 'verified'));
assert.ok(log.every(row => ['claude', 'codex'].includes(row.provider)));
const source = await sourceIdentity(root);
assert.equal(source.sourceManifestSha256, sourceBefore.sourceManifestSha256, 'Source changed during learning proof');
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256, 'App changed during learning proof');
assert.equal(hash(await readFile(fixture)), expectedFixture, 'Fixture changed during learning proof');
await verifyArtifacts();
assert.equal(hash(await readFile(join(app, 'package-lock.json'))), external.lockSha256, 'Lock changed during learning proof');
const receipt = { kind: 'independent-app-adaptive-routing-proof', passed: true, node: process.version,
  source: { artifactBuildDigest: packed.source.sourceManifestSha256, proofDigest: source.sourceManifestSha256,
    inputCount: source.files.length, normalizedAppInputs },
  coreSha256: external.core.sha256,
  applicationCodeSha256: external.applicationCodeSha256, lockSha256: external.lockSha256, fixtureSha256: expectedFixture,
  promoted: { gate: cycle.gate, pointer: cycle.pointer, comparison: cycle.comparison },
  choices, rollback: { gate: rollback.gate, pointer: rollback.pointer },
  crossProcessRestart: { originalPid: cycle.pid, inspectorPid: inspector.pid, finalInspectorPid: inspected.pid },
  fixtureNativeTurns: log.length, realModelTurns: 0, routingApiCalls: 0, noPendingAttempts: true,
  consumerDirectory: app, proofDirectory: directory,
  scope: 'Controlled fixture task outcomes validate learning, protected promotion, persistence and measured rollback; not real model quality' };
await writeFile(join(out, 'learning-consumer.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
