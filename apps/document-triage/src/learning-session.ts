import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SharedLaunchBudget, type ObservedTaskBudget } from 'hiveagents-runtime/orchestration';
import { LearningRouter, SqliteLearningStore, learningDomainDigest, learningDigest,
  type LearningDefinition, type LearningPolicyConfig, type LearningDomain } from 'hiveagents-runtime/routing/learning';
import type { LearningContext, LearningPointer } from 'hiveagents-runtime/routing/learning';
import { harnessIdentity, stateDirectory } from './harness-common.js';

export interface LearningAppOptions {
  definition: unknown; stateDirectory: string; timeoutMs?: number; cwd?: string;
  objective?: LearningPolicyConfig['objective']; maxLaunches?: number; totalLaunches?: number; signal?: AbortSignal;
  suite?: 'mixed'|'document';
}
export function captureLearningDefinition(value: unknown): LearningDefinition {
  learningDigest(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Agent definition must be JSON object');
  const config = structuredClone(value) as Record<string, unknown>;
  if ('environment' in config) throw new TypeError('The application controls provider environments');
  if ('providerOptions' in config && (!config.providerOptions || typeof config.providerOptions !== 'object' || Array.isArray(config.providerOptions)
    || Object.entries(config.providerOptions).some(([key, v]) => !['experimentalControl', 'experimentalApi'].includes(key) || typeof v !== 'boolean'))) {
    throw new TypeError('The application controls native provider settings');
  }
  return config as unknown as LearningDefinition;
}
export function configuredArmCount(definition: LearningDefinition): number {
  const count = typeof definition.model === 'string' ? 1 : definition.model?.candidates?.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new TypeError('Configure 1..64 model arms');
  return count;
}
export function requireLearningBudget(required: number, maximum: number | undefined) {
  if (!Number.isSafeInteger(maximum) || maximum! < required || maximum! > 10000) throw new TypeError(`Explicit --max-launches budget must cover ${required} attempts`);
}
export function requireLearningTotalBudget(required: number, maximum = 1000) {
  if (!Number.isSafeInteger(maximum) || maximum < required || maximum > 10000) throw new TypeError(`--total-launches must cover ${required} attempts`);
}
export async function openLearningSession(options: LearningAppOptions) {
  const { definition: input, timeoutMs: requestedTimeout, objective: requestedObjective, stateDirectory: requestedDirectory, cwd: requestedCwd, suite = 'mixed' } = options;
  const definition = captureLearningDefinition(input), timeoutMs = requestedTimeout ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid learning timeout');
  const objective = requestedObjective ?? 'quality';
  if (!['quality', 'latency', 'cost'].includes(objective)) throw new TypeError('Invalid learning objective');
  if (!['mixed', 'document'].includes(suite)) throw new TypeError('Invalid learning suite');
  const cwd = requestedCwd ?? definition.cwd ?? process.cwd();
  const source = await harnessIdentity(), directory = await stateDirectory(requestedDirectory);
  definition.cwd = await realpath(resolve(cwd));
  const path = join(directory, 'learning'); await mkdir(path, { recursive: true, mode: 0o700 });
  const domain: LearningDomain = { id: 'document-triage-learning-v1', sourceDigest: source.digest,
    scorerDigest: learningDigest({ id: 'exact-answer', version: '1', sourceDigest: source.digest }),
    protocolDigest: learningDigest({ id: 'single-exec-verified-v1', timeoutMs, objective, suite, featureSchema: 'oar-hash-ngrams-v1' }) };
  const store = new SqliteLearningStore(join(path, 'evidence.sqlite'));
  const router = new LearningRouter({ store, domain, policy: { objective, minSimilarity: .5 } });
  return { definition, timeoutMs, directory, domain: learningDomainDigest(domain), protocolDigest: domain.protocolDigest, source, store, router };
}

/** Refuse an incompatible active lineage before a calibration or automatic production turn. */
export async function assertLearningLineage(session: Awaited<ReturnType<typeof openLearningSession>>, context: LearningContext,
  pointer?: LearningPointer, rollback = false) {
  const current = pointer ?? await session.router.inspect();
  const refs = [current.active, ...(rollback ? [current.previous] : [])].filter((ref): ref is string => ref !== null);
  if (!refs.length) return;
  const preflight = await session.router.preflight(session.definition, context);
  for (const ref of refs) {
    const snapshot = await session.store.get('snapshot', ref), binding = snapshot?.binding;
    if (!binding || binding.definitionDigest !== preflight.definitionDigest || binding.fallbackId !== preflight.fallbackId
      || learningDigest(binding.actions) !== learningDigest(preflight.actions)) {
      throw new Error('Learning policy lineage is incompatible with this definition or execution identity; use a separate --state-dir or restore the original configuration');
    }
  }
}

/** Per-command admission plus durable hourly/daily limits; failures consume admission. */
export class LearningLaunchBudget implements ObservedTaskBudget {
  readonly #budget: SharedLaunchBudget;
  readonly #key: string;
  #admitted = 0;
  constructor(path: string, domain: string, readonly maximum: number, total = 1000) {
    requireLearningBudget(1, maximum);
    if (!Number.isSafeInteger(total) || total < 1 || total > 10000) throw new TypeError('Invalid total study launch cap');
    this.#key = `learning:${domain}`;
    this.#budget = new SharedLaunchBudget({ databasePath: join(path, 'launches.sqlite'), providers: {
      [this.#key]: { maxConcurrent: 1, maxLaunchesPerHour: total, maxLaunchesPerDay: total, quotaCooldownMs: 60000 },
    } });
  }
  get admitted() { return this.#admitted; }
  acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#admitted >= this.maximum) throw new Error('LEARNING_LAUNCH_BUDGET_EXCEEDED');
    const result = this.#budget.reserve(this.#key, randomUUID());
    if (!result.allowed) throw new Error(`LEARNING_ADMISSION_DENIED:${result.reason}`);
    this.#admitted++;
    return { release: () => { const released = this.#budget.release(result.reservation.token); if (!released.ok) throw new Error('LEARNING_RESERVATION_RELEASE_FAILED'); } };
  }
  close() { this.#budget.close(); }
}
