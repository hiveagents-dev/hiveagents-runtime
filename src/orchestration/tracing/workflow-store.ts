import { identity, jsonClone, validateCheckpoint } from '../workflow/checkpoint.js';
import type { JsonValue, WorkflowDefinition, WorkflowStore } from '../workflow/types.js';
import type { TraceEpisode, TraceLease, TraceStore } from './types.js';
import { identifier, record, validateEpisode, validateReplacement } from './validation.js';

const envelope: WorkflowDefinition = { id: 'trace-episode', version: '1', steps: [{ id: 'record', execute: () => null }] };

/** Versioned data envelope over a trusted WorkflowStore's exclusive, durable lease. */
export class WorkflowTraceStore implements TraceStore {
  constructor(private readonly store: WorkflowStore) {}
  async acquire(episodeId: string): Promise<TraceLease> {
    identifier(episodeId, 'episodeId');
    const runId = `trace:${episodeId}`, lease = await this.store.acquire(runId);
    let operations: Promise<unknown> = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const pending = operations.then(operation); operations = pending.catch(() => undefined); return pending;
    };
    const load = async (): Promise<TraceEpisode | undefined> => {
      const value = await lease.load();
      if (value === undefined) return undefined;
      record(value, ['format', 'runId', 'workflow', 'status', 'steps'], 'store envelope');
      record(value.workflow, ['id', 'version', 'fingerprint'], 'store workflow');
      record(value.steps, ['record'], 'store steps');
      record(value.steps.record, ['status', 'attempts', 'output'], 'store record');
      const checkpoint = validateCheckpoint(value, envelope, runId);
      if (checkpoint.status !== 'completed') throw new Error('Invalid trace store envelope');
      return validateEpisode(checkpoint.steps.record!.output, episodeId);
    };
    return {
      load: () => serial(load),
      save(value) {
        let captured: TraceEpisode;
        try { captured = validateEpisode(value, episodeId); } catch (error) { return Promise.reject(error); }
        return serial(async () => {
          const previous = await load();
          if (previous) validateReplacement(previous, captured);
          await lease.save({ format: 1, runId, workflow: identity(envelope), status: 'completed',
            steps: { record: { status: 'completed', attempts: 1, output: jsonClone(captured) as unknown as JsonValue } } });
        });
      },
      release: () => serial(() => lease.release()),
    };
  }
}
