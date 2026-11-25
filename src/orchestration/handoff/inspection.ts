import { decisionHash } from '../decisions/binding.js';
import { validateDecisionRecord } from '../decisions/runner.js';
import type { DecisionRecord, DecisionStore } from '../decisions/types.js';
import { identifier, snapshotHandoff } from './bundle.js';
import type { HandoffStore, TaskHandoff } from './types.js';

/** Shared exact binding for execution and read-only inspection. */
export function handoffDecisionInput(handoff: TaskHandoff) {
  return { handoffId: handoff.id, handoffDigest: handoff.digest, sourceDigest: handoff.source.digest,
    target: { id: handoff.destination.id, version: handoff.destination.version,
      ...(handoff.destination.provider === undefined ? {} : { provider: handoff.destination.provider }),
      ...(handoff.destination.model === undefined ? {} : { model: handoff.destination.model }) } };
}

/** Validate durable state without authorizing, dispatching, verifying, or saving a decision. */
export async function readHandoffDecision(options: {
  id: string; handoffId: string; store: HandoffStore; decisionStore: DecisionStore;
}): Promise<DecisionRecord | undefined> {
  identifier(options.id); identifier(options.handoffId);
  const loaded = await options.store.load(options.handoffId);
  if (loaded === undefined) throw new Error('Handoff not found');
  const handoff = snapshotHandoff(loaded, options.handoffId);
  const expectedInputHash = decisionHash(handoffDecisionInput(handoff));
  const lease = await options.decisionStore.acquire(options.id);
  try {
    const raw = await lease.load();
    if (raw === undefined) return undefined;
    const record = validateDecisionRecord(raw, options.id);
    if (record.binding.inputVersion !== 'task-handoff:1' || record.binding.inputHash !== expectedInputHash) {
      throw new Error('Decision binding does not match handoff');
    }
    return record;
  } finally { await lease.release(); }
}
