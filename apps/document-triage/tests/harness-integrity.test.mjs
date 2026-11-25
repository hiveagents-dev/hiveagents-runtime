import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FileWorkflowStore, WorkflowDecisionStore, WorkflowTraceStore, readTraceEpisode, openTraceEpisode, decisionHash } from 'hiveagents-runtime/orchestration';

const main = new URL('../dist/main.js', import.meta.url);
const digest = text => createHash('sha256').update(text).digest('hex');
function invoke(args) { const child = spawnSync(process.execPath, [main.pathname, ...args], { encoding: 'utf8', timeout: 30000 }); return { ...child, json: child.status === 0 ? JSON.parse(child.stdout) : undefined }; }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'oar-handoff-integrity-')), input = join(directory, 'input.json'), authority = join(directory, 'authority.json');
  await writeFile(input, JSON.stringify([{ id: 'one', text: 'VPN certificate expired.' }]));
  await writeFile(authority, JSON.stringify({ id: 'operator', version: '1', decision: 'allow', reason: 'Reviewed', expiresAt: Date.now() + 60000 }));
  return { directory, input, authority };
}

test('retries completed handoff production after lost stdout without changing durable bytes', async () => {
  const { directory, input } = await setup();
  try {
    const args = ['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'repeat'];
    const first = invoke(args); assert.equal(first.status, 0, first.stderr);
    const before = {};
    for (const area of ['handoffs', 'traces']) for (const file of await readdir(join(directory, area))) before[`${area}/${file}`] = digest(await readFile(join(directory, area, file)));
    const retry = invoke(args); assert.equal(retry.status, 0, retry.stderr);
    assert.equal(retry.json.digest, first.json.digest); assert.equal(retry.json.sourceDigest, first.json.sourceDigest);
    for (const [file, hash] of Object.entries(before)) assert.equal(digest(await readFile(join(directory, file))), hash);
    const changed = invoke([...args, '--target', 'different']); assert.notEqual(changed.status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovers a committed bundle whose producer trace is still running', async () => {
  const { directory, input } = await setup();
  try {
    const args = ['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'recover'];
    const first = invoke(args); assert.equal(first.status, 0, first.stderr);
    const traceStore = new WorkflowTraceStore(new FileWorkflowStore(join(directory, 'traces')));
    const completed = await readTraceEpisode(traceStore, first.json.episodeId);
    // Recreate the exact pre-finish trace state; bundle bytes remain committed.
    await rm(join(directory, 'traces', `${digest(`trace:${first.json.episodeId}`)}.json`));
    const trace = await openTraceEpisode(traceStore, completed.identity);
    await trace.append({ type: 'handoff.prepared', count: 1 }); await trace.close();
    const retry = invoke(args); assert.equal(retry.status, 0, retry.stderr); assert.equal(retry.json.digest, first.json.digest);
    const reconciled = await readTraceEpisode(traceStore, first.json.episodeId);
    assert.equal(reconciled.status, 'completed'); assert.equal(reconciled.entries.filter(entry => entry.type === 'handoff.prepared').length, 1);
    assert.equal(reconciled.entries.filter(entry => entry.type === 'handoff.created').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('status rejects a checksummed malformed verified record just as consumption does', async () => {
  const { directory, input, authority } = await setup();
  try {
    assert.equal(invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'corrupt']).status, 0);
    const store = new WorkflowDecisionStore(new FileWorkflowStore(join(directory, 'decisions'))), lease = await store.acquire('handoff-review:corrupt');
    await lease.save({ status: 'verified' }); await lease.release();
    const status = invoke(['handoff-status', '--state-dir', directory, '--id', 'corrupt']); assert.notEqual(status.status, 0);
    const consume = invoke(['handoff-consume', '--state-dir', directory, '--id', 'corrupt', '--authority-file', authority]); assert.notEqual(consume.status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('status binds even a self-consistent verified decision to the loaded bundle', async () => {
  const { directory, input, authority } = await setup();
  try {
    assert.equal(invoke(['handoff-produce', '--input', input, '--state-dir', directory, '--id', 'mismatch']).status, 0);
    const args = ['handoff-consume', '--state-dir', directory, '--id', 'mismatch', '--authority-file', authority];
    assert.equal(invoke(args).json.status, 'verified');
    const store = new WorkflowDecisionStore(new FileWorkflowStore(join(directory, 'decisions'))), lease = await store.acquire('handoff-review:mismatch');
    const record = await lease.load(); record.binding.input.target.id = 'someone-else'; record.binding.inputHash = decisionHash(record.binding.input); record.receipt.inputHash = record.binding.inputHash;
    await lease.save(record); await lease.release();
    const status = invoke(['handoff-status', '--state-dir', directory, '--id', 'mismatch']); assert.notEqual(status.status, 0);
    const consume = invoke(args); assert.equal(consume.status, 0, consume.stderr); assert.equal(consume.json.status, 'needs-owner');
    assert.equal((await readdir(join(directory, 'effects'))).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
