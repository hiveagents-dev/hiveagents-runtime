import { identity, jsonClone, validateCheckpoint } from '../workflow/checkpoint.js';
import type { JsonValue, WorkflowDefinition, WorkflowStore } from '../workflow/types.js';
import type { DecisionLease, DecisionRecord, DecisionStore } from './types.js';

// A versioned data envelope only. The workflow runner never invokes this step.
const envelope: WorkflowDefinition = { id: 'decision-record', version: '1', steps: [{ id: 'record', execute: () => null }] };

/** Reuse an existing WorkflowStore's exclusive lease and atomic persistence. */
export class WorkflowDecisionStore implements DecisionStore {
  constructor(private readonly store: WorkflowStore) {}
  async acquire(id: string): Promise<DecisionLease> {
    const runId = `decision:${id}`, lease = await this.store.acquire(runId);
    return {
      async load() {
        const value = await lease.load();
        if (value === undefined) return undefined;
        return validateCheckpoint(value, envelope, runId).steps.record!.output;
      },
      async save(record: DecisionRecord) {
        await lease.save({ format: 1, runId, workflow: identity(envelope), status: 'completed',
          steps: { record: { status: 'completed', attempts: 1, output: jsonClone(record) as unknown as JsonValue } } });
      },
      release: () => lease.release(),
    };
  }
}
