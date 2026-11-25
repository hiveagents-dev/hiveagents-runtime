import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runEvaluation } from 'hiveagents-runtime/orchestration';
import { compareDocumentEvaluations } from '../dist/harness-evaluation.js';

const main = new URL('../dist/main.js', import.meta.url);
function invoke(args) {
  const value = spawnSync(process.execPath, [main.pathname, ...args], { encoding: 'utf8', timeout: 30000 });
  return { ...value, json: value.status === 0 ? JSON.parse(value.stdout) : undefined };
}

test('evaluates30 labelled cases against independent oracles and persists redacted traces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-eval-test-'));
  try {
    const baseline = invoke(['evaluate', '--state-dir', directory, '--profile', 'baseline']);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(baseline.json.caseCount, 30);
    assert.equal(baseline.json.modelLaunches, 0);
    const candidate = invoke(['evaluate', '--state-dir', directory, '--profile', 'candidate']);
    assert.equal(candidate.status, 0, candidate.stderr);
    const comparison = invoke(['evaluation-compare', '--baseline', baseline.json.reportPath, '--candidate', candidate.json.reportPath]);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert.equal(comparison.json.comparable, true);
    const trace = invoke(['trace-inspect', '--state-dir', directory, '--episode', candidate.json.episodeId]);
    assert.equal(trace.status, 0, trace.stderr);
    assert.equal(trace.json.status, 'completed');
    assert.ok(trace.json.entries.length > 0);
    assert.equal(JSON.stringify(trace.json).includes('CANARY_SOURCE_TEXT_DO_NOT_LOG'), false);
    const report = JSON.parse(await readFile(candidate.json.reportPath, 'utf8'));
    assert.equal(JSON.stringify(report).includes('CANARY_SOURCE_TEXT_DO_NOT_LOG'), false);
    assert.ok(candidate.json.metrics.passed > baseline.json.metrics.passed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('hands work across3processes and reuses its verified effect without dispatching again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-handoff-test-'));
  try {
    const input = join(directory, 'input.json'), authority = join(directory, 'authority.json');
    await writeFile(input, JSON.stringify([{ id: 'one', text: 'VPN certificate expired.' }]));
    await writeFile(authority, JSON.stringify({ id: 'operator', version: '1', decision: 'allow', reason: 'Reviewed', expiresAt: Date.now() + 60000 }));
    const producer = invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'review']);
    assert.equal(producer.status, 0, producer.stderr);
    const receiver = invoke(['handoff-consume', '--state-dir', directory, '--id', 'review', '--authority-file', authority]);
    assert.equal(receiver.status, 0, receiver.stderr);
    assert.equal(receiver.json.status, 'verified');
    const repeated = invoke(['handoff-consume', '--state-dir', directory, '--id', 'review', '--authority-file', authority]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.json.receipt.resultHash, receiver.json.receipt.resultHash);
    const status = invoke(['handoff-status', '--state-dir', directory, '--id', 'review']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.json.status, 'verified');
    assert.equal(new Set([producer.json.pid, receiver.json.pid, status.json.pid]).size, 3);
    assert.equal((await readdir(join(directory, 'effects'))).length, 1);
    assert.equal(repeated.json.admittedLaunches, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects model evaluations without a launch budget before dispatch', () => {
  const result = invoke(['evaluate', '--state-dir', tmpdir(), '--model', 'gemini/fixture']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /budget|max-launches/i);
});

test('wrong receiver, expired approval and changed context dispatch no effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-handoff-denied-'));
  try {
    const input = join(directory, 'input.json'), authority = join(directory, 'authority.json');
    await writeFile(input, JSON.stringify([{ id: 'one', text: 'VPN access needs repair.' }]));
    const producer = invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'protected']);
    assert.equal(producer.status, 0, producer.stderr);
    await writeFile(authority, JSON.stringify({ id: 'operator', version: '1', decision: 'allow', reason: 'Expired', expiresAt: 1 }));
    const wrong = invoke(['handoff-consume', '--state-dir', directory, '--id', 'protected', '--authority-file', authority, '--target', 'wrong-receiver']);
    assert.notEqual(wrong.status, 0);
    const expired = invoke(['handoff-consume', '--state-dir', directory, '--id', 'protected', '--authority-file', authority]);
    assert.equal(expired.status, 0, expired.stderr);
    assert.notEqual(expired.json.status, 'verified');
    assert.equal(expired.json.admittedLaunches, 0);
    await writeFile(input, JSON.stringify([{ id: 'one', text: 'A completely different payroll request.' }]));
    const changed = invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'protected']);
    assert.notEqual(changed.status, 0);
    const status = invoke(['handoff-status', '--state-dir', directory, '--id', 'protected']);
    assert.equal(status.json.digest, producer.json.digest);
    await assert.rejects(readdir(join(directory, 'effects')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an installed native fixture records observed usage and safe events without claiming model quality', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-eval-native-fixture-'));
  try {
    const calls = join(directory, 'calls.jsonl');
    const fixture = new URL('./fixtures/fake-gemini.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [main.pathname, 'evaluate', '--state-dir', directory,
      '--model', 'gemini/gemini-2.5-flash', '--case-id', 'vpn', '--max-launches', '1'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, GEMINI_API_KEY: 'fixture-not-a-credential',
        OAR_GEMINI_COMMAND: process.execPath, OAR_GEMINI_ARGS_JSON: JSON.stringify([fixture]), OAR_FIXTURE_CALLS: calls },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout), report = JSON.parse(await readFile(value.reportPath, 'utf8'));
    assert.equal(value.evidence, 'transport-observation');
    assert.equal(value.executionIdentity.attestation, 'configuration-only');
    assert.equal(value.requestedModelTurns, 1);
    assert.equal(value.modelLaunches, null);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
    assert.equal(report.usage.inputTokens.known, 1);
    assert.equal(report.usage.inputTokens.total, 8);
    const trace = invoke(['trace-inspect', '--state-dir', directory, '--episode', value.episodeId]);
    assert.equal(trace.status, 0, trace.stderr);
    assert.ok(trace.json.entries.some(item => item.sessionId));
    assert.equal(JSON.stringify(trace.json).includes('Verify VPN access.'), false);
    assert.equal(JSON.stringify(trace.json).includes('fixture-not-a-credential'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('partial evaluations cannot be presented as complete app comparisons', async () => {
  const controller = new AbortController(); controller.abort();
  const report = await runEvaluation({ id: 'partial', signal: controller.signal,
    suite: { id: 'one', version: '1', cases: [{ id: 'one', input: null, expected: null }] },
    profile: { id: 'local', version: '1', sourceDigest: 'a'.repeat(64) },
    execute: () => { throw new Error('Pre-aborted work must not run'); },
    scorers: [{ id: 'check', version: '1', score: () => ({ value: 1, passed: true }) }],
  });
  assert.equal(report.metrics.total, 0);
  assert.throws(() => compareDocumentEvaluations(report, report), /complete evaluation/);
});
