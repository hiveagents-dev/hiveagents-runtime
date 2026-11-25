import { identity, validateCheckpoint } from '../orchestration/workflow/checkpoint.js';
import type { JsonValue, WorkflowDefinition, WorkflowStore } from '../orchestration/workflow/types.js';
import { identifier, jsonClone, method, object } from '../shared/json.js';
import { validateRoutingReceipt } from './receipt.js';
import type { RoutingReceipt, RoutingReceiptStore } from './types.js';
const envelope: WorkflowDefinition = { id: 'routing-receipt', version: '1', steps: [{ id: 'record', execute: () => null }] };
export class WorkflowRoutingReceiptStore implements RoutingReceiptStore {
  readonly #acquire: WorkflowStore['acquire'];
  constructor(store: WorkflowStore) { this.#acquire = method(store, 'acquire'); }
  async save(value: RoutingReceipt): Promise<void> {
    const receipt = validateRoutingReceipt(value); const runId = `routing:${receipt.id}`;
    const lease = await this.#acquire(runId);
    try {
      if (await lease.load() !== undefined) throw new Error('Routing receipt ID already exists');
      await lease.save({ format: 1, runId, workflow: identity(envelope), status: 'completed', steps: {
        record: { status: 'completed', attempts: 1, output: receipt as unknown as JsonValue },
      } });
    } finally { await lease.release(); }
  }
  async load(id: string): Promise<RoutingReceipt | undefined> {
    identifier(id); const runId = `routing:${id}`; const lease = await this.#acquire(runId);
    try {
      const loaded = await lease.load(); if (loaded === undefined) return undefined;
      const value = jsonClone(loaded);
      object(value, ['format', 'runId', 'workflow', 'status', 'steps']);
      object(value.workflow, ['id', 'version', 'fingerprint']); object(value.steps, ['record']);
      object(value.steps.record, ['status', 'attempts', 'output']);
      const checkpoint = validateCheckpoint(value, envelope, runId);
      if (checkpoint.status !== 'completed') throw new TypeError('Invalid routing envelope');
      const receipt = validateRoutingReceipt(checkpoint.steps.record!.output);
      if (receipt.id !== id) throw new TypeError('Receipt ID mismatch'); return receipt;
    } finally { await lease.release(); }
  }
}
