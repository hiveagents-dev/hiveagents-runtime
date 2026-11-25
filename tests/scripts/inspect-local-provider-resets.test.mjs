import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { inspectResetFiles } from '../../scripts/inspect-local-provider-resets.mjs';

test('existing structured metadata binds prerelease version without identifiers or text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oar-reset-read-'));
  try {
    const path = join(dir, 'owned.jsonl'), canary = 'CANARY_SECRET_SESSION_ACCOUNT';
    await writeFile(path, [
      { type: 'session_meta', payload: { cli_version: '0.153.4-alpha.2', id: canary, instructions: canary } },
      { type: 'response_item', payload: { text: canary } },
      { timestamp: '2026-11-10T00:00:00Z', type: 'event_msg', payload: { type: 'token_count',
        rate_limits: { primary: { used_percent: 40, window_minutes: 10080, resets_at: 1794379738 } } } },
    ].map(JSON.stringify).join('\n'));
    const result = await inspectResetFiles('codex', [{ path, mtime: 1 }]);
    assert.equal(result.inventory.relevant, 1);
    assert.equal(result.samples[0].cliVersion, '0.153.4-alpha.2');
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal(JSON.stringify(result).includes(path), false);
    assert.equal(result.groups[0].maxUsedPercent, 40);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('symlink and malformed relevant input do not expose raw data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oar-reset-read-'));
  try {
    const path = join(dir, 'owned.jsonl'), link = join(dir, 'link.jsonl');
    await writeFile(path, '{"type":"rate_limit_event","rate_limit_info":{"secret":"CANARY');
    await symlink(path, link);
    const result = await inspectResetFiles('claude', [{ path: link, mtime: 1 }, { path, mtime: 0 }]);
    assert.equal(result.inventory.unavailable, 1);
    assert.equal(result.inventory.invalidRelevantFrames, 1);
    assert.equal(result.samples.length, 0);
    assert.equal(JSON.stringify(result).includes('CANARY'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('distinct metadata cannot grow the aggregation map beyond its hard cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oar-reset-read-'));
  try {
    const path = join(dir, 'owned.jsonl'), rows = [];
    for (let i = 0; i < 65; i++) rows.push(
      { type: 'session_meta', payload: { cli_version: `0.1.${i}` } },
      { type: 'event_msg', payload: { type: 'token_count', rate_limits: {
        primary: { used_percent: 50, window_minutes: 300, resets_at: 1794379738 } } } });
    await writeFile(path, rows.map(JSON.stringify).join('\n'));
    const result = await inspectResetFiles('codex', [{ path, mtime: 1 }]);
    assert.equal(result.groups.length, 64);
    assert.equal(result.inventory.groupOverflow, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
