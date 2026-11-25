import { checksum } from '../../shared/json.js';
import type { JsonValue, WorkflowCheckpoint, WorkflowDefinition, WorkflowStep } from './types.js';

export { checksum };

export function nonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
}

/** Validates rather than silently dropping undefined, Infinity, holes, cycles or toJSON objects. */
export function jsonClone<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) throw new Error('Workflow output must be JSON-compatible');
    if (seen.has(item)) throw new Error('Workflow output must be JSON-compatible (cycle)');
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('Workflow output must be JSON-compatible (plain objects only)');
    }
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Workflow output must be JSON-compatible');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error('Workflow output must be JSON-compatible (enumerable data properties only)');
      }
    }
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new Error('Workflow output must be JSON-compatible (array holes/properties)');
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) throw new Error('Workflow output must be JSON-compatible (array hole)');
        visit(item[index]);
      }
    } else {
      for (const child of Object.values(item)) visit(child);
    }
    seen.delete(item);
  };
  visit(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function identity(definition: WorkflowDefinition): WorkflowCheckpoint['workflow'] {
  nonempty(definition.id, 'Workflow id'); nonempty(definition.version, 'Workflow version');
  for (const step of definition.steps) {
    const attempts = step.maxAttempts ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error(`Invalid maxAttempts for ${step.id}`);
    if (step.replaySafe !== undefined && typeof step.replaySafe !== 'boolean') throw new Error(`Invalid replaySafe for ${step.id}`);
    if (typeof step.execute !== 'function') throw new Error(`Missing execute callback for ${step.id}`);
  }
  return {
    id: definition.id, version: definition.version,
    fingerprint: checksum(JSON.stringify({
      id: definition.id, version: definition.version,
      steps: definition.steps.map(step => ({
        id: step.id, dependencies: [...(step.dependencies ?? [])].sort(),
        maxAttempts: step.maxAttempts ?? 1, replaySafe: step.replaySafe ?? false,
      })),
    })),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateCheckpoint(
  value: unknown, definition: WorkflowDefinition, runId: string,
): WorkflowCheckpoint {
  const fail = (): never => { throw new Error('Corrupt workflow checkpoint'); };
  if (!object(value) || value.format !== 1 || value.runId !== runId || !object(value.workflow)) return fail();
  const wanted = identity(definition);
  if (value.workflow.id !== wanted.id || value.workflow.version !== wanted.version
    || value.workflow.fingerprint !== wanted.fingerprint) throw new Error('Workflow definition does not match checkpoint');
  if (typeof value.status !== 'string' || !['running', 'completed', 'failed', 'cancelled', 'halted'].includes(value.status) || !object(value.steps)) return fail();
  if (Object.keys(value.steps).length !== definition.steps.length) return fail();
  for (const step of definition.steps) {
    if (!Object.hasOwn(value.steps, step.id)) return fail();
    const state = value.steps[step.id];
    if (!object(state) || !Number.isSafeInteger(state.attempts)) return fail();
    const attempts = state.attempts as number; const max = step.maxAttempts ?? 1;
    if (attempts < 0 || attempts > max) return fail();
    if (typeof state.status !== 'string' || !['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked'].includes(state.status)) return fail();
    if (state.status === 'pending' && attempts >= max) return fail();
    if (state.status === 'blocked' ? attempts !== 0 : state.status !== 'pending' && attempts === 0) return fail();
    if (state.status === 'failed' && attempts !== max) return fail();
    if (state.error !== undefined && typeof state.error !== 'string') return fail();
    if ((state.status === 'completed') !== Object.hasOwn(state, 'output')) return fail();
    if (state.status === 'completed') jsonClone(state.output as JsonValue);
    if (attempts > 0) {
      for (const dependency of step.dependencies ?? []) {
        const parent = value.steps[dependency];
        if (!object(parent) || parent.status !== 'completed') return fail();
      }
    }
  }
  const states = Object.values(value.steps) as unknown as WorkflowCheckpoint['steps'][string][];
  if (value.status === 'completed' && !states.every(state => state.status === 'completed')) return fail();
  if (value.status === 'failed' && (states.some(state => ['pending', 'running', 'interrupted'].includes(state.status))
    || !states.some(state => state.status === 'failed'))) return fail();
  return jsonClone(value) as unknown as WorkflowCheckpoint;
}

export function cloneSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.map(step => ({ ...step, ...(step.dependencies === undefined ? {} : { dependencies: [...step.dependencies] }) }));
}
