/** Audit the source-bound cross-process study test retained by ordinary npm consumer tests. */
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedProofContext, sha256 } from './installed-proof-context.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/continuous-routing/final');
await mkdir(out, { recursive: true });
const context = await installedProofContext(root, out, ['learning-cli.mjs']);
const name = 'apps/document-triage/tests/continuous-study.test.mjs';
const expectedTest = context.packed.source.files.find(file => file.path === name)?.sha256;
assert.ok(expectedTest);
assert.equal(sha256(await readFile(join(context.app, 'tests/continuous-study.test.mjs'))), expectedTest);
const matches = context.external.tests.split('\n').flatMap(line => {
  const prefix = '# OAR_CONTINUOUS_PROOF ';
  return line.startsWith(prefix) ? [JSON.parse(line.slice(prefix.length))] : [];
});
assert.equal(matches.length, 1, 'Expected exactly one successful retained source-bound study test');
const marker = matches[0], directory = await realpath(marker.directory), rel = relative(await realpath(tmpdir()), directory);
assert.ok(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Fixture state must be a private temporary child');
const bytes = await readFile(join(directory, 'continuous-proof.json'));
assert.equal(sha256(bytes), marker.sha256, 'Retained proof differs from completed test output');
const proof = JSON.parse(bytes);
assert.equal(proof.kind, 'installed-app-continuous-study-fixtures');
assert.equal(proof.passed, true);
for (const file of proof.files) {
  assert.ok(typeof file.path === 'string' && file.path !== '' && !file.path.split(/[\\/]/).includes('..') && !isAbsolute(file.path));
  const path = join(directory, file.path), canonical = await realpath(path), child = relative(directory, canonical);
  assert.ok(child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  assert.equal((await lstat(path)).isSymbolicLink(), false);
  assert.equal(sha256(await readFile(path)), file.sha256, `Changed study state: ${file.path}`);
}
assert.equal(proof.fixtureCalls, 107);
assert.equal(proof.calibrationCalls, 32);
assert.equal(proof.registeredBatches, 4);
assert.equal(proof.chunk.status, 'paused');
assert.equal(proof.chunk.invocationAttempts, 4);
assert.equal(proof.resumed.cycles[0].commit.status, 'promoted');
assert.equal(proof.replay.invocationAttempts, 0);
assert.ok(proof.cadence.every(result => result.maintenance.status === 'deferred'));
assert.equal(proof.maintained.maintenance.status, 'completed');
assert.equal(proof.fourth.cycles[0].commit.status, 'rolled-back');
assert.equal(proof.final.admittedAttempts, 107);
assert.equal(proof.final.pointer.active, null);
const domains = [proof.resumed, proof.replay, proof.maintained, proof.third, proof.fourth, proof.final].map(result => result.domain);
assert.ok(domains.every(domain => domain === proof.domain));
await context.assertUnchanged();
assert.equal(sha256(await readFile(join(context.app, 'tests/continuous-study.test.mjs'))), expectedTest);
const receipt = { kind: 'independent-app-continuous-study-proof', passed: true, node: process.version,
  ...context.bindings, testSha256: expectedTest, retainedProofSha256: marker.sha256, proofDirectory: directory,
  consumerDirectory: context.app, fixtureCalls: proof.fixtureCalls, additionalFixtureCalls: 0, realModelTurns: 0, routingApiCalls: 0,
  registeredBatches: 4, calibrationCalls: 32, pausedAndResumedSameCycle: true, completedBatchReplayTurns: 0,
  automaticCadenceDefersDuplicateInput: true, promotion: 'promoted', rollback: 'rolled-back',
  scope: 'Audits retained state and assertions from the exact npm-installed cross-process fixture test; no real model quality claim' };
await writeFile(join(out, 'continuous-consumer.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
