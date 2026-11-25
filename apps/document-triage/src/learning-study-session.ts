import { open, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Runtime } from 'hiveagents-runtime';
import { LearningRouter, SqliteLearningStore, learningDomainDigest, learningDigest,
  DEFAULT_LEARNING_POLICY, type LearningDomain, type LearningPolicyConfig } from 'hiveagents-runtime/routing/learning';
import { captureLearningDefinition, LearningLaunchBudget, requireLearningBudget } from './learning-session.js';
import { captureCurriculum, curriculumIdentity, parseStudyJson, type LearningCurriculum } from './learning-curriculum.js';
import { LearningStudyRunner } from './learning-study.js';
import { createAppRuntime } from './runtime.js';
import { harnessIdentity, stateDirectory } from './harness-common.js';

export interface StudyAppOptions {
  definition: unknown; corpus: unknown; stateDirectory: string; runtime?: Runtime;
  cwd?: string; timeoutMs?: number; objective?: LearningPolicyConfig['objective'];
  maxLaunches?: number; totalLaunches?: number; signal?: AbortSignal;
  cycles?: number; operation?: 'promote'|'rollback'; batchId?: string;
}

/** Bounded UTF8 JSON input, with duplicate-key rejection shared with the exact oracle. */
export async function readStudyJsonFile(path: string) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK), maximum = 8 * 1024 * 1024;
  try {
    if (!(await file.stat()).isFile()) throw new TypeError('Study JSON input must be a regular file');
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const part = await file.read(buffer, size, buffer.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size > maximum) throw new TypeError('Study JSON input exceeds 8MiB');
    return parseStudyJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await file.close(); }
}

export function captureStudyOptions(options: StudyAppOptions) {
  const captured = { ...options, definition: captureLearningDefinition(options.definition), corpus: captureCurriculum(options.corpus) };
  const timeoutMs = captured.timeoutMs ?? 60000, objective = captured.objective ?? 'quality';
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid study timeout');
  if (!['quality', 'latency', 'cost'].includes(objective)) throw new TypeError('Invalid study objective');
  if (captured.cycles !== undefined && (!Number.isSafeInteger(captured.cycles) || captured.cycles < 1 || captured.cycles > captured.corpus.study.maxCycles)) throw new TypeError('Invalid study cycle count');
  if (captured.operation !== undefined && !['promote', 'rollback'].includes(captured.operation)) throw new TypeError('Invalid study operation');
  return { ...captured, timeoutMs, objective };
}

export async function openStudyApplication(options: ReturnType<typeof captureStudyOptions>, execute: boolean) {
  options = { ...options, definition: captureLearningDefinition(options.definition), corpus: captureCurriculum(options.corpus) };
  if (execute) requireLearningBudget(1, options.maxLaunches);
  const identity = curriculumIdentity(options.corpus), definition = options.definition;
  const cwd = await realpath(resolve(options.cwd ?? definition.cwd ?? process.cwd()));
  definition.cwd = cwd;
  const source = await harnessIdentity(), directory = await stateDirectory(options.stateDirectory);
  await mkdir(join(directory, 'learning'), { recursive: true, mode: 0o700 });
  const policy = { ...DEFAULT_LEARNING_POLICY, objective: options.objective, minSimilarity: .5, alpha: .05 / options.corpus.study.maxCycles };
  const domain: LearningDomain = { id: 'document-triage-study-v1', sourceDigest: source.digest,
    scorerDigest: learningDigest({ id: 'json-exact-v1', sourceDigest: source.digest }),
    protocolDigest: learningDigest({ id: 'continuous-study-v1', baseDigest: identity.baseDigest,
      timeoutMs: options.timeoutMs, policy, featureSchema: 'oar-hash-ngrams-v1' }) };
  const evidence = new SqliteLearningStore(join(directory, 'learning', 'evidence.sqlite'));
  let budget: LearningLaunchBudget | undefined;
  try {
    const router = new LearningRouter({ store: evidence, domain, policy });
    budget = execute ? new LearningLaunchBudget(directory, learningDomainDigest(domain), options.maxLaunches!, options.totalLaunches ?? options.corpus.study.maxLaunches) : undefined;
    const runner = new LearningStudyRunner({ directory, domain: learningDomainDigest(domain), protocolDigest: domain.protocolDigest,
      definition, timeoutMs: options.timeoutMs, runtime: options.runtime ?? createAppRuntime(), router, evidence, corpus: options.corpus,
      budget: budget ?? { acquire() { throw new Error('Study status cannot admit model work'); } } });
    return { runner, router, evidence, budget, directory, domain: learningDomainDigest(domain), source, corpus: options.corpus as LearningCurriculum,
      close() {
        const errors: unknown[] = [];
        try { budget?.close(); } catch (error) { errors.push(error); }
        try { evidence.close(); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Study resource cleanup failed');
      } };
  } catch (error) {
    const failures: unknown[] = [error];
    try { budget?.close(); } catch (cleanup) { failures.push(cleanup); }
    try { evidence.close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'Study initialization and cleanup failed');
    throw error;
  }
}
