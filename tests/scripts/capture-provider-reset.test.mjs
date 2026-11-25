import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { captureProviderReset } from '../../scripts/capture-provider-reset.mjs';

const options = { provider: 'claude', cliVersion: '2.1.228', transport: 'claude-stream-json',
  origin: 'synthetic-fixture', observedAt: '2026-11-10T12:00:00.000Z' };
const input = (...rows) => [Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')];
const secret = 'CANARY_ACCOUNT_PROMPT_KEY_SESSION';

test('Claude projects only structured finite fields; reset units remain unverified', async () => {
  const value = await captureProviderReset(input({ type: 'rate_limit_event', session_id: secret,
    prompt: secret, rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day',
      resetsAt: 1_794_405_600, utilization: 1, account: secret, errorCode: 'credits_required' } }), options);
  assert.equal(value.observations[0].classification, 'structured-window-state');
  assert.deepEqual(value.observations[0].windows[0].reset, { value: 1_794_405_600, unit: 'unverified' });
  assert.equal(value.observations[0].providerCode, 'credits_required');
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal('retryAt' in value, false);
});

test('Codex token_count projects two windows without account, tokens or plan metadata', async () => {
  const value = await captureProviderReset(input({ type: 'event_msg', timestamp: secret, payload: {
    type: 'token_count', info: { total_token_usage: secret }, rate_limits: { plan_type: secret,
      primary: { used_percent: 100, window_minutes: 300, resets_at: 1_794_405_600 },
      secondary: { used_percent: 65, window_minutes: 10_080, resets_at: 1_794_705_600 } } } }),
  { ...options, provider: 'codex', cliVersion: '0.153.4', transport: 'codex-session-observation' });
  assert.equal(value.observations[0].windows.length, 2);
  assert.equal(value.observations[0].windows[1].windowMinutes, 10_080);
  assert.equal(JSON.stringify(value).includes(secret), false);
});

test('Codex app-server notification is observation only, never denial or recovery proof', async () => {
  const value = await captureProviderReset(input({ method: 'account/rateLimits/updated', params: {
    accountId: secret, rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300,
      resetsAt: 1_794_405_600 }, credits: { balance: secret } } } }),
  { ...options, provider: 'codex', transport: 'codex-app-server' });
  assert.equal(value.observations[0].classification, 'structured-window-state');
  assert.equal(value.observations[0].windows[0].usedPercent, 99);
  assert.equal(JSON.stringify(value).includes(secret), false);
});

test('ordinary 429 and overload remain distinct from structured usage quota', async () => {
  const value = await captureProviderReset(input(
    { type: 'error', status_code: 429, message: secret, error: { code: 'rate_limit_exceeded', retry_after: 30 } },
    { type: 'error', status_code: 529, error: { code: 'overloaded_error' } },
    { type: 'error', error: { code: 'usage_limit_reached', resets_at: 1_794_405_600, account: secret } }),
  { ...options, provider: 'codex', transport: 'codex-exec-json' });
  assert.deepEqual(value.observations.map(item => item.classification),
    ['http-rate-limit', 'provider-overload', 'structured-usage-limit']);
  assert.equal(value.observations[0].retryAfterSeconds, 30);
  assert.equal(JSON.stringify(value).includes(secret), false);
});

test('legacy usage-limit fixtures demonstrate no structured reset and no leaked prose', async () => {
  for (const [provider, version] of [['claude', '2.1.251'], ['codex', '0.149.0']]) {
    const raw = await readFile(new URL(`../fixtures/${provider}/usage-limit-${version}.jsonl`, import.meta.url));
    const result = await captureProviderReset([raw], { ...options, provider, cliVersion: version,
      transport: provider === 'claude' ? 'claude-stream-json' : 'codex-exec-json' });
    assert.equal(result.observations.length, 0);
    assert.match(result.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(result.source.bytes, raw.length);
  }
});

test('unknown types, string timestamps and non-finite field shapes are not projected', async () => {
  const result = await captureProviderReset(input({ type: 'rate_limit_event', rate_limit_info: {
    status: secret, rateLimitType: secret, resetsAt: secret, utilization: [100] } },
  { type: secret, rate_limit_info: { resetsAt: 123 } }), options);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.observations[0].windows[0].reset, undefined);
  assert.equal(result.observations[0].status, 'unrecognized');
});

test('UTF-8 split across chunks and CRLF are accepted; final complete frame needs no newline', async () => {
  const raw = Buffer.from(JSON.stringify({ ignored: 'ñ', type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: 1_794_405_600 } }) + '\r\n{}');
  const result = await captureProviderReset(Array.from(raw, byte => Buffer.from([byte])), options);
  assert.equal(result.source.frames, 2);
  assert.equal(result.observations.length, 1);
});

test('duplicate keys, truncation, invalid UTF-8 and nesting fail without exposing input', async () => {
  for (const raw of ['{"type":"error","type":"rate_limit_event"}', '{"prompt":"' + secret,
    '['.repeat(18) + 'null' + ']'.repeat(18), Buffer.from([0xff, 0x0a])]) {
    await assert.rejects(captureProviderReset([Buffer.from(raw)], options), error => {
      assert.equal(error.message, 'Capture refused: invalid JSONL'); return true;
    });
  }
});

test('frame, total-input, record and evidence limits are hard bounded', async () => {
  await assert.rejects(captureProviderReset([Buffer.alloc(1_048_577, 0x20)], options), /frame limit/);
  await assert.rejects(captureProviderReset([Buffer.alloc(16_777_217)], options), /input limit/);
  await assert.rejects(captureProviderReset([Buffer.from('{}\n'.repeat(100_001))], options), /record limit/);
  const row = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } };
  await assert.rejects(captureProviderReset(input(...Array(65).fill(row)), options), /observation limit/);
});

test('CLI requires explicit opt-in, emits fixed errors only and never spawns a provider', () => {
  const script = new URL('../../scripts/capture-provider-reset.mjs', import.meta.url);
  const args = ['--provider', 'claude', '--cli-version', '2.1.228', '--transport', 'claude-stream-json',
    '--origin', 'synthetic-fixture'];
  const denied = spawnSync(process.execPath, [script.pathname, ...args], { input: secret, encoding: 'utf8' });
  assert.notEqual(denied.status, 0); assert.equal(denied.stdout, '');
  assert.equal(denied.stderr.includes(secret), false);
  const accepted = spawnSync(process.execPath, [script.pathname, '--opt-in', ...args],
    { input: '{}\n', encoding: 'utf8' });
  assert.equal(accepted.status, 0); assert.equal(JSON.parse(accepted.stdout).source.frames, 1);
});
