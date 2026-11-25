import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostConcurrency, HostLaunchBudgetLimits, HostLedgerOptions } from './host-types.ts';
import { absolutePath, busyTimeout, closedRecord, identifier, integer, record } from './validation.ts';

export function validateConcurrency(value: unknown): asserts value is HostConcurrency {
  if (!record(value) || !((closedRecord(value, ['mode']) && value.mode === 'unlimited')
    || (closedRecord(value, ['mode', 'maxConcurrent']) && value.mode === 'limited' && integer(value.maxConcurrent)))) {
    throw new TypeError('Concurrency requires explicit limited integer or unlimited mode');
  }
}
export function hostLaunchLimits(concurrency: HostConcurrency): HostLaunchBudgetLimits {
  validateConcurrency(concurrency);
  return { concurrency: { ...concurrency }, maxLaunchesPerHour: 400, maxLaunchesPerDay: 800, quotaCooldownMs: 60_000 };
}
export const HOST_LAUNCH_LIMITS: HostLaunchBudgetLimits = Object.freeze({
  ...hostLaunchLimits({ mode: 'limited', maxConcurrent: 3 }), concurrency: Object.freeze({ mode: 'limited', maxConcurrent: 3 }),
});
export function hostLedgerPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.OAR_HOST_LEDGER !== undefined) { absolutePath(env.OAR_HOST_LEDGER); return env.OAR_HOST_LEDGER; }
  const home = env.HOME || homedir();
  const root = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
      : (env.XDG_STATE_HOME || join(home, '.local', 'state'));
  absolutePath(root);
  return join(root, 'open-agent-runtime', 'host', 'admission.sqlite');
}
export function validateHostOptions(options: HostLedgerOptions) {
  const keys = ['databasePath', 'concurrency', 'providers', 'busyTimeoutMs'];
  if (!closedRecord(options, keys, keys) || Object.values(options).some(value => value === undefined) || (Object.hasOwn(options, 'providers') && Object.hasOwn(options, 'concurrency'))) {
    throw new TypeError('Provide either explicit providers or concurrency shorthand');
  }
  busyTimeout(options.busyTimeoutMs);
  const databasePath = options.databasePath === undefined ? hostLedgerPath() : options.databasePath;
  absolutePath(databasePath);
  const concurrency = Object.hasOwn(options, 'concurrency') ? options.concurrency : HOST_LAUNCH_LIMITS.concurrency;
  validateConcurrency(concurrency);
  const providers = Object.hasOwn(options, 'providers') ? options.providers : { claude: hostLaunchLimits(concurrency), codex: hostLaunchLimits(concurrency) };
  if (!record(providers)) throw new TypeError('Explicit providers must be a plain JSON record');
  const policies = new Map<string, HostLaunchBudgetLimits>();
  const fields = ['concurrency', 'maxLaunchesPerHour', 'maxLaunchesPerDay', 'quotaCooldownMs'];
  for (const key of Reflect.ownKeys(providers)) {
    const desc = Object.getOwnPropertyDescriptor(providers, key), value: unknown = desc?.value;
    if (!identifier(key) || !desc?.enumerable || !Object.hasOwn(desc, 'value') || !closedRecord(value, fields)
      || !integer(value.maxLaunchesPerHour) || !integer(value.maxLaunchesPerDay) || !integer(value.quotaCooldownMs, 1)) throw new TypeError('Invalid host provider policy');
    validateConcurrency(value.concurrency);
    policies.set(key, { concurrency: { ...value.concurrency }, maxLaunchesPerHour: value.maxLaunchesPerHour, maxLaunchesPerDay: value.maxLaunchesPerDay, quotaCooldownMs: value.quotaCooldownMs });
  }
  return { databasePath, policies, busyTimeoutMs: options.busyTimeoutMs === undefined ? 1000 : Number(options.busyTimeoutMs) };
}
