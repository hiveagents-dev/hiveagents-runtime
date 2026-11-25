import { types } from 'node:util';
import type { AgentEvent } from '../public/types.js';

type Provider = 'claude' | 'codex';
type WindowName = 'primary' | 'secondary' | 'error' | 'five_hour' | 'seven_day' | 'seven_day_opus'
  | 'seven_day_sonnet' | 'seven_day_oauth_apps' | 'seven_day_overage_included' | 'overage' | 'unrecognized';
export interface ProviderRateLimitWindow {
  readonly name: WindowName;
  readonly usedPercent?: number;
  readonly utilization?: number;
  readonly windowMinutes?: number;
  readonly reset?: Readonly<{ value: number; unit: 'unverified' | 'unix-seconds'; atMs?: number }>;
}
export interface ProviderRateLimitObservation {
  readonly type: 'rate-limit.observed';
  readonly provider: Provider;
  readonly source: 'claude-rate-limit-event' | 'codex-token-count' | 'codex-account-rate-limits' | 'codex-usage-error';
  readonly status?: 'allowed' | 'allowed_warning' | 'rejected' | 'unrecognized';
  readonly code?: 'credits_required';
  readonly observedAt: Readonly<{ value: number; source: 'event-timestamp' | 'sdk-receive-clock' }>;
  readonly windows: readonly ProviderRateLimitWindow[];
}
const names: readonly string[] = ['primary', 'secondary', 'error', 'five_hour', 'seven_day', 'seven_day_opus',
  'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_overage_included', 'overage', 'unrecognized'];
const statuses = ['allowed', 'allowed_warning', 'rejected'];
const sources = ['claude-rate-limit-event', 'codex-token-count', 'codex-account-rate-limits', 'codex-usage-error'];
const object = (v: unknown): v is object => v !== null && typeof v === 'object' && !types.isProxy(v) && !Array.isArray(v);
function own(v: unknown, key: string): unknown {
  if (!object(v)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(v, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const ratio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000;
const name = (v: unknown): WindowName => typeof v === 'string' && names.includes(v) ? v as WindowName : 'unrecognized';
const status = (v: unknown) => typeof v === 'string' && statuses.includes(v)
  ? v as 'allowed' | 'allowed_warning' | 'rejected' : 'unrecognized' as const;

function window(raw: unknown, label: WindowName, camel = false): ProviderRateLimitWindow | undefined {
  if (!object(raw)) return undefined;
  const used = own(raw, camel ? 'usedPercent' : 'used_percent');
  const minutes = own(raw, camel ? 'windowDurationMins' : 'window_minutes');
  const reset = own(raw, camel ? 'resetsAt' : 'resets_at');
  return Object.freeze({ name: label, ...(ratio(used) ? { usedPercent: used } : {}),
    ...(integer(minutes) && minutes <= 525_600 ? { windowMinutes: minutes } : {}),
    ...(integer(reset) ? { reset: Object.freeze({ value: reset, unit: 'unverified' as const }) } : {}) });
}

/** Closed metadata only. Does not imply exhaustion, restored access or permission to retry. */
export function readProviderRateLimits(provider: Provider, raw: unknown, receivedAt = Date.now()): ProviderRateLimitObservation | undefined {
  if (!integer(receivedAt)) return undefined;
  const timestamp = own(raw, 'timestamp');
  const eventAt = typeof timestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(timestamp)
    ? Date.parse(timestamp) : NaN;
  const observedAt = Object.freeze({ value: Number.isFinite(eventAt) ? eventAt : receivedAt,
    source: Number.isFinite(eventAt) ? 'event-timestamp' as const : 'sdk-receive-clock' as const });
  const info = own(raw, 'rate_limit_info');
  if (provider === 'claude' && own(raw, 'type') === 'rate_limit_event' && object(info)) {
    const reset = own(info, 'resetsAt'), utilization = own(info, 'utilization');
    return Object.freeze({ type: 'rate-limit.observed', provider, source: 'claude-rate-limit-event',
      status: status(own(info, 'status')), observedAt, windows: Object.freeze([Object.freeze({
        name: name(own(info, 'rateLimitType')), ...(ratio(utilization) ? { utilization } : {}),
        ...(integer(reset) ? { reset: Object.freeze({ value: reset, unit: 'unverified' as const }) } : {}) })]),
      ...(own(info, 'errorCode') === 'credits_required' ? { code: 'credits_required' as const } : {}) });
  }
  if (provider !== 'codex') return undefined;
  const payload = own(raw, 'payload'), type = own(raw, 'type');
  let limits: unknown, source: ProviderRateLimitObservation['source'] = 'codex-token-count', camel = false;
  if (type === 'event_msg' && own(payload, 'type') === 'token_count') limits = own(payload, 'rate_limits');
  else if (type === 'token_count') limits = own(raw, 'rate_limits');
  else if (own(raw, 'method') === 'account/rateLimits/updated') {
    limits = own(own(raw, 'params'), 'rateLimits'); camel = true; source = 'codex-account-rate-limits';
  }
  if (object(limits)) return Object.freeze({ type: 'rate-limit.observed', provider, source, observedAt,
    windows: Object.freeze((['primary', 'secondary'] as const).flatMap(label => {
      const item = window(own(limits, label), label, camel); return item ? [item] : [];
    })) });
  const error = type === 'error' ? own(raw, 'error') : own(payload, 'type') === 'error' ? own(payload, 'error') : undefined;
  if (own(error, 'type') !== 'usage_limit_reached' && own(error, 'code') !== 'usage_limit_reached') return undefined;
  const item = window(error, 'error');
  return Object.freeze({ type: 'rate-limit.observed', provider, source: 'codex-usage-error',
    status: 'rejected', observedAt, windows: Object.freeze(item ? [item] : []) });
}

/** Revalidates a normalized event without invoking getters or trusting a copied prototype. */
export function captureProviderRateLimits(value: unknown): ProviderRateLimitObservation | undefined {
  const provider = own(value, 'provider'), source = own(value, 'source'), rawWindows = own(value, 'windows'),
    rawClock = own(value, 'observedAt'), clock = own(rawClock, 'value'), clockSource = own(rawClock, 'source');
  if (own(value, 'type') !== 'rate-limit.observed' || !['claude', 'codex'].includes(provider as string)
    || !sources.includes(source as string) || !integer(clock)
    || !['event-timestamp', 'sdk-receive-clock'].includes(clockSource as string)
    || !Array.isArray(rawWindows) || types.isProxy(rawWindows) || rawWindows.length > 2) return undefined;
  const windows: ProviderRateLimitWindow[] = [];
  for (let i = 0; i < rawWindows.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(rawWindows, String(i));
    if (!descriptor || !('value' in descriptor) || !object(descriptor.value)) return undefined;
    const raw = descriptor.value, reset = own(own(raw, 'reset'), 'value'), used = own(raw, 'usedPercent'),
      utilization = own(raw, 'utilization'), minutes = own(raw, 'windowMinutes');
    windows.push(Object.freeze({ name: name(own(raw, 'name')), ...(ratio(used) ? { usedPercent: used } : {}),
      ...(ratio(utilization) ? { utilization } : {}), ...(integer(minutes) && minutes <= 525_600 ? { windowMinutes: minutes } : {}),
      ...(integer(reset) ? { reset: Object.freeze({ value: reset, unit: 'unverified' as const }) } : {}) }));
  }
  if (new Set(windows.map(w => w.name)).size !== windows.length) return undefined;
  if ((provider === 'claude') !== (source === 'claude-rate-limit-event')) return undefined;
  return Object.freeze({ type: 'rate-limit.observed', provider: provider as Provider,
    source: source as ProviderRateLimitObservation['source'], observedAt: Object.freeze({ value: clock,
      source: clockSource as ProviderRateLimitObservation['observedAt']['source'] }), windows: Object.freeze(windows),
    ...(own(value, 'status') === undefined ? {} : { status: status(own(value, 'status')) }),
    ...(own(value, 'code') === 'credits_required' ? { code: 'credits_required' as const } : {}) });
}

/** Known protocol fields use Unix seconds; values incoherent with their observation stay raw.
 * Sources and the corroborating versioned local captures are listed in the reset study.
 * This is a structural protocol contract, not an installed-version gate. */
export function resolveProviderRateLimits(input: unknown): ProviderRateLimitObservation | undefined {
  const value = captureProviderRateLimits(input); if (!value) return undefined;
  return Object.freeze({ ...value, windows: Object.freeze(value.windows.map(w => {
    if (!w.reset) return w;
    const atMs = w.reset.value * 1000, elapsed = atMs - value.observedAt.value;
    const minutes = w.windowMinutes && w.windowMinutes > 0 ? w.windowMinutes
      : w.name === 'five_hour' ? 300 : w.name.startsWith('seven_day') ? 10_080 : undefined;
    if (!Number.isSafeInteger(atMs) || !Number.isFinite(new Date(atMs).getTime()) || elapsed <= 0
      || (minutes !== undefined && elapsed > minutes * 60_000)) return w;
    return Object.freeze({ ...w, reset: Object.freeze({ value: w.reset.value, unit: 'unix-seconds' as const, atMs }) });
  })) });
}

/** Only a named Claude rejection or explicit Codex usage error supplies a retry time.
 * Ordinary 429s, token counters, warnings, unknown windows and credits-required do not. */
export function providerUsageRetryAt(input: unknown): number | undefined {
  const value = resolveProviderRateLimits(input);
  if (!value || value.status !== 'rejected' || value.code === 'credits_required' || value.windows.length !== 1) return undefined;
  const w = value.windows[0]!;
  if (value.source === 'claude-rate-limit-event' && !['five_hour', 'seven_day', 'seven_day_opus',
    'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_overage_included'].includes(w.name)) return undefined;
  if (value.source !== 'claude-rate-limit-event' && value.source !== 'codex-usage-error') return undefined;
  const at = w.reset?.atMs;
  return at !== undefined && at > Date.now() ? at : undefined;
}

/** Finite per-window state; two different blocking windows never become one guessed reset. */
export function confirmedUsageRetryAt(events: readonly AgentEvent[]): number | undefined {
  const latest = new Map<string, ProviderRateLimitObservation>();
  for (const event of events) if (event.type === 'provider.event') {
    const value = captureProviderRateLimits(event.event);
    if (value && value.provider === event.provider) for (const w of value.windows)
      latest.set(`${value.provider}:${value.source}:${w.name}`, value);
  }
  const candidates = [...latest.values()].filter(v => v.status === 'rejected');
  if (candidates.length !== 1) return undefined;
  return providerUsageRetryAt(candidates[0]);
}
