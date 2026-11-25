import { describe, expect, it } from 'vitest';
import { AgentRuntimeError, UsageLimitError, observedUsageLimitReset } from '../../src/public/errors.js';

const NOW = Date.parse('2026-11-10T00:00:00Z'), RESET = NOW + 30 * 86_400_000;
const limited = () => new UsageLimitError({ provider: 'claude', retryable: false,
  failure: { kind: 'usage-limit', retryAt: RESET } });

describe('observedUsageLimitReset (nominal error DATA only)', () => {
  it('reads one canonical nested field, exact provider and future representable time', () => {
    expect(observedUsageLimitReset(limited(), 'claude', NOW)).toBe(RESET);
    expect(observedUsageLimitReset(limited(), 'codex', NOW)).toBeUndefined();
    expect(observedUsageLimitReset(limited(), 'Claude', NOW)).toBeUndefined();
    expect(observedUsageLimitReset(limited(), 'claude', RESET)).toBeUndefined();
  });

  it('refuses nonnominal errors, copies, wrapped causes and aliases', () => {
    expect(observedUsageLimitReset(new AgentRuntimeError('USAGE_LIMIT', 'same code', {
      provider: 'claude', retryable: false, failure: { kind: 'usage-limit', retryAt: RESET } }), 'claude', NOW)).toBeUndefined();
    expect(observedUsageLimitReset({ ...limited() }, 'claude', NOW)).toBeUndefined();
    expect(observedUsageLimitReset(new Error('wrapped', { cause: limited() }), 'claude', NOW)).toBeUndefined();
    const alias = limited(); Object.defineProperty(alias, 'context', { value: {
      provider: 'claude', retryable: false, retryAt: RESET, failure: { kind: 'usage-limit' } } });
    expect(observedUsageLimitReset(alias, 'claude', NOW)).toBeUndefined();
    const changed = limited(); Object.defineProperty(changed, 'code', { value: 'PROVIDER_UNAVAILABLE' });
    expect(observedUsageLimitReset(changed, 'claude', NOW)).toBeUndefined();
  });

  it('rejects proxies/getters at every inspected boundary without executing traps', () => {
    let traps = 0;
    const proxy = (v: object) => new Proxy(v, { get() { traps++; throw Error('CANARY'); },
      getPrototypeOf() { traps++; throw Error('CANARY'); }, ownKeys() { traps++; throw Error('CANARY'); },
      getOwnPropertyDescriptor() { traps++; throw Error('CANARY'); } });
    expect(observedUsageLimitReset(proxy(limited()), 'claude', NOW)).toBeUndefined();
    for (const context of [proxy({}), { get provider() { traps++; return 'claude'; } },
      { provider: 'claude', retryable: false, failure: proxy({}) },
      { provider: 'claude', retryable: false, failure: { kind: 'usage-limit', get retryAt() { traps++; return RESET; } } }]) {
      const error = limited(); Object.defineProperty(error, 'context', { value: context });
      expect(observedUsageLimitReset(error, 'claude', NOW)).toBeUndefined();
    }
    const hidden = new Error('nominal-looking'); Object.setPrototypeOf(hidden, proxy(UsageLimitError.prototype));
    expect(observedUsageLimitReset(hidden, 'claude', NOW)).toBeUndefined();
    expect(traps).toBe(0);
  });

  it('refuses invalid/extra failure fields, NaN, strings, past and unrepresentable dates', () => {
    for (const failure of [{ kind: 'protocol', retryAt: RESET }, { kind: 'usage-limit', retryAt: '123' },
      { kind: 'usage-limit', retryAt: NaN }, { kind: 'usage-limit', retryAt: NOW - 1 },
      { kind: 'usage-limit', retryAt: Number.MAX_SAFE_INTEGER }, { kind: 'usage-limit', retryAt: RESET, prose: 'CANARY' }]) {
      const error = limited(); Object.defineProperty(error, 'context', { value: { provider: 'claude', retryable: false, failure } });
      expect(observedUsageLimitReset(error, 'claude', NOW)).toBeUndefined();
    }
    expect(observedUsageLimitReset(limited(), 'claude', NaN)).toBeUndefined();
  });
});
