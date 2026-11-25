/** Explicit, bounded real CLI study through the independently installed application. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditDependencyPaths, hashApplicationCode } from './verify-external-consumer.mjs';
import { verifyInstalledTarball } from './verify-package-contents.mjs';
import { sourceIdentity } from './source-state.mjs';
import { assertRoutingSource } from './routing-proof-inputs.mjs';
import { claimLearningStudy } from './learning-live-claim.mjs';
import { learningMatrixCoverage } from './learning-live-coverage.mjs';

assert.equal(process.env.OAR_LEARNING_LIVE, '1', 'Set OAR_LEARNING_LIVE=1 for real provider capacity');
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--codex-command', '--claude-command'].includes(flag) && !values.has(flag) && value && isAbsolute(value), 'Expected explicit absolute native CLI paths');
  values.set(flag, await realpath(value));
}
assert.equal(values.size, 2, 'Both native CLIs are required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/adaptive-routing/final');
const external = JSON.parse(await readFile(join(out, 'external-receipt.json'), 'utf8'));
const packed = JSON.parse(await readFile(join(out, 'artifact-source.json'), 'utf8'));
assert.equal(external.passed, true);
assert.equal(packed.kind, 'artifact-build-source');
assert.equal(packed.source.sourceManifestSha256, external.artifactSourceManifestSha256);
const app = await realpath(external.consumerDirectory), rel = relative(await realpath(root), app);
assert.ok(rel === '..' || rel.startsWith(`..${sep}`), 'Study application must be outside checkout');
await auditDependencyPaths(app, root);
const hash = value => createHash('sha256').update(value).digest('hex');
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
// Subscription readiness remains mandatory; remove routing fixtures and API-key precedence.
for (const name of Object.keys(process.env)) {
  if (/^OAR_(?:CLAUDE|CODEX|GEMINI|ANTIGRAVITY)_(?:COMMAND|ARGS_JSON)$/.test(name)
    || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'TYPESAFE_API_KEY'].includes(name)) delete process.env[name];
}
const directory = join(out, `live-${randomUUID()}`), workspace = join(directory, 'workspace');
const claimPath = await claimLearningStudy(out, { kind: 'real-learning-study-start', directory,
  sourceDigest: sourceBefore.sourceManifestSha256, coreSha256: external.core.sha256, maxRequestedAttempts: 32, createdAt: Date.now() });
await mkdir(workspace, { recursive: true, mode: 0o700 });
const definition = { model: { mode: 'auto', allowUnverifiedModels: true, candidates: [
  { id: 'sol', model: 'codex/gpt-5.6-sol', effort: 'low' },
  { id: 'sonnet', model: 'claude/claude-sonnet-5', effort: 'low' },
] }, transport: 'exec', context: { profile: 'native', memory: 'inherit' },
  requireAuth: 'subscription', permissions: { mode: 'analyze' }, cwd: workspace };
const config = join(directory, 'agent.json');
await writeFile(config, JSON.stringify(definition, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const { createAppRuntime } = await import(pathToFileURL(join(app, 'dist/runtime.js')).href);
const { runLearningCycle, inspectLearning } = await import(pathToFileURL(join(app, 'dist/learning-commands.js')).href);
const { openLearningSession } = await import(pathToFileURL(join(app, 'dist/learning-session.js')).href);
const { learningCases } = await import(pathToFileURL(join(app, 'dist/learning-corpus.js')).href);
const { taskFor } = await import(pathToFileURL(join(app, 'dist/learning-matrix.js')).href);
const runtime = createAppRuntime({ codexExecutable: { command: values.get('--codex-command'), argsPrefix: [] },
  claudeExecutable: { command: values.get('--claude-command'), argsPrefix: [] } });
const options = { definition, stateDirectory: directory, cwd: workspace, timeoutMs: 60000, objective: 'latency', suite: 'document' };
const controller = new AbortController(), started = Date.now();
const interrupt = () => controller.abort(new Error('LIVE_STUDY_CANCELLED'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const timer = setTimeout(() => controller.abort(new Error('LIVE_STUDY_TOTAL_TIMEOUT')), 20 * 60000);
let cycle, failure, preflight;
try {
  const session = await openLearningSession(options);
  try {
    preflight = await session.router.preflight(session.definition, { runtime, task: taskFor(learningCases('train', 'document')[0]),
      timeoutMs: 60000, signal: controller.signal });
    assert.deepEqual(preflight.actions.map(action => action.id), ['sol', 'sonnet'], 'Both configured subscription arms must be eligible before any study turn');
  } finally { session.store.close(); }
  cycle = await runLearningCycle({ ...options, runtime, suite: 'document', maxLaunches: 32, totalLaunches: 32, signal: controller.signal });
} catch (error) {
  // Native stderr and provider messages can contain personal data; only retain bounded error codes.
  failure = { name: error instanceof Error ? error.name : 'UnknownError', code: typeof error?.code === 'string' ? error.code : 'STUDY_INCOMPLETE' };
} finally {
  clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
const status = await inspectLearning(options);
assert.ok(status.observations.length + status.pending.length <= 32, 'Observed requested-attempt cap exceeded');
const rows = status.observations.map(row => row.observation);
const expectedCells = ['train', 'fixed', 'fresh'].flatMap(split => learningCases(split, 'document').flatMap(item =>
  (preflight?.actions ?? []).map(action => ({ split, taskDigest: taskFor(item).inputDigest, actionKey: action.key }))));
const { matrixComplete, verificationComplete } = learningMatrixCoverage(expectedCells, rows, status.pending.length);
const models = definition.model.candidates.map(arm => {
  const actionKey = preflight?.actions.find(action => action.id === arm.id)?.key;
  const selected = rows.filter(row => row.action.id === arm.id && row.action.key === actionKey), verified = selected.filter(row => row.quality.state === 'verified');
  const latencies = selected.flatMap(row => row.latency.state === 'observed' ? [row.latency.durationMs] : []);
  const splits = Object.fromEntries(['train', 'fixed', 'fresh'].map(split => {
    const rs = selected.filter(row => row.split === split), vs = rs.filter(row => row.quality.state === 'verified');
    return [split, { terminal: rs.length, verified: vs.length, passed: vs.filter(row => row.quality.passed).length }];
  }));
  return { ...arm, actionKey, excludedIdentityRows: rows.filter(row => row.action.id === arm.id && row.action.key !== actionKey).length,
    terminal: selected.length, verified: verified.length, passed: verified.filter(row => row.quality.passed).length,
    passRate: verified.length ? verified.filter(row => row.quality.passed).length / verified.length : null, splits,
    observedLatencyCount: latencies.length, meanObservedLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b) / latencies.length : null,
    costCoverage: selected.filter(row => row.usage?.reportedCostUsd !== undefined).length,
    backendModelCoverage: selected.filter(row => row.observedModels?.length).length,
    outcomes: Object.fromEntries([...new Set(selected.map(row => row.outcome))].map(kind => [kind, selected.filter(row => row.outcome === kind).length])) };
});
const source = await sourceIdentity(root);
assert.equal(source.sourceManifestSha256, sourceBefore.sourceManifestSha256, 'Source changed during live study');
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256, 'App changed during live study');
await verifyArtifacts();
assert.equal(hash(await readFile(join(app, 'package-lock.json'))), external.lockSha256, 'Lock changed during live study');
const database = join(directory, 'learning/evidence.sqlite');
const receipt = { kind: 'independent-app-real-adaptive-routing-study', completed: cycle !== undefined && verificationComplete,
  matrixComplete, verificationComplete, expectedCells, claimSha256: hash(await readFile(claimPath)), preflight,
  node: process.version, durationMs: Date.now() - started, safetyEnvelope: { maxRequestedAttempts: 32, perTurnTimeoutMs: 60000,
    totalTimeoutMs: 20 * 60000, requireAuth: 'subscription', paidRoutingApis: 0, automaticRetries: 0, cliUpdates: 0 },
  source: { artifactBuildDigest: packed.source.sourceManifestSha256, proofDigest: source.sourceManifestSha256, normalizedAppInputs },
  coreSha256: external.core.sha256,
  applicationCodeSha256: external.applicationCodeSha256, lockSha256: external.lockSha256,
  configurationSha256: hash(await readFile(config)), databaseSha256: hash(await readFile(database)),
  domain: status.domain, models, cycle, failure, pointer: status.pointer,
  terminalAttempts: rows.length, pendingAttempts: status.pending.length, modelLaunches: null, routingApiCalls: 0,
  observations: status.observations, consumerDirectory: app, stateDirectory: directory,
  limitation: 'Small prospective classification study of requested CLI configurations with native inherited context in a new workspace; no universal ranking. Backend identity only known where reported. Cost fields retain their explicit meaning; API-equivalent amounts are not observed subscription charges. No extra production model turns.' };
await writeFile(join(out, 'learning-live.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ completed: receipt.completed, models, gate: cycle?.gate.status,
  terminalAttempts: rows.length, pendingAttempts: status.pending.length, receipt: join(out, 'learning-live.json') }, null, 2));
