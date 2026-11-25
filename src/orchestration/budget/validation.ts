import { isAbsolute, normalize } from 'node:path';
import type { SharedLaunchBudgetOptions } from './types.ts';

export function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
}
export function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
/** Closed, own data properties; getters and symbols are not JSON configuration. */
export function closedRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return record(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
    && keys.every(key => optional.includes(key) || Object.hasOwn(value, key));
}
export function absolutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new TypeError('An absolute normalized local database path is required');
  }
}
export function busyTimeout(value: unknown): void {
  if (value !== undefined && (!integer(value) || value > 60_000)) throw new TypeError('busyTimeoutMs must be an integer from 0 to 60000');
}
export function validateFiniteOptions(options: SharedLaunchBudgetOptions): void {
  if (!closedRecord(options, ['databasePath', 'providers', 'busyTimeoutMs'], ['busyTimeoutMs']) || !record(options.providers)) {
    throw new TypeError('An absolute database path and explicit provider limits are required');
  }
  absolutePath(options.databasePath); busyTimeout(options.busyTimeoutMs);
  const keys = ['maxConcurrent', 'maxLaunchesPerHour', 'maxLaunchesPerDay', 'quotaCooldownMs'];
  for (const key of Reflect.ownKeys(options.providers)) {
    const desc = Object.getOwnPropertyDescriptor(options.providers, key);
    const limits: unknown = desc?.value;
    if (!identifier(key) || !desc?.enumerable || !Object.hasOwn(desc, 'value') || !closedRecord(limits, keys)
      || !keys.every(k => integer(limits[k], k === 'quotaCooldownMs' ? 1 : 0))) {
      throw new TypeError('Invalid explicit launch limits');
    }
  }
}
