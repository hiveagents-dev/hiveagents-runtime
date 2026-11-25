/** Offline proof through the independently npm-installed document application. No provider or model calls. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDependencyPaths, hashApplicationCode, parseArguments, verifyExternalConsumer } from './verify-external-consumer.mjs';
import { verifyInstalledTarball } from './verify-package-contents.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/neutral-log-delivery');
const hash = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const options = args.length ? parseArguments(args) : {
  coreTarball: join(out, 'core.tgz'),
};
await mkdir(out, { recursive: true });
// Explicitly forbid registry downloads and install hooks even when an existing npm cache is incomplete.
Object.assign(process.env, { npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_legacy_peer_deps: 'true',
  OAR_CONSUMER_KEEP: '1', OAR_LIVE: '0', OAR_LIVE_TURNS: '0' });
const external = await verifyExternalConsumer(options);
assert.equal(external.passed, true);
const app = await realpath(external.consumerDirectory);
await auditDependencyPaths(app, root);
assert.equal(hash(await readFile(options.coreTarball)), external.core.sha256);
verifyInstalledTarball(options.coreTarball, join(app, 'node_modules/hiveagents-runtime'));
assert.equal(await hashApplicationCode(app), external.applicationCodeSha256);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-neutral-log-proof-')));
const environment = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
const invocations = [];
function invoke(command, ...flags) {
  const run = spawnSync(process.execPath, ['dist/main.js', command, ...flags], { cwd: app, env: environment,
    encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  invocations.push({ command, status: run.status, signal: run.signal, stdoutSha256: hash(run.stdout ?? ''), stderrSha256: hash(run.stderr ?? '') });
  assert.equal(run.status, 0, `${command} failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout);
}
const state = join(directory, 'state'), input = join(directory, 'documents.json'), runId = 'independent-neutral-log';
const canary = 'CANARY_PRIVATE_LOG_INPUT_DO_NOT_PROJECT';
await writeFile(input, JSON.stringify([{ id: 'vpn', text: `${canary}: VPN certificate expired.` }, { id: 'billing', text: 'Invoice payment receipt.' }]), { mode: 0o600 });
const first = invoke('log-run', '--input', input, '--state-dir', state, '--run-id', runId);
assert.equal(first.runId, runId); assert.ok(['completed', 'verified'].includes(first.status));
assert.equal(first.modelLaunches, 0); assert.equal(first.effectCount, 1);
const originalReport = hash(await readFile(first.reportPath));
const again = invoke('log-run', '--input', input, '--state-dir', state, '--run-id', runId);
assert.equal(again.decisionId, first.decisionId); assert.equal(again.intentId, first.intentId);
assert.equal(again.effectCount, 1); assert.equal(again.modelLaunches, 0);
assert.equal(hash(await readFile(first.reportPath)), originalReport, 'Replay changed the original effect target');
const inspected = invoke('log-inspect', '--state-dir', state, '--run-id', runId);
assert.equal(inspected.effectCount, 1); assert.deepEqual(inspected.unresolvedEffects, []);
const rebuilt = invoke('log-rebuild', '--state-dir', state, '--run-id', runId);
const repeated = invoke('log-rebuild', '--state-dir', state, '--run-id', runId);
assert.deepEqual(rebuilt, repeated, 'Rebuilding committed history must be deterministic');
assert.equal(rebuilt.modelLaunches, 0); assert.equal(rebuilt.trace.scope, 'captured-metadata');
assert.deepEqual(rebuilt.trace.through, rebuilt.audit.through); assert.deepEqual(rebuilt.trace.through, inspected.sourceHead);
assert.equal(JSON.stringify(rebuilt).includes(canary), false); assert.equal(JSON.stringify(inspected).includes(canary), false);
const handed = invoke('log-handoff', '--state-dir', state, '--run-id', runId);
assert.equal(handed.modelLaunches, 0); assert.ok(['completed', 'verified'].includes(handed.status));
assert.equal(hash(await readFile(first.reportPath)), originalReport);

// Preserve this disposable proof, then corrupt its ORIGINAL origin at the same binding.
// A relocated copy could fail only because its target changed and would be a vacuous integrity test.
await cp(state, join(directory, 'before-corruption'), { recursive: true });
const corrupt = state;
async function sqliteFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await sqliteFiles(child));
    else if (entry.isFile() && /\.(?:sqlite|db)$/.test(entry.name)) files.push(child);
  }
  return files;
}
const files = await sqliteFiles(corrupt); assert.ok(files.length, 'No durable origin to verify');
const mutation = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import {DatabaseSync} from 'node:sqlite';
  let db;
  for(const path of JSON.parse(process.argv[1])) {
    const candidate=new DatabaseSync(path);
    if(candidate.prepare("SELECT name FROM sqlite_schema WHERE name='oar_log_events'").get()){db=candidate;break;}
    candidate.close();
  }
  if(!db)process.exit(7);
  const sql="UPDATE oar_log_events SET body_json=body_json||' ' WHERE sequence=(SELECT min(sequence) FROM oar_log_events)";
  let appendOnlyEnforced=false;try{db.exec(sql);}catch{appendOnlyEnforced=true;}
  if(!appendOnlyEnforced)process.exit(8);
  const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='oar_log_events_update'").get().sql;
  db.exec('BEGIN IMMEDIATE; DROP TRIGGER oar_log_events_update');
  db.exec(sql);db.exec(trigger);db.exec('COMMIT');
  db.close();
  console.log(JSON.stringify({appendOnlyEnforced,ownedCorruptionApplied:true}));
` , JSON.stringify(files)], { cwd: app, env: environment, encoding: 'utf8', timeout: 10_000 });
assert.equal(mutation.status, 0, `Owned neutral origin mutation did not run: ${mutation.stderr}`);
assert.deepEqual(JSON.parse(mutation.stdout), { appendOnlyEnforced: true, ownedCorruptionApplied: true });
const refused = spawnSync(process.execPath, ['dist/main.js', 'log-inspect', '--state-dir', corrupt, '--run-id', runId],
  { cwd: app, env: environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
assert.ok(refused.status !== 0 || ['corrupt', 'incomplete', 'unknown', 'halted', 'owner-required', 'needs-owner'].includes(JSON.parse(refused.stdout).status), 'Corrupt origin became completed success');

async function fixtureHashes(path) {
  const values = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'Fixture links are not independent evidence');
    const child = join(path, entry.name);
    if (entry.isDirectory()) values.push(...await fixtureHashes(child));
    else if (entry.isFile()) values.push([child.slice(app.length + 1), hash(await readFile(child))]);
  }
  return values.sort(([left], [right]) => left.localeCompare(right));
}
const receipt = {
  kind: 'independent-neutral-log-consumer', passed: true, node: process.version, sqlite: process.versions.sqlite,
  platform: process.platform, architecture: process.arch, core: external.core,
  lockSha256: external.lockSha256, applicationCodeSha256: external.applicationCodeSha256,
  fixtureSourcesSha256: hash(JSON.stringify(await fixtureHashes(join(app, 'tests')))),
  workerEvidence: 'Actual app node:test crash/reopen cases are included in the external-consumer test run; file presence is not a dispatch counter.',
  sourceHead: inspected.sourceHead, reportSha256: originalReport, projectionSha256: hash(JSON.stringify(rebuilt)), invocations,
  appendOnlyEnforced: true, corruptionRefused: true, modelLaunches: 0, paidRoutingCalls: 0,
  consumerDirectory: app, proofDirectory: directory,
};
await writeFile(join(out, 'external-receipt.json'), JSON.stringify(external, null, 2) + '\n', { mode: 0o600 });
await writeFile(join(out, 'neutral-log-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
