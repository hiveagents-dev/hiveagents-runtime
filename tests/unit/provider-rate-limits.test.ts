import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProviderRateLimits, resolveProviderRateLimits, providerUsageRetryAt } from '../../src/adapters/provider-limits.js';
import { parseClaudeJsonl } from '../../src/adapters/claude/protocol.js';
import { parseCodexJsonl } from '../../src/adapters/codex/protocol.js';
import { ProtocolResultAccumulator } from '../../src/process/json-lines.js';

const NOW = Date.parse('2026-11-10T13:59:05.530Z');
const fixture = (provider: string, version: string) => readFileSync(new URL(
  `../fixtures/${provider}/rate-window-${version}.sanitized.jsonl`, import.meta.url), 'utf8');
const claude = JSON.parse(fixture('claude', '2.1.228'));
const codex = JSON.parse(fixture('codex', '0.153.4'));

describe('provider window observations (DATA, never quota/release authority)', () => {
  // A reset instant only counts while it is still ahead, so the clock stays at the moment the fixtures were captured.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  it('reads the real sanitized Claude warning, with no invented overage fields or retry', () => {
    const state = readProviderRateLimits('claude', claude, NOW)!;
    expect(state.status).toBe('allowed_warning');
    expect(state.windows).toEqual([{ name: 'seven_day', utilization: 0.96,
      reset: { value: 1794351600, unit: 'unverified' } }]);
    expect(providerUsageRetryAt(state)).toBeUndefined();
  });

  it('reads the real Codex window; normal token_count does not prove exhausted quota', () => {
    const state = readProviderRateLimits('codex', codex, NOW)!;
    expect(state.windows[0]).toMatchObject({ name: 'primary', usedPercent: 36, windowMinutes: 10080,
      reset: { value: 1794379738, unit: 'unverified' } });
    expect(state.observedAt.source).toBe('event-timestamp');
    expect(providerUsageRetryAt(state)).toBeUndefined();
    expect(providerUsageRetryAt(readProviderRateLimits('codex', { ...codex, payload: {
      ...codex.payload, rate_limits: { primary: { ...codex.payload.rate_limits.primary, used_percent: 100 } } } }, NOW))).toBeUndefined();
  });

  it('keeps independent primary/secondary windows and ignores credit/account/text fields', () => {
    const value = readProviderRateLimits('codex', { method: 'account/rateLimits/updated', params: {
      account: 'CANARY_SECRET', rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1794319800 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1794379738 }, credits: 'CANARY_SECRET' } } }, NOW)!;
    expect(value.windows.map(w => w.name)).toEqual(['primary', 'secondary']);
    expect(value.windows.map(w => w.reset?.value)).toEqual([1794319800, 1794379738]);
    expect(JSON.stringify(value)).not.toContain('CANARY');
    expect(providerUsageRetryAt(value)).toBeUndefined();
    expect(Object.isFrozen(value.windows[0])).toBe(true);
  });

  it('never executes getters/proxy traps or coerces malformed scalar fields', () => {
    let traps = 0;
    expect(readProviderRateLimits('claude', new Proxy({}, { get() { traps++; throw Error(); },
      ownKeys() { traps++; throw Error(); }, getOwnPropertyDescriptor() { traps++; throw Error(); } }), NOW)).toBeUndefined();
    const value = { type: 'rate_limit_event', get rate_limit_info() { traps++; throw Error(); } };
    expect(readProviderRateLimits('claude', value, NOW)).toBeUndefined();
    expect(traps).toBe(0);
    const malformed = readProviderRateLimits('claude', { type: 'rate_limit_event', rate_limit_info: {
      status: ['rejected'], rateLimitType: 'CANARY', resetsAt: '1794351600', utilization: -1 } }, NOW)!;
    expect(malformed.status).toBe('unrecognized');
    expect(malformed.windows).toEqual([{ name: 'unrecognized' }]);
  });

  it('unknown shapes and clock-incoherent fields have no usable time', () => {
    const state = readProviderRateLimits('claude', { ...claude, rate_limit_info: {
      ...claude.rate_limit_info, status: 'rejected' } }, NOW)!;
    expect(resolveProviderRateLimits({ ...state, source: 'unrecognized', windows: [{ name: 'seven_day', reset: { value: 0, unit: 'unix-seconds', atMs: NOW + 1000 } }] })).toBeUndefined();
    expect(providerUsageRetryAt({ ...state, windows: [{ name: 'unrecognized', reset: { value: 1794351600, unit: 'unix-seconds', atMs: NOW + 1000 } }] })).toBeUndefined();
    for (const resetsAt of [0, 1794351600000, Number.MAX_SAFE_INTEGER])
      expect(providerUsageRetryAt(readProviderRateLimits('claude', { ...claude,
        rate_limit_info: { ...claude.rate_limit_info, status: 'rejected', resetsAt } }, NOW))).toBeUndefined();
  });

  it.each(['claude', 'codex'] as const)('%s normal window is safe provider.event and never terminal failure', provider => {
    const raw = fixture(provider, provider === 'claude' ? '2.1.228' : '0.153.4');
    const terminal = provider === 'claude' ? { type: 'result', result: '', is_error: false, session_id: 'fixture' }
      : { type: 'turn.completed', usage: {} };
    const parsed = (provider === 'claude' ? parseClaudeJsonl : parseCodexJsonl)(raw + JSON.stringify(terminal));
    expect(parsed.completed).toBe(true);
    expect(parsed.failure).toBeUndefined();
    expect(parsed.events.find(e => e.type === 'provider.event')).toMatchObject({
      type: 'provider.event', provider, event: { type: 'rate-limit.observed' } });
  });

  it('incremental terminal parsing retains window metadata without reparsing the whole transcript', () => {
    const accumulator = new ProtocolResultAccumulator();
    const lines = [fixture('claude', '2.1.228').trim(), JSON.stringify({ type: 'result',
      result: 'Usage limit reached', is_error: true, session_id: 'fixture' })];
    for (const line of lines) accumulator.observe(line, parseClaudeJsonl(line));
    let verdictLines = 0;
    const result = accumulator.finish(raw => { verdictLines = raw.split('\n').length; return parseClaudeJsonl(raw); });
    expect(verdictLines).toBe(1);
    expect(result.failure?.kind).toBe('usage-limit');
    expect(result.events.find(e => e.type === 'provider.event')).toMatchObject({ event: { status: 'allowed_warning' } });
    expect(result.failure?.retryAt).toBeUndefined();
  });

  it('synthetic explicit rejections expose a usable millisecond instant, but warnings never do', () => {
    const rejected = { ...claude, rate_limit_info: { ...claude.rate_limit_info, status: 'rejected' } };
    const state = resolveProviderRateLimits(readProviderRateLimits('claude', rejected, NOW))!;
    expect(state.windows[0]?.reset).toEqual({ value: 1794351600, unit: 'unix-seconds', atMs: 1794351600000 });
    expect(providerUsageRetryAt(state)).toBe(1794351600000);
    const terminal = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'failed' });
    const raw = JSON.stringify(rejected) + '\n' + terminal;
    expect(parseClaudeJsonl(raw).failure).toMatchObject({ kind: 'usage-limit', retryAt: 1794351600000 });
    const acc = new ProtocolResultAccumulator();
    for (const line of raw.split('\n')) acc.observe(line, parseClaudeJsonl(line));
    expect(acc.finish(parseClaudeJsonl).failure).toMatchObject({ kind: 'usage-limit', retryAt: 1794351600000 });
  });

  it('synthetic credits-required and multiple blocking windows do not invent one reset time', () => {
    const rejected = { ...claude, rate_limit_info: { ...claude.rate_limit_info, status: 'rejected', errorCode: 'credits_required' } };
    expect(providerUsageRetryAt(readProviderRateLimits('claude', rejected, NOW))).toBeUndefined();
    const rows = ['seven_day', 'five_hour'].map(rateLimitType => JSON.stringify({ ...claude,
      rate_limit_info: { ...claude.rate_limit_info, status: 'rejected', rateLimitType } }));
    const result = parseClaudeJsonl(rows.join('\n') + '\n' + JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached' }));
    expect(result.failure?.retryAt).toBeUndefined();
  });

  it('synthetic Codex usage error is distinct from ordinary structured 429', () => {
    const quota = { type: 'error', error: { type: 'usage_limit_reached', resets_at: 1794379738 } };
    expect(parseCodexJsonl(JSON.stringify(quota)).failure).toMatchObject({ kind: 'usage-limit', retryAt: 1794379738000 });
    const throttle = { type: 'error', status_code: 429, message: 'Rate limit exceeded', error: { type: 'rate_limit_exceeded' } };
    expect(parseCodexJsonl(JSON.stringify(throttle)).failure?.kind).toBe('provider-unavailable');
    expect(parseCodexJsonl(JSON.stringify(throttle)).failure?.retryAt).toBeUndefined();
  });

  it('synthetic explicit long-window resets are not limited to eight days', () => {
    const resets_at = NOW / 1000 + 40 * 86_400;
    const state = readProviderRateLimits('codex', { type: 'error', error: {
      type: 'usage_limit_reached', resets_at: Math.floor(resets_at) } }, NOW);
    expect(providerUsageRetryAt(state)).toBe(Math.floor(resets_at) * 1000);
    const monthly = readProviderRateLimits('codex', { type: 'token_count', rate_limits: { primary: {
      window_minutes: 43_200, used_percent: 20, resets_at: Math.floor(NOW / 1000) + 20 * 86_400 } } }, NOW);
    expect(resolveProviderRateLimits(monthly)?.windows[0]?.reset?.atMs).toBeDefined();
    expect(providerUsageRetryAt(monthly)).toBeUndefined();
  });

  it('a historical rejection does not become a fresh retry time when replayed later', () => {
    const old = Date.parse('2020-01-01T00:00:00Z');
    const state = readProviderRateLimits('codex', { timestamp: '2020-01-01T00:00:00Z', type: 'error',
      error: { type: 'usage_limit_reached', resets_at: old / 1000 + 3600 } }, NOW);
    expect(resolveProviderRateLimits(state)?.windows[0]?.reset?.atMs).toBe(old + 3_600_000);
    expect(providerUsageRetryAt(state)).toBeUndefined();
  });
});
