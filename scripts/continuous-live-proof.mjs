/** Prospective native-study inputs and completion conditions; no model work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export class LiveInputAudit {
  #files = new Map();
  #records = [];
  constructor(files) { for (const file of files) this.expect(file.name, file.path, file.bytes); }
  expect(name, path, bytes) { this.#files.set(name, { path, bytes: Buffer.from(bytes) }); }
  get records() { return this.#records.map(record => ({ ...record })); }
  async assert(phase) {
    const errors = [];
    for (const [name, { path, bytes }] of this.#files) {
      const record = { phase, name, path, expectedSha256: hash(bytes), observedSha256: null, matched: false };
      try {
        const info = await lstat(path);
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, 'Live study input file changed');
        record.observedSha256 = hash(await readFile(path));
        record.matched = record.observedSha256 === record.expectedSha256;
        assert.ok(record.matched, 'Live study input bytes changed');
      } catch (error) { errors.push(error); }
      finally { this.#records.push(record); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Live study inputs changed');
  }
  async around(phase, callback) {
    await this.assert(`${phase}:before`);
    let original;
    try { return await callback(); }
    catch (error) { original = error; throw error; }
    finally {
      try { await this.assert(`${phase}:after`); }
      catch (error) { if (original) throw new AggregateError([original, error], 'Operation and live input validation failed'); throw error; }
    }
  }
}

export async function materializeLiveInputs(generated, preserved = []) {
  for (const file of generated) await writeFile(file.path, file.bytes, {mode:0o600,flag:'wx'});
  return new LiveInputAudit([...preserved, ...generated]);
}

/** This opt-in correction is bound to the independently inspected pre-model refusal. */
export function assertReviewedWorkspaceFailure(bytes) {
  assert.equal(hash(bytes), '0f419ff496b433de3a71d753222abbd4d11ef62b5b151a90f75ff1b8f6a1088f', 'Unreviewed native failure cannot authorize workspace correction');
}

export async function assertLiveWorkspace(root, workspace) {
  const canonical = await realpath(workspace), rel = relative(await realpath(root), canonical);
  assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'Live workspace must be outside checkout');
  assert.equal((await readdir(canonical)).length, 0, 'Live workspace must be empty');
  return canonical;
}

export function assertStudyReceiptBinding(result, binding) {
  assert.equal(result.domain, binding.domain, 'Study domain changed');
  assert.equal(result.studyId, binding.studyId, 'Study ID changed');
  if ('baseDigest' in result) {
    assert.equal(result.baseDigest, binding.baseDigest, 'Study foundation/labels changed');
    assert.deepEqual(result.registeredBatches, binding.batches, 'Registered study batches/labels changed');
  }
  for (const report of result.cycles ?? []) {
    const expected = binding.batches.find(batch => batch.id === report.batchId);
    assert.ok(expected, 'Unexpected study batch');
    assert.equal(report.domain, binding.domain);
    assert.equal(report.batchDigest, expected.digest);
    assert.equal(report.dataSources.baseDigest, binding.baseDigest);
    assert.equal(report.dataSources.batchDigest, expected.digest);
    assert.equal(report.dataSources.definitionDigest, binding.definitionDigest);
    assert.deepEqual(report.dataSources.actions, binding.actions);
  }
}

export function isCompleteLiveStudy(input) {
  const noPending = result => result && !(result.pendingAttemptIds?.length) && result.status !== 'blocked';
  return Boolean(!input.failure && input.matrixComplete && input.matrixVerified && input.productionVerified
    && input.rows === 98 && input.status?.admittedAttempts === 98
    && ['completed', 'exhausted'].includes(input.status?.status) && noPending(input.status)
    && input.pending.length === 0 && input.phases.every(phase => noPending(phase.result))
    && input.production.length === 2 && input.production.every(result => result.status === 'completed'
      && noPending(result) && result.invocationAttempts === 1 && result.maintenance?.status === 'deferred'
      && (result.maintenance.invocationAttempts ?? 0) === 0 && noPending(result.maintenance)));
}

/** Git overrides cannot redirect setup or provider children into another checkout. */
export function neutralGitEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')));
}
export async function prepareLiveWorkspace(root) {
  const parent = await assertLiveWorkspace(root, await mkdtemp(join(tmpdir(), 'oar-continuous-git-parent-')));
  const environment = neutralGitEnvironment(process.env);
  const git = args => {
    const result = spawnSync('git', args, { cwd: parent, env: environment, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(result.status, 0, 'Neutral Git workspace preparation failed'); return result.stdout.trim();
  };
  git(['init', '--quiet', '--template=', '--initial-branch=oar-study', parent]);
  git(['config', '--local', 'core.hooksPath', '/dev/null']);
  git(['config', '--local', 'core.fsmonitor', 'false']);
  const workspace = await assertLiveWorkspace(root, await mkdtemp(join(parent, 'workspace-')));
  assert.equal(await realpath(git(['-C', workspace, 'rev-parse', '--show-toplevel'])), parent, 'Unexpected Git workspace root');
  return { workspace, parent, gitConfigSha256: hash(await readFile(join(parent, '.git/config'))), gitOverridesRemoved: true };
}
/** Only an explicitly inspected, stopped, first-training failure can debit this correction. */
export function captureStudyContinuation(receiptBytes, claimBytes, databasePath, bindings) {
  assert.ok(receiptBytes.length <= 8*1024*1024 && claimBytes.length <= 8*1024*1024);
  const prior = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(receiptBytes));
  const claim = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(claimBytes));
  assert.equal(prior.kind, 'independent-app-real-continuous-study'); assert.equal(prior.completed, false);
  assert.equal(prior.safetyEnvelope.maxNewAdmissions, 100); assert.equal(prior.safetyEnvelope.maxCycles, 2);
  assert.equal(prior.safetyEnvelope.effectiveAlpha, .025); assert.equal(prior.safetyEnvelope.familyAlpha, .05); assert.equal(prior.durableAdmissions, 1);
  assert.equal(prior.safetyEnvelope.totalTimeoutMs,1800000);
  assert.ok(Number.isSafeInteger(prior.durationMs) && prior.durationMs>=0 && prior.durationMs<1800000, 'Prior duration is missing, invalid or exhausted');
  assert.equal(prior.durableStarts, 1); assert.equal(prior.terminalObservations, 1);
  assert.equal(prior.pendingAttemptCount, 0); assert.deepEqual(prior.pendingAttemptIds, []);
  assert.deepEqual(prior.gates, []); assert.deepEqual(prior.episodes, []);
  assert.equal(prior.status.status, 'blocked'); assert.equal(prior.status.admittedAttempts, 1);
  assert.deepEqual(prior.status.pointer, {generation:0,active:null,previous:null});
  for (const key of ['coreSha256','applicationCodeSha256']) assert.equal(prior[key], bindings[key], 'Prior executable/scorer binding changed');
  assert.equal(hash(claimBytes), prior.claimSha256); assert.equal(claim.directory, prior.stateDirectory);
  const database = new DatabaseSync(databasePath, {readOnly:true});
  try {
    const count = kind => Number(database.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(kind).n);
    assert.equal(count('attempt'),1); for(const kind of ['gate','gate-commit','episode']) assert.equal(count(kind),0);
    const snapshots=database.prepare("SELECT json FROM records WHERE kind='snapshot'").all();
    assert.ok(snapshots.length<=1);
    for(const row of snapshots) { const snapshot=JSON.parse(row.json); assert.equal(snapshot.through,0); assert.deepEqual(snapshot.rows,[]); assert.equal(snapshot.domain,prior.status.domain); }
    const rows = database.prepare('SELECT json FROM observations').all(); assert.equal(rows.length,1);
    const observation = JSON.parse(rows[0].json); assert.deepEqual(observation, prior.observations[0].observation);
    assert.equal(observation.domain,prior.status.domain); assert.equal(observation.split,'train'); assert.equal(observation.outcome,'failed');
    assert.equal(observation.quality.state,'unknown');
    const attempts=database.prepare("SELECT json FROM records WHERE kind='attempt'").all();
    assert.equal(JSON.parse(attempts[0].json).id,observation.attemptId);
    const pointers=database.prepare('SELECT generation,active,previous FROM pointers').all();
    assert.ok(pointers.every(pointer=>pointer.generation===0&&pointer.active===null&&pointer.previous===null));
  } finally { database.close(); }
  return { priorReceiptSha256:hash(receiptBytes), priorClaimSha256:hash(claimBytes), priorDatabaseSha256:prior.databaseSha256, priorSourceDigest:prior.proofSourceDigest,
    priorAdmissions:1, maxNewAdmissions:99, maxAggregateAdmissions:100, priorDurationMs:prior.durationMs,
    maxNewDurationMs:1800000-prior.durationMs, maxAggregateDurationMs:1800000, idSuffix:hash(receiptBytes).slice(0,12) };
}
