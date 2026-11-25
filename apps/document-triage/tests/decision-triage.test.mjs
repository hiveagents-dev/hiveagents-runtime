import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from 'hiveagents-runtime';
import { runDecisionGatedTriage, validateTriageAuthority } from '../dist/decision-triage.js';

const documents = [{ id: 'one', text: 'VPN acceso remoto' }, { id: 'two', text: 'backup restauración' }];
test('operator authority JSON is validated at the application boundary', () => {
  const valid = { id: 'local-operator', version: '1', decision: 'allow', reason: 'Reviewed', expiresAt: 200 };
  assert.deepEqual(validateTriageAuthority(valid), valid);
  for (const value of [null, [], { ...valid, decision: 'approved' }, { ...valid, expiresAt: 'tomorrow' }, { ...valid, version: '' }, { ...valid, nextAt: -1 }]) {
    assert.throws(() => validateTriageAuthority(value), /authority/i);
  }
});
async function sandbox(run) {
  const directory = await mkdtemp(join(tmpdir(), 'triage-decision-'));
  try { await run({ runtime: new Runtime(), documents, cwd: directory, stateDirectory: join(directory, 'state') }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a durable owner wait resumes with fresh approval and verifies the exact stored report', async () => {
  await sandbox(async options => {
    let decision = 'wait', checks = 0;
    const authority = () => { checks++; return { id: 'local-operator', version: '1', decision, reason: 'Review documents', expiresAt: Date.now() + 60_000 }; };
    const waiting = await runDecisionGatedTriage({ ...options, authority });
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.attempts, 0);
    decision = 'allow';
    const resumed = await runDecisionGatedTriage({ ...options, authority });
    assert.equal(resumed.status, 'verified'); assert.equal(resumed.result.status, 'completed');
    assert.equal(resumed.receipt.inputHash, waiting.binding.inputHash);
    assert.equal(resumed.receipt.authorityVersion, '1'); assert.equal(resumed.receipt.evidence.length, 1);
    const cached = await runDecisionGatedTriage({ ...options, authority });
    assert.deepEqual(cached, resumed); assert.ok(checks >= 4, 'the service rechecks current authority at dispatch');
  });
});

test('expired or rejected decisions consume no workflow launches', async () => {
  await sandbox(async options => {
    const authority = () => ({ id: 'local-operator', version: '1', decision: 'allow', reason: 'Expired review', expiresAt: 1 });
    const expired = await runDecisionGatedTriage({ ...options, authority });
    assert.equal(expired.status, 'waiting'); assert.equal(expired.attempts, 0);
    const rejected = await runDecisionGatedTriage({ ...options, authority: () => ({ ...authority(), decision: 'deny', reason: 'Rejected', expiresAt: Date.now() + 1000 }) });
    assert.equal(rejected.status, 'denied'); assert.equal(rejected.attempts, 0);
  });
});

test('a changed authority epoch blocks a pending decision for owner reconciliation', async () => {
  await sandbox(async options => {
    const authority = () => ({ id: 'local-operator', version: '1', decision: 'wait', reason: 'Review', expiresAt: Date.now() + 60_000 });
    await runDecisionGatedTriage({ ...options, authority });
    const result = await runDecisionGatedTriage({ ...options, authority: () => ({ ...authority(), version: '2', decision: 'allow' }) });
    assert.equal(result.status, 'needs-owner'); assert.equal(result.attempts, 0);
  });
});

test('a failed durable intent write prevents the document workflow from starting', async () => {
  await sandbox(async options => {
    const store = { async acquire() { return { async load() {}, async save() { throw new Error('store offline'); }, async release() {} }; } };
    const authority = () => ({ id: 'local-operator', version: '1', decision: 'allow', reason: 'Approved', expiresAt: Date.now() + 60_000 });
    await assert.rejects(runDecisionGatedTriage({ ...options, authority, decisionStore: store }), /store offline/);
  });
});
