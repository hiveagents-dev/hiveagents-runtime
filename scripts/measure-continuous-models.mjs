/** One prospective source-bound study, resumed across processes; <=100 new admissions. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installedProofContext, sha256 } from './installed-proof-context.mjs';
import { claimLearningStudy } from './learning-live-claim.mjs';
import { continuousLiveCorpus, continuousProductionTasks } from './continuous-live-corpus.mjs';
import { materializeLiveInputs, prepareLiveWorkspace, neutralGitEnvironment, assertReviewedWorkspaceFailure, captureStudyContinuation, assertStudyReceiptBinding, isCompleteLiveStudy } from './continuous-live-proof.mjs';

assert.equal(process.env.OAR_CONTINUOUS_LIVE, '1', 'Set OAR_CONTINUOUS_LIVE=1 for existing subscription CLI capacity');
const values = new Map();
for (let n = 2; n < process.argv.length; n += 2) {
  const flag = process.argv[n], value = process.argv[n + 1];
  assert.ok(['--codex-command', '--claude-command', '--prior-study-receipt'].includes(flag) && !values.has(flag) && value && isAbsolute(value));
  values.set(flag, await realpath(value));
}
assert.ok(values.has('--codex-command') && values.has('--claude-command'), 'Both explicit native executable paths are required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/continuous-routing/final');
const workspaceContext = await prepareLiveWorkspace(root), workspace = workspaceContext.workspace;
for(const name of Object.keys(process.env)) if(name.startsWith('GIT_')) delete process.env[name];
const proof = await installedProofContext(root, out);
let continuation, priorInputs = [], priorDirectory;
if(values.has('--prior-study-receipt')) {
  const path=values.get('--prior-study-receipt'), receiptBytes=await readFile(path);
  assert.ok(receiptBytes.length <= 8*1024*1024); assertReviewedWorkspaceFailure(receiptBytes); const prior=JSON.parse(receiptBytes);
  assert.ok(isAbsolute(prior.stateDirectory),'Prior state directory must be absolute');
  const claimPath=join(dirname(path),'continuous-live.start.json'), claimBytes=await readFile(claimPath);
  const databasePath=join(prior.stateDirectory,'learning/evidence.sqlite'), databaseBytes=await readFile(databasePath);
  assert.equal(sha256(databaseBytes),prior.databaseSha256,'Prior database changed after stopped-work inspection');
  continuation=captureStudyContinuation(receiptBytes,claimBytes,databasePath,proof.bindings);
  const { FileWorkflowStore } = await import(pathToFileURL(proof.external.moduleResolution['hiveagents-runtime/orchestration']).href);
  const ownership = new FileWorkflowStore(join(prior.stateDirectory, 'learning-study'));
  assert.ok(!await ownership.inspectOwnership(`learning-study:${prior.status.studyId}`), 'Prior study is still owned');
  priorDirectory=prior.stateDirectory;
  priorInputs=[{name:'prior-receipt',path,bytes:receiptBytes},{name:'prior-claim',path:claimPath,bytes:claimBytes},{name:'prior-database',path:databasePath,bytes:databaseBytes}];
}
const maximum = continuation?.maxNewAdmissions ?? 100;
const maximumDurationMs = continuation?.maxNewDurationMs ?? 30*60000;
const fullCorpus = continuousLiveCorpus(2), firstCorpus = continuousLiveCorpus(1), productionTasks = continuousProductionTasks();
if(continuation) for(const corpus of [fullCorpus,firstCorpus]) { corpus.id += '-git-'+continuation.idSuffix; corpus.study.maxLaunches=maximum; }
const directory = join(out, `live-${randomUUID()}`);
if (continuation) {
  const path = await claimLearningStudy(priorDirectory, {kind:'continuous-workspace-correction-start', directory,
    source:proof.bindings, continuation, createdAt:Date.now()},
    {startFile:'continuous-live.correction.start.json',receiptFile:'continuous-live.correction.json'});
  const anchor = await readFile(path); continuation.anchorSha256=sha256(anchor);
  priorInputs.push({name:'continuation-anchor',path,bytes:anchor});
}
const definition = { model: { mode: 'auto', allowUnverifiedModels: true, candidates: [
  { id: 'sol', model: 'codex/gpt-5.6-sol', effort: 'low' }, { id: 'sonnet', model: 'claude/claude-sonnet-5', effort: 'low' },
] }, transport: 'exec', context: { profile: 'native', memory: 'inherit' }, requireAuth: 'subscription', permissions: { mode: 'analyze' }, cwd: workspace };
const configPath = join(directory, 'agent.json'), corpusPath = join(directory, 'corpus.json');
const bytes = value => JSON.stringify(value, null, 2) + '\n';
const generatedInputs = [
  { name: 'definition', path: configPath, bytes: bytes(definition) },
  { name: 'corpus', path: corpusPath, bytes: bytes(firstCorpus) },
  { name: 'prospective-corpus', path: join(directory, 'prospective-full-corpus.json'), bytes: bytes(fullCorpus) },
  ...productionTasks.map(task => ({ name: task.id, path: join(directory, `${task.id}.json`), bytes: bytes(task) })),
];
const inputs = [...priorInputs,...generatedInputs];
const claimPath = await claimLearningStudy(out, { kind: 'continuous-study-start', source: proof.bindings,
  directory, workspaceContext, continuation, completeProspectiveCorpusSha256: sha256(JSON.stringify(fullCorpus)), productionInputSha256: sha256(JSON.stringify(productionTasks)),
  prospectiveFiles: inputs.map(file => ({ name: file.name, sha256: sha256(file.bytes) })), fullCorpusFileSha256: sha256(bytes(fullCorpus)),
  maxNewAdmissions: maximum, matrixPlan: 96, productionPlan: 2, familyAlpha: .05, maxCycles: 2, effectiveAlpha: .025,
  maxNewDurationMs:maximumDurationMs, maxAggregateDurationMs:30*60000,
  createdAt: Date.now() }, { startFile: 'continuous-live.start.json', receiptFile: 'continuous-live.json' });
await mkdir(directory, { recursive: true, mode: 0o700 });
const inputAudit = await materializeLiveInputs(generatedInputs,priorInputs);
for (const name of Object.keys(process.env)) {
  if (/^OAR_(?:CLAUDE|CODEX|GEMINI|ANTIGRAVITY)_(?:COMMAND|ARGS_JSON)$/.test(name)
    || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'TYPESAFE_API_KEY', 'OAR_LEARNING_CALLS', 'OAR_LEARNING_FIXTURE_MODE'].includes(name)) delete process.env[name];
}
process.env.OAR_CODEX_COMMAND = values.get('--codex-command'); process.env.OAR_CODEX_ARGS_JSON = '[]';
process.env.OAR_CLAUDE_COMMAND = values.get('--claude-command'); process.env.OAR_CLAUDE_ARGS_JSON = '[]';
const environment = neutralGitEnvironment(process.env);
const { createAppRuntime } = await import(pathToFileURL(join(proof.app, 'dist/runtime.js')).href);
const { captureStudyOptions, openStudyApplication } = await import(pathToFileURL(join(proof.app, 'dist/learning-study-session.js')).href);
const learning = await import(pathToFileURL(proof.external.moduleResolution['hiveagents-runtime/routing/learning']).href);
const { curriculumIdentity, verifyStudyOutput } = await import(pathToFileURL(join(proof.app, 'dist/learning-curriculum.js')).href);
const runtime = createAppRuntime({ codexExecutable: { command: values.get('--codex-command'), argsPrefix: [] },
  claudeExecutable: { command: values.get('--claude-command'), argsPrefix: [] } });
const options = { definition, corpus: firstCorpus, stateDirectory: directory, cwd: workspace, objective: 'latency', timeoutMs: 60000, runtime };
const common = ['--config', configPath, '--corpus', corpusPath, '--state-dir', directory, '--objective', 'latency', '--timeout-ms', '60000', '--cwd', workspace];
const controller = new AbortController(), started = Date.now(), phases = [], diagnostics = [];
let currentCorpus = firstCorpus, studyBinding;
const interrupt = () => controller.abort(new Error('CONTINUOUS_STUDY_CANCELLED'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const timer = setTimeout(() => controller.abort(new Error('CONTINUOUS_STUDY_TIMEOUT')), maximumDurationMs);
async function invoke(label, command, args = [], inspectOnly = false) {
  return inputAudit.around(label, async () => {
  if (!inspectOnly) { controller.signal.throwIfAborted(); await proof.assertUnchanged(); controller.signal.throwIfAborted(); }
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ['dist/main.js', command, ...common, ...args], { cwd: proof.app, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const abort = () => child.kill('SIGTERM');
    if (!inspectOnly) controller.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) { overflow = true; abort(); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.once('error', error => { controller.signal.removeEventListener('abort', abort); rejectResult(error); });
    child.once('close', (code, signal) => {
      controller.signal.removeEventListener('abort', abort);
      diagnostics.push({ label, exitCode: code, signal, stderrSha256: sha256(stderr), overflow });
      if (code !== 0 || overflow) rejectResult(Object.assign(new Error('Independent application invocation failed'), { code: 'INDEPENDENT_APP_FAILED' }));
      else { try { resolveResult(JSON.parse(stdout)); } catch { rejectResult(Object.assign(new Error('Invalid application receipt'), { code: 'INVALID_APP_RECEIPT' })); } }
    });
  });
  phases.push({ label, result });
  assertStudyReceiptBinding(result, studyBinding);
  if (!inspectOnly) {
    assert.notEqual(result.status, 'blocked', 'A pending/unknown cell stops all dependent study work');
    assert.ok(result.admittedAttempts <= maximum, 'Durable admission cap exceeded');
  }
  return result;
  });
}
let preflight, failure, status, rows = [], gates = [], episodes = [], pending = [];
try {
  await inputAudit.around('preflight', async () => {
    const session = await openStudyApplication(captureStudyOptions(options), false);
    try {
    const task = firstCorpus.train[0];
    preflight = await session.router.preflight(definition, { runtime, task: { id: task.id, version: '1', text: task.text, inputDigest: learning.inputDigest(task.text) }, timeoutMs: 60000, signal: controller.signal });
    assert.deepEqual(preflight.actions.map(action => action.id), ['sol', 'sonnet'], 'Both configured arms must be eligible before any native turn');
    const identity = curriculumIdentity(firstCorpus);
    studyBinding = { domain: session.domain, studyId: firstCorpus.id, baseDigest: identity.baseDigest,
      definitionDigest: preflight.definitionDigest, actions: preflight.actions,
      batches: identity.batches.map(({ id, digest }) => ({ id, digest })) };
    } finally { session.close(); }
  });
  await proof.assertUnchanged();
  const chunk = await invoke('initial-chunk', 'study-cycle', ['--max-launches', '4', '--batch-id', 'fresh-one', '--total-launches', String(maximum)]);
  assert.equal(chunk.status, 'paused'); assert.equal(chunk.invocationAttempts, 4);
  const first = await invoke('resume-first', 'study-cycle', ['--max-launches', '56', '--batch-id', 'fresh-one', '--total-launches', String(maximum)]);
  assert.equal(first.status, 'completed'); assert.equal(first.admittedAttempts, 60);
  const replay = await invoke('replay-first', 'study-cycle', ['--max-launches', '1', '--batch-id', 'fresh-one', '--total-launches', String(maximum)]);
  assert.equal(replay.invocationAttempts, 0); assert.deepEqual(replay.cycles, first.cycles);
  const firstStatus = await invoke('first-status', 'study-status', [], true);
  assert.equal(firstStatus.domain, first.domain);
  await inputAudit.assert('append:before');
  await writeFile(corpusPath, bytes(fullCorpus), { mode: 0o600 });
  inputAudit.expect('corpus', corpusPath, bytes(fullCorpus)); currentCorpus = fullCorpus;
  studyBinding.batches = curriculumIdentity(fullCorpus).batches.map(({ id, digest }) => ({ id, digest }));
  await inputAudit.assert('append:after');
  const second = await invoke('append-second', 'study-cycle', ['--max-launches', '36', '--batch-id', 'fresh-two', '--total-launches', String(maximum)]);
  assert.equal(second.status, 'completed'); assert.equal(second.domain, first.domain); assert.equal(second.admittedAttempts, 96);
  for (const task of productionTasks) {
    const path = inputs.find(file => file.name === task.id).path;
    const production = await invoke(task.id, 'study-run', ['--input', path, '--max-launches', '2', '--auto-improve', '--total-launches', String(maximum)]);
    assert.equal(production.domain, first.domain);
    assert.equal(production.observation?.quality.state, 'verified');
    assert.equal(production.observation.quality.passed, true, 'Independent production oracle failed');
    assert.equal(production.observation.domain, studyBinding.domain);
    assert.equal(production.receipt.domain, studyBinding.domain);
    assert.equal(production.receipt.definitionDigest, studyBinding.definitionDigest);
    assert.equal(production.observation.taskDigest, learning.inputDigest(task.text));
    assert.equal(production.receipt.taskDigest, learning.inputDigest(task.text));
    assert.equal(verifyStudyOutput(production.text, task.expected).passed, true, 'Production text must satisfy the predeclared independent oracle');
    assert.equal(production.invocationAttempts, 1, 'Exhausted batches must not launch maintenance work');
    assert.equal(production.maintenance?.status, 'deferred');
    assert.equal(production.maintenance.invocationAttempts ?? 0, 0);
    assert.equal(production.pendingAttemptIds?.length ?? 0, 0);
    assert.equal(production.receipt.policy, production.pointer.active, 'Production did not use the current compatible active policy');
  }
} catch (error) {
  failure = { name: error instanceof Error ? error.name : 'UnknownError', code: typeof error?.code === 'string' ? error.code : 'STUDY_INCOMPLETE' };
} finally {
  clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
try { status = await invoke('final-status', 'study-status', [], true); }
catch (error) { failure ??= { code: 'STATUS_UNAVAILABLE' }; }
const finalSession = await openStudyApplication(captureStudyOptions({ ...options, corpus: currentCorpus }), false);
try {
  rows = [...await finalSession.evidence.observations(finalSession.domain, { limit: 101 })];
  pending = [...await finalSession.evidence.pending(finalSession.domain)];
  for (const phase of phases) for (const report of phase.result.cycles ?? []) {
    const gate = await finalSession.evidence.get('gate', report.gate.id);
    if (gate && !gates.some(old => old.id === gate.id)) {
      gates.push(gate);
      for (const id of [gate.fixed.episodeId, gate.fresh.episodeId]) {
        const episode = await finalSession.evidence.get('episode', id); if (episode && !episodes.some(old => old.id === id)) episodes.push(episode);
      }
    }
  }
} finally { finalSession.close(); }
assert.ok(rows.length <= maximum && (status?.admittedAttempts ?? 0) <= maximum);
const actions = preflight?.actions ?? [], trainHashes = new Set(fullCorpus.train.map(task => learning.inputDigest(task.text)));
const matrix = rows.map(row => row.observation).filter(row => row.split !== 'train' || trainHashes.has(row.taskDigest));
const episodeBatch = new Map();
for (const episode of episodes.filter(episode => episode.kind === 'fresh')) {
  const matched = fullCorpus.freshBatches.find(batch => batch.tasks.length === episode.tasks.length
    && batch.tasks.every(task => episode.tasks.some(item => item.taskDigest === learning.inputDigest(task.text))));
  if (matched) { episodeBatch.set(episode.id, matched.id); episodeBatch.set(episode.comparison.fixedEpisodeId, matched.id); }
}
const key = row => JSON.stringify([row.split, row.batch ?? null, row.taskDigest, row.actionKey, row.repetition ?? 0]);
const expected = fullCorpus.train.flatMap(task => actions.map(action => ({ split: 'train', taskDigest: learning.inputDigest(task.text), actionKey: action.key })));
for (const batch of fullCorpus.freshBatches) for (const split of ['fixed', 'fresh']) {
  for (const task of split === 'fixed' ? fullCorpus.fixed : batch.tasks) for (const action of actions) for (let repetition = 0; repetition < 2; repetition++) expected.push({ split, batch: batch.id, taskDigest: learning.inputDigest(task.text), actionKey: action.key, repetition });
}
const planned = new Set(expected.map(key)), observed = new Set(matrix.map(row => key({ ...row, batch: row.episodeId === undefined ? undefined : episodeBatch.get(row.episodeId), actionKey: row.action.key })));
const matrixComplete = expected.length === 96 && planned.size === 96 && matrix.length === 96 && observed.size === 96 && [...observed].every(cell => planned.has(cell));
const models = actions.map(action => {
  const rs = matrix.filter(row => row.action.key === action.key), verified = rs.filter(row => row.quality.state === 'verified');
  const times = rs.filter(row => row.latency.state === 'observed').map(row => row.latency.durationMs);
  return { action, terminal: rs.length, verified: verified.length, passed: verified.filter(row => row.quality.passed).length,
    observedLatencyCount: times.length, meanObservedLatencyMs: times.length ? times.reduce((a, b) => a + b) / times.length : null,
    reportedBackendIdentityCount: rs.filter(row => row.observedModels?.length).length,
    costMeanings: [...new Set(rs.map(row => row.usage?.costMeaning ?? 'unavailable'))], actualSubscriptionSpendUsd: null };
});
const productionResults = phases.filter(phase => productionTasks.some(task => task.id === phase.label)).map(phase => phase.result);
const productionVerified = productionResults.length === 2 && productionResults.every(result => result.observation?.quality.state === 'verified' && result.observation.quality.passed);
try { await proof.assertUnchanged(); await inputAudit.assert('final'); }
catch { failure ??= { code: 'INPUT_OR_SOURCE_DRIFT' }; }
const productionSelections = productionResults.map((result, index) => ({ taskId: productionTasks[index].id,
  policy: result.receipt?.policy, activeAtReturn: result.pointer?.active, reason: result.receipt?.reason,
  verified: result.observation?.quality.state === 'verified' && result.observation.quality.passed }));
const learnedSelectionCount = productionSelections.filter(result => typeof result.policy === 'string' && result.policy === result.activeAtReturn && result.reason === 'LEARNED').length;
const finalCorpusAudit = inputAudit.records.findLast(record => record.name === 'corpus');
const receipt = { kind: 'independent-app-real-continuous-study', completed: isCompleteLiveStudy({ failure, matrixComplete,
    matrixVerified: matrix.every(row => row.quality.state === 'verified'), productionVerified, rows: rows.length, status, pending, phases, production: productionResults }),
  node: process.version, durationMs: Date.now() - started, ...proof.bindings, workspace, workspaceContext, continuation, stateDirectory: directory,
  claimSha256: sha256(await readFile(claimPath)), prospectiveCorpusSha256: sha256(JSON.stringify(fullCorpus)),
  expectedCorpusFileSha256: sha256(bytes(currentCorpus)), corpusFileSha256: finalCorpusAudit?.observedSha256 ?? null,
  corpusAuditPhase: finalCorpusAudit?.phase ?? null,
  inputAudits: inputAudit.records, expectedStudyBinding: studyBinding,
  databaseSha256: sha256(await readFile(join(directory, 'learning/evidence.sqlite'))),
  safetyEnvelope: { maxNewAdmissions: maximum, matrixPlan: 96, productionPlan: 2, timeoutMs: 60000, totalTimeoutMs:maximumDurationMs,
    maxAggregateDurationMs:30*60000, priorDurationMs:continuation?.priorDurationMs ?? 0,
    familyAlpha: .05, maxCycles: 2, effectiveAlpha: .025, automaticRetries: 0, routingApiCalls: 0 },
  failure, preflight, status, matrixComplete, productionVerified,
  productionSelections, learnedSelectionCount, deployedPolicyApplied: learnedSelectionCount > 0,
  allProductionSelectionsLearned: productionVerified && learnedSelectionCount === 2,
  models, gates, episodes, phases, diagnostics, observations: rows,
  terminalObservations: rows.length, durableStarts: rows.length + pending.length,
  durableAdmissions: status?.admittedAttempts ?? null,
  pendingAttemptIds: pending.map(attempt => attempt.id), pendingAttemptCount: pending.length,
  modelLaunches: null, routingApiCalls: 0,
  limitation: 'Prospective small bilingual classification study of requested CLI configurations. Native context inherits global configuration; empty workspace is outside checkout. Backend identity only known when reported. API-equivalent amounts are not observed subscription charges. No universal ranking or forced promotion.' };
await writeFile(join(out, 'continuous-live.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
if (!receipt.completed) process.exitCode = 1;
console.log(JSON.stringify({ completed: receipt.completed, terminalObservations: rows.length, durableAdmissions: receipt.durableAdmissions,
  pendingAttemptCount: pending.length, models,
  gates: gates.map(gate => ({ outcome: gate.outcome, reason: gate.reason, fresh: { wins: gate.fresh.wins, losses: gate.fresh.losses, ties: gate.fresh.ties, pValue: gate.fresh.pValue } })),
  pointer: status?.pointer, receipt: join(out, 'continuous-live.json') }, null, 2));
