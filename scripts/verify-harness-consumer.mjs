/** Reproduce harness evidence through the exact independently npm-installed application. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDependencyPaths, hashApplicationCode } from './verify-external-consumer.mjs';
import { verifyInstalledTarball } from './verify-package-contents.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/harness-delivery');
await mkdir(out, { recursive: true });
const external = JSON.parse(await readFile(join(out, 'external-receipt.json'), 'utf8'));
assert.equal(external.passed, true);
const app = await realpath(external.consumerDirectory);
const rel = relative(await realpath(root), app);
assert.ok(rel === '..' || rel.startsWith(`..${sep}`), 'Application must be outside the checkout');
await auditDependencyPaths(app, root);
const hash = value => createHash('sha256').update(value).digest('hex');
const tarball = join(out, 'core.tgz');
assert.equal(hash(await readFile(tarball)), external.core.sha256);
verifyInstalledTarball(tarball, join(app, 'node_modules/hiveagents-runtime'));
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256);
assert.equal(hash(await readFile(join(app, 'package-lock.json'))), external.lockSha256);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-harness-proof-')));
function invoke(args) {
  const result = spawnSync(process.execPath, ['dist/main.js', ...args], {
    cwd: app, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OAR_LIVE: '0', OAR_LIVE_TURNS: '0' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
const baseline = invoke(['evaluate', '--state-dir', directory, '--profile', 'baseline', '--repetitions', '2']);
const candidate = invoke(['evaluate', '--state-dir', directory, '--profile', 'candidate', '--repetitions', '2']);
const comparison = invoke(['evaluation-compare', '--baseline', baseline.reportPath, '--candidate', candidate.reportPath]);
assert.equal(comparison.comparable, true);
assert.equal(candidate.caseCount, 30); assert.equal(candidate.metrics.total, 60);
assert.equal(candidate.metrics.passed, 60); assert.ok(candidate.metrics.passed > baseline.metrics.passed);
assert.equal(candidate.modelLaunches, 0); assert.equal(baseline.modelLaunches, 0);
assert.equal(candidate.usage.inputTokens.known, 0); assert.equal(candidate.usage.inputTokens.total, null);
const trace = invoke(['trace-inspect', '--state-dir', directory, '--episode', candidate.episodeId]);
assert.equal(trace.status, 'completed');
assert.ok(trace.entries.length > 60);
assert.equal(JSON.stringify(trace).includes('CANARY_SOURCE_TEXT_DO_NOT_LOG'), false);
for (const result of [baseline, candidate]) {
  assert.equal((await stat(result.reportPath)).mode & 0o077, 0, 'Private evaluation report');
  assert.equal((await readFile(result.reportPath, 'utf8')).includes('CANARY_SOURCE_TEXT_DO_NOT_LOG'), false);
}
const input = join(directory, 'documents.json'), authority = join(directory, 'authority.json');
await writeFile(input, JSON.stringify([{ id: 'vpn', text: 'VPN certificate expired yesterday.' }]), { mode: 0o600 });
await writeFile(authority, JSON.stringify({ id: 'operator', version: '1', decision: 'allow', reason: 'Reviewed local proof', expiresAt: Date.now() + 60000 }), { mode: 0o600 });
const produced = invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'proof']);
const reproduced = invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'proof']);
assert.equal(reproduced.digest, produced.digest, 'Producer retry must return the existing immutable handoff');
assert.equal(reproduced.sourceDigest, produced.sourceDigest);
const consumed = invoke(['handoff-consume', '--state-dir', directory, '--id', 'proof', '--authority-file', authority]);
const repeated = invoke(['handoff-consume', '--state-dir', directory, '--id', 'proof', '--authority-file', authority]);
const status = invoke(['handoff-status', '--state-dir', directory, '--id', 'proof']);
assert.equal(consumed.status, 'verified'); assert.equal(status.status, 'verified');
assert.equal(new Set([produced.pid, consumed.pid, status.pid]).size, 3);
assert.equal(consumed.admittedLaunches, 1); assert.equal(repeated.admittedLaunches, 0);
assert.equal(consumed.receipt.resultHash, repeated.receipt.resultHash);
const effects = await readdir(join(directory, 'effects'));
assert.equal(effects.length, 1); assert.equal((await stat(join(directory, 'effects', effects[0]))).mode & 0o077, 0);
await cp(baseline.reportPath, join(out, 'evaluation-baseline.json'));
await cp(candidate.reportPath, join(out, 'evaluation-candidate.json'));
await writeFile(join(out, 'evaluation-comparison.json'), JSON.stringify(comparison, null, 2) + '\n', { mode: 0o600 });
await writeFile(join(out, 'trace-candidate.json'), JSON.stringify(trace, null, 2) + '\n', { mode: 0o600 });
const receipt = { kind: 'independent-app-harness-proof', passed: true, node: process.version,
  coreSha256: external.core.sha256, applicationCodeSha256: external.applicationCodeSha256, lockSha256: external.lockSha256,
  profileSourceDigest: candidate.profileSourceDigest ?? comparison.candidateSourceDigest,
  corpusCases: 30, repetitions: 2, modelTurns: 0,
  baseline: baseline.metrics, candidate: candidate.metrics, comparison,
  trace: { episodeId: trace.identity.episodeId, digest: trace.digest, entries: trace.entries.length, rawCanaryAbsent: true },
  handoff: { digest: produced.digest, sourceDigest: produced.sourceDigest, producerPid: produced.pid, receiverPid: consumed.pid,
    inspectorPid: status.pid, producerRetries: 1, producerRetryDigest: reproduced.digest, status: consumed.status, effectFiles: 1, repeatedDispatches: repeated.admittedLaunches, receipt: consumed.receipt },
  proofDirectory: directory,
  scope: 'Local classifier demonstration; native fixture evidence and provider quality are separate' };
await writeFile(join(out, 'harness-consumer.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
