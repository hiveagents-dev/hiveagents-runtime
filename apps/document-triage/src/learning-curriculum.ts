import { createHash } from 'node:crypto';
import { canonicalStudyJson, captureStudyJson, parseStudyJson } from './learning-json.js';
import type { StudyJson } from './learning-json.js';

export { parseStudyJson };
export type { StudyJson };
export interface StudyTask { id: string; text: string; expected: StudyJson }
export interface LearningCurriculum {
  format: 1; id: string; oracle: 'json-exact-v1';
  study: { maxCycles: number; maxLaunches: number; minNewTasks: number };
  evaluation: { repetitions: number };
  train: readonly StudyTask[]; fixed: readonly StudyTask[];
  freshBatches: readonly { id: string; tasks: readonly StudyTask[] }[];
}
export interface CurriculumTaskIdentity { id: string; inputDigest: string; expectedDigest: string }
export interface CurriculumIdentity {
  baseDigest: string;
  train: readonly CurriculumTaskIdentity[];
  fixed: readonly CurriculumTaskIdentity[];
  batches: readonly { id: string; digest: string; tasks: readonly CurriculumTaskIdentity[] }[];
}

function object(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new TypeError(`Expected exact fields: ${fields.join(',')}`);
  }
}
function identifier(value: unknown): asserts value is string {
  // The final negative lookahead requires actual end of input, including after a newline.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/.test(value)) throw new TypeError('Invalid study identifier');
}
function integer(value: unknown, max: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new TypeError(`Expected integer in 1..${max}`);
}
function list(value: unknown, min: number, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`Expected list length ${min}..${max}`);
}
function validateTask(value: unknown): asserts value is StudyTask {
  object(value, ['id', 'text', 'expected']); identifier(value.id);
  if (typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text, 'utf8') > 32768) throw new TypeError('Expected nonblank prompt within 32768 UTF8 bytes');
}
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (value: unknown): string => hash(canonicalStudyJson(value as StudyJson));

/** Synchronously capture and freeze caller JSON before any async work. */
export function studyTask(value: unknown): Readonly<StudyTask> {
  const copy = captureStudyJson(value); validateTask(copy); return copy;
}

/** Capture the complete corpus, enforce schema/bounds, and reject split leakage. */
export function captureCurriculum(value: unknown): Readonly<LearningCurriculum> {
  const copy = captureStudyJson(value);
  object(copy, ['format', 'id', 'oracle', 'study', 'evaluation', 'train', 'fixed', 'freshBatches']);
  if (copy.format !== 1 || copy.oracle !== 'json-exact-v1') throw new TypeError('Unsupported curriculum format or oracle');
  identifier(copy.id);
  object(copy.study, ['maxCycles', 'maxLaunches', 'minNewTasks']);
  integer(copy.study.maxCycles, 64); integer(copy.study.maxLaunches, 10000); integer(copy.study.minNewTasks, 128);
  object(copy.evaluation, ['repetitions']); integer(copy.evaluation.repetitions, 8);
  list(copy.train, 1, 128); list(copy.fixed, 1, 64); list(copy.freshBatches, 1, 64);
  if (copy.freshBatches.length > copy.study.maxCycles) throw new TypeError('Fresh batches exceed maxCycles');
  const ids = new Set<string>(), inputs = new Set<string>(), batchIds = new Set<string>();
  let count = 0;
  const tasks = (values: unknown[]) => {
    for (const value of values) {
      validateTask(value); const input = hash(value.text);
      if (ids.has(value.id) || inputs.has(input)) throw new TypeError('Duplicate task ID or prompt digest across corpus');
      ids.add(value.id); inputs.add(input);
      if (++count > 4096) throw new TypeError('Curriculum exceeds 4096 total tasks');
    }
  };
  tasks(copy.train); tasks(copy.fixed);
  for (const batch of copy.freshBatches) {
    object(batch, ['id', 'tasks']); identifier(batch.id); list(batch.tasks, 6, 128);
    if (batchIds.has(batch.id)) throw new TypeError('Duplicate fresh batch ID');
    batchIds.add(batch.id); tasks(batch.tasks);
  }
  return copy as unknown as Readonly<LearningCurriculum>;
}

/** Bind stable foundation separately from append-only fresh batch registrations. */
export function curriculumIdentity(corpus: LearningCurriculum): Readonly<CurriculumIdentity> {
  const copy = captureCurriculum(corpus);
  const taskIdentity = (task: StudyTask): CurriculumTaskIdentity => Object.freeze({ id: task.id,
    inputDigest: hash(task.text), expectedDigest: digest(task.expected) });
  const { format, id, oracle, study, evaluation, train, fixed } = copy;
  return Object.freeze({ baseDigest: digest({ format, id, oracle, study, evaluation, train, fixed }),
    train: Object.freeze(train.map(taskIdentity)), fixed: Object.freeze(fixed.map(taskIdentity)),
    batches: Object.freeze(copy.freshBatches.map(batch => Object.freeze({ id: batch.id, digest: digest(batch),
      tasks: Object.freeze(batch.tasks.map(taskIdentity)) }))) });
}

/** Invalid generated JSON scores zero; complete canonical JSON equality scores one. */
export function verifyStudyOutput(text: string, expected: StudyJson): { value: number; passed: boolean } {
  const captured = captureStudyJson(expected);
  try {
    const passed = canonicalStudyJson(parseStudyJson(text)) === canonicalStudyJson(captured);
    return { value: passed ? 1 : 0, passed };
  } catch { return { value: 0, passed: false }; }
}

/** Reject protected prompt reuse regardless of the production ID or expected answer. */
export function assertStudyProductionTask(corpus: LearningCurriculum, task: StudyTask): void {
  const captured = studyTask(task), identity = curriculumIdentity(corpus), input = hash(captured.text);
  if ([...identity.train, ...identity.fixed, ...identity.batches.flatMap(batch => batch.tasks)]
    .some(protectedTask => protectedTask.inputDigest === input)) throw new TypeError('Production prompt matches protected corpus digest');
}
