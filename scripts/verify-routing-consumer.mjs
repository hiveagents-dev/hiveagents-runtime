/** Verify local routing through the same independently installed SDK tarball. */
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
import { assertRoutingSource, assertRoutingFixtures } from './routing-proof-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/harness-delivery');
await mkdir(out, { recursive: true });
const external = JSON.parse(await readFile(join(out, 'external-receipt.json'), 'utf8'));
assert.equal(external.passed, true);
const packed = JSON.parse(await readFile(join(out, 'artifact-source.json'), 'utf8'));
assert.equal(packed.kind, 'artifact-build-source');
assert.equal(packed.source.sourceManifestSha256, external.artifactSourceManifestSha256);
assert.equal(packed.coreSha256, external.core.sha256, 'Artifact source receipt mismatch');
const app = await realpath(external.consumerDirectory), rel = relative(await realpath(root), app);
assert.ok(rel === '..' || rel.startsWith(`..${sep}`), 'Application must be outside the checkout');
await auditDependencyPaths(app, root);
const hash = value => createHash('sha256').update(value).digest('hex');
const tarball = join(out, 'core.tgz');
assert.equal(hash(await readFile(tarball)), external.core.sha256);
verifyInstalledTarball(tarball, join(app, 'node_modules/hiveagents-runtime'));
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256);
assert.equal(hash(await readFile(join(app, 'package-lock.json'))), external.lockSha256);
const sourceBefore = await sourceIdentity(root);
const normalizedAppInputs = assertRoutingSource(packed.source, sourceBefore, {
  'apps/document-triage/package.json': hash(await readFile(join(app, 'package.json'))),
  'apps/document-triage/package-lock.json': external.lockSha256,
});
await assertRoutingFixtures(packed.source, app);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-routing-proof-'))), calls = join(directory, 'turns.jsonl');
const env = { ...process.env, OAR_LIVE: '0', OAR_LIVE_TURNS: '0', GEMINI_API_KEY: 'fixture-not-a-credential',
  OAR_GEMINI_COMMAND: process.execPath, OAR_GEMINI_ARGS_JSON: JSON.stringify([join(app, 'tests/fixtures/fake-gemini.mjs')]),
  OAR_ANTIGRAVITY_COMMAND: process.execPath, OAR_ANTIGRAVITY_ARGS_JSON: JSON.stringify([join(app, 'tests/fixtures/fake-antigravity.mjs')]),
  OAR_FIXTURE_CALLS: calls };
function invoke(args, succeeds = true, environment = {}) {
  const result = spawnSync(process.execPath, ['dist/main.js', ...args], { cwd: app, encoding: 'utf8',
    env: { ...env, ...environment }, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  if (succeeds) { assert.equal(result.status, 0, result.stderr || result.error?.message); return JSON.parse(result.stdout); }
  assert.notEqual(result.status, 0); return { status: result.status };
}
async function countTurns() {
  try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
const configPath = join(directory, 'agent.json');
async function config(model, permissions = 'analyze') {
  await writeFile(configPath, JSON.stringify({ model, transport: 'exec', requireAuth: 'any', permissions: { mode: permissions } }), { mode: 0o600 });
}
const auto = overrides => ({ mode: 'auto', candidates: ['gemini/gemini-2.5-flash', 'antigravity/gemini-3-flash'],
  allowUnverifiedModels: true, allowUnknownAuth: true, ...overrides });
const selections = [];
for (const [id, model, tags, expected, reason, permissions] of [
  ['fixed', 'gemini/gemini-2.5-flash', undefined, 'gemini/gemini-2.5-flash', 'FIXED', 'analyze'],
  ['priority', auto({}), undefined, 'gemini/gemini-2.5-flash', 'PRIORITY', 'analyze'],
  ['allowlist', auto({ providers: ['antigravity'] }), undefined, 'antigravity/gemini-3-flash', 'PRIORITY', 'edit'],
  ['rule', auto({ rules: [{ id: 'review', allTags: ['review'], models: ['antigravity/gemini-3-flash'] }] }), 'review', 'antigravity/gemini-3-flash', 'RULE', 'edit'],
  ['fallback', auto({ rules: [{ id: 'review', allTags: ['review'], models: ['gemini/gemini-2.5-flash'] }], fallback: 'antigravity/gemini-3-flash' }), 'other', 'antigravity/gemini-3-flash', 'FALLBACK', 'edit'],
]) {
  await config(model, permissions);
  const result = invoke(['route-select', '--config', configPath, '--state-dir', directory, '--id', id,
    ...(tags === undefined ? [] : ['--tags', tags])]);
  assert.equal(result.receipt.selected.model, expected); assert.equal(result.receipt.reason, reason);
  assert.equal(result.receipt.nativeDispatches, 0); assert.equal(result.requestedModelTurns, 0);
  const inspected = invoke(['route-inspect', '--state-dir', directory, '--id', id]);
  assert.notEqual(result.pid, inspected.pid); assert.deepEqual(inspected.receipt, result.receipt);
  selections.push({ id, model: expected, reason, digest: result.receipt.digest, pid: result.pid, inspectorPid: inspected.pid });
}
assert.equal(await countTurns(), 0);
await config('antigravity/gemini-3-flash', 'analyze');
invoke(['route-select', '--config', configPath, '--state-dir', directory, '--id', 'denied'], false);
const denied = invoke(['route-inspect', '--state-dir', directory, '--id', 'denied']);
assert.equal(denied.receipt.decision, 'abstained');
assert.equal(denied.receipt.candidates[0].code, 'POLICY_UNSUPPORTED');
assert.equal(await countTurns(), 0);
await config(auto({}));
const input = join(directory, 'input.json');
await writeFile(input, JSON.stringify([{ id: 'vpn', text: 'CANARY_ROUTING_SOURCE: VPN certificate expired.' }]), { mode: 0o600 });
const classified = invoke(['route-classify', '--config', configPath, '--input', input, '--state-dir', directory, '--id', 'classified', '--max-launches', '1']);
assert.equal(classified.classification.category, 'network');
assert.equal(classified.requestedModelTurns, 1); assert.equal(classified.modelLaunches, null);
assert.equal(await countTurns(), 1);
const inspected = invoke(['route-inspect', '--state-dir', directory, '--id', 'classified']);
assert.equal(inspected.receipt.digest, classified.receipt.digest);
for (const canary of ['CANARY_ROUTING_SOURCE', 'fixture-not-a-credential']) assert.equal(JSON.stringify(inspected).includes(canary), false);
await config(auto({ candidates: ['antigravity/gemini-3-flash', 'gemini/gemini-2.5-flash'] }), 'edit');
invoke(['route-classify', '--config', configPath, '--input', input, '--state-dir', directory, '--id', 'failed', '--max-launches', '1'], false,
  { OAR_ANTIGRAVITY_FIXTURE_MODE: 'failure' });
assert.equal(await countTurns(), 2, 'Native execution failure must not trigger another selected provider');
const source = await sourceIdentity(root);
assert.equal(source.sourceManifestSha256, sourceBefore.sourceManifestSha256, 'Source changed during routing proof');
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256, 'App changed during routing proof');
await assertRoutingFixtures(packed.source, app);
const receipt = { kind: 'independent-app-local-routing-proof', passed: true, node: process.version,
  source: { artifactBuildDigest: packed.source.sourceManifestSha256, proofDigest: source.sourceManifestSha256,
    inputCount: source.files.length, normalizedAppInputs },
  coreSha256: external.core.sha256,
  applicationCodeSha256: external.applicationCodeSha256, lockSha256: external.lockSha256,
  selections, denied: { digest: denied.receipt.digest, code: 'POLICY_UNSUPPORTED' },
  classified: { digest: classified.receipt.digest, category: classified.classification.category, requestedTurns: 1 },
  selectionNativeTurns: 0, fixtureNativeTurns: await countTurns(), realModelTurns: 0, routingApiCalls: 0,
  executionRetryAfterFailure: false, consumerDirectory: app, proofDirectory: directory,
  scope: 'Deterministic priority/tag policy and installed subprocess fixtures; no learned optimality or provider quality claim' };
await writeFile(join(out, 'routing-consumer.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
