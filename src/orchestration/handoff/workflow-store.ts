import { identity, jsonClone, validateCheckpoint } from '../workflow/checkpoint.js';
import type { JsonValue, WorkflowDefinition, WorkflowStore } from '../workflow/types.js';
import { fields, identifier, snapshotHandoff } from './bundle.js';
import type { HandoffStore, TaskHandoff } from './types.js';

const envelope: WorkflowDefinition = { id: 'task-handoff', version: '1', steps: [{ id: 'bundle', execute: () => null }] };

function load(value: unknown, id: string, runId: string): TaskHandoff | undefined {
  if (value === undefined) return undefined;
  const object = fields(value, ['format', 'runId', 'workflow', 'status', 'steps']);
  fields(object.workflow, ['id', 'version', 'fingerprint']);
  const steps = fields(object.steps, ['bundle']);
  const state = fields(steps.bundle, ['status', 'attempts', 'output']);
  if (object.status !== 'completed' || state.status !== 'completed' || state.attempts !== 1) throw Error('Corrupt handoff envelope');
  const checked = validateCheckpoint(object, envelope, runId);
  return snapshotHandoff(checked.steps.bundle!.output, id);
}

/** Adapts the existing exclusive workflow lease; same-id content is immutable. */
export class WorkflowHandoffStore implements HandoffStore {
  constructor(private readonly store: WorkflowStore) {}
  async save(handoff: TaskHandoff): Promise<void> {
    const bundle = snapshotHandoff(handoff), runId = `handoff:${bundle.id}`;
    const lease = await this.store.acquire(runId);
    try {
      const existing = load(await lease.load(), bundle.id, runId);
      if (existing) {
        if (existing.digest !== bundle.digest) throw Error('Immutable handoff id has different content');
        return;
      }
      await lease.save({ format: 1, runId, workflow: identity(envelope), status: 'completed',
        steps: { bundle: { status: 'completed', attempts: 1, output: jsonClone(bundle) as unknown as JsonValue } } });
    } finally { await lease.release(); }
  }
  async load(id: string): Promise<TaskHandoff | undefined> {
    identifier(id); const runId = `handoff:${id}`, lease = await this.store.acquire(runId);
    try { return load(await lease.load(), id, runId); }
    finally { await lease.release(); }
  }
}
