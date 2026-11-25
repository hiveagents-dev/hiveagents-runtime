import { canonical, checksum } from '../../shared/json.js';
import { jsonClone } from '../workflow/checkpoint.js';
import type { Usage } from '../../public/types.js';
import type { JsonValue } from '../workflow/types.js';
import type { EvaluationProfile, EvaluationScore, EvaluationSuite, RunEvaluationOptions } from './types.js';

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function hash(value: unknown): string { return checksum(canonical(jsonClone(value))); }
export function snapshot<T>(value: T): T { return freeze(jsonClone(value)); }
export function object(value: unknown, keys: readonly string[], label = 'evaluation object'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`Invalid ${label}`);
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`Invalid ${label}`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value)) throw new Error('Invalid evaluation identifier');
}
export function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid evaluation digest');
}
export function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error('Invalid evaluation integer');
}
export function finite(value: unknown, minimum = 0, maximum = Number.MAX_VALUE): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error('Invalid evaluation number');
}
export function profile(value: unknown): EvaluationProfile {
  const item = object(snapshot(value), ['id', 'version', 'sourceDigest', 'provider', 'model', 'transport', 'optionsDigest'], 'evaluation profile');
  identifier(item.id); identifier(item.version); digest(item.sourceDigest);
  for (const key of ['provider', 'model', 'transport']) if (Object.hasOwn(item, key)) identifier(item[key]);
  if (Object.hasOwn(item, 'optionsDigest')) digest(item.optionsDigest);
  return snapshot(item) as unknown as EvaluationProfile;
}
export function suite(value: unknown): EvaluationSuite {
  const item = object(snapshot(value), ['id', 'version', 'cases'], 'evaluation suite');
  identifier(item.id); identifier(item.version);
  if (!Array.isArray(item.cases)) throw new Error('Invalid evaluation cases');
  integer(item.cases.length, 1, 1000);
  const ids = new Set<string>();
  for (const entry of item.cases) {
    const row = object(entry, ['id', 'input', 'expected'], 'evaluation case');
    identifier(row.id);
    if (ids.has(row.id) || !Object.hasOwn(row, 'input') || !Object.hasOwn(row, 'expected')) throw new Error('Invalid evaluation case');
    ids.add(row.id);
  }
  return snapshot(item) as unknown as EvaluationSuite;
}
export const usageKeys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens'] as const;
export const costMeanings: readonly Usage['costMeaning'][] = ['api-equivalent', 'estimate', 'provider-reported', 'unavailable'];
export function usage(value: unknown): Usage {
  const item = object(snapshot(value), [...usageKeys, 'reportedCostUsd', 'costMeaning', 'perModel'], 'evaluation usage');
  if (!costMeanings.includes(item.costMeaning as Usage['costMeaning'])) throw new Error('Invalid usage meaning');
  for (const key of usageKeys) if (Object.hasOwn(item, key)) integer(item[key], 0, Number.MAX_SAFE_INTEGER);
  if (Object.hasOwn(item, 'reportedCostUsd')) {
    finite(item.reportedCostUsd);
    if (item.costMeaning === 'unavailable') throw new Error('Unavailable cost cannot have a value');
  }
  // Validate the entire provider usage snapshot, but retain only aggregate scalar fields.
  if (Object.hasOwn(item, 'perModel')) {
    const models = item.perModel;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) throw new Error('Invalid per-model usage');
    const names = Object.keys(models); if (names.length > 1000) throw new Error('Too many usage models');
    for (const name of names) {
      identifier(name);
      const model = object((models as Record<string, unknown>)[name], [...usageKeys, 'reportedCostUsd'], 'model usage');
      for (const key of usageKeys) if (Object.hasOwn(model, key)) integer(model[key], 0, Number.MAX_SAFE_INTEGER);
      if (Object.hasOwn(model, 'reportedCostUsd')) finite(model.reportedCostUsd);
    }
  }
  const retained: Usage = { costMeaning: item.costMeaning as Usage['costMeaning'] };
  for (const key of usageKeys) if (Object.hasOwn(item, key)) retained[key] = item[key] as number;
  if (Object.hasOwn(item, 'reportedCostUsd')) retained.reportedCostUsd = item.reportedCostUsd as number;
  return freeze(retained);
}
export function score(value: unknown): EvaluationScore {
  const item = object(snapshot(value), ['value', 'passed', 'code'], 'evaluation score');
  finite(item.value, 0, 1);
  if (typeof item.passed !== 'boolean') throw new Error('Invalid evaluation score');
  if (Object.hasOwn(item, 'code') && typeof item.code !== 'string') throw new Error('Invalid evaluation score code');
  // Verifiers may return a bounded symbolic code, never free-form diagnostics.
  const code = item.code === undefined ? undefined : typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.code) ? item.code : 'SCORER_CODE_REDACTED';
  return { value: item.value, passed: item.passed, ...(code === undefined ? {} : { code }) };
}
export function capture(options: RunEvaluationOptions): RunEvaluationOptions & { repetitions: number; timeoutMs: number } {
  object(options, ['id', 'suite', 'profile', 'repetitions', 'timeoutMs', 'signal', 'budget', 'trace', 'execute', 'scorers'], 'evaluation options');
  identifier(options.id);
  const repetitions = options.repetitions === undefined ? 1 : options.repetitions;
  const timeoutMs = options.timeoutMs === undefined ? 60000 : options.timeoutMs;
  integer(repetitions, 1, 100); integer(timeoutMs, 1, 2 ** 31 - 1);
  const capturedSuite = suite(options.suite), capturedProfile = profile(options.profile);
  integer(capturedSuite.cases.length * repetitions, 1, 10000);
  if (typeof options.execute !== 'function' || !Array.isArray(options.scorers)) throw new Error('Missing evaluation callbacks');
  integer(options.scorers.length, 1, 100);
  if (Object.getOwnPropertySymbols(options.scorers).length || Object.keys(options.scorers).length !== options.scorers.length) throw new Error('Invalid evaluation scorer list');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options.scorers))) {
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= options.scorers.length
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid evaluation scorer list');
  }
  const ids = new Set<string>();
  const scorers = options.scorers.map(scorer => {
    object(scorer, ['id', 'version', 'score'], 'evaluation scorer'); identifier(scorer.id); identifier(scorer.version);
    if (ids.has(scorer.id) || typeof scorer.score !== 'function') throw new Error('Invalid evaluation scorer');
    ids.add(scorer.id); return Object.freeze({ id: scorer.id, version: scorer.version, score: scorer.score });
  });
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('Invalid evaluation signal');
  if (options.budget !== undefined && typeof options.budget.acquire !== 'function') throw new Error('Invalid evaluation budget');
  if (options.trace !== undefined && (typeof options.trace.append !== 'function'
    || (options.trace.observe !== undefined && typeof options.trace.observe !== 'function'))) throw new Error('Invalid evaluation trace');
  const budget = options.budget === undefined ? undefined : Object.freeze({ acquire: options.budget.acquire.bind(options.budget) });
  const trace = options.trace === undefined ? undefined : Object.freeze({ append: options.trace.append.bind(options.trace),
    ...(options.trace.observe === undefined ? {} : { observe: options.trace.observe.bind(options.trace) }) });
  return { ...options, suite: capturedSuite, profile: capturedProfile, repetitions, timeoutMs, scorers,
    ...(budget === undefined ? {} : { budget }), ...(trace === undefined ? {} : { trace }) };
}
export function output(value: unknown): { output: JsonValue; usage?: Usage } {
  const item = object(value, ['output', 'usage'], 'evaluation execution result');
  if (!Object.hasOwn(item, 'output')) throw new Error('Missing evaluation output');
  return { output: snapshot(item.output) as JsonValue, ...(Object.hasOwn(item, 'usage') ? { usage: usage(item.usage) } : {}) };
}
