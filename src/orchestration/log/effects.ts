import { canonical, freeze, identifier } from '../../shared/json.js';
import { digest } from './encoding.js';
import { lookupReceipt, readEntry } from './records.js';
import { captureAssociation, effectId, runKey } from './execution-validation.js';
import { readState } from './materialized.js';
import { executionFailure } from './execution-types.js';
import { validateDecisionRecord } from '../decisions/runner.js';
import type { CapturedEffectAssociation, ManagedEffectAssociation } from './execution-types.js';
import type { ExecutionDatabaseContext, LogExecutionDatabase } from './execution-database.js';
import { executionContext } from './execution-database.js';
import type { DecisionRecord } from '../decisions/types.js';
import type { RunIdentity } from './types.js';
import type { DecisionLogMetadata } from './execution-metadata.js';
export interface ManagedEffectView {
  readonly association: CapturedEffectAssociation; readonly decisionId: string; readonly record?: DecisionRecord;
  readonly metadata?: DecisionLogMetadata; readonly bodyState?: 'inline' | 'requires-body';
}
export function readEffect(context: ExecutionDatabaseContext, id: string): ManagedEffectView | undefined {
  const row = context.db.prepare(`SELECT run_key,step_id,generation,decision_id,association_digest,
    CASE WHEN length(CAST(association_json AS BLOB))<8192 THEN association_json END AS association_json FROM main.oar_execution_effects WHERE effect_id=?`).get(id);
  if (!row) { if (lookupReceipt(context.db, `effect:${id}`, context.source)) executionFailure('INTEGRITY'); return undefined; }
  try {
    if (typeof row.association_json !== 'string' || digest(row.association_json) !== row.association_digest) executionFailure('INTEGRITY');
    const raw = JSON.parse(row.association_json), { sourceId, ...input } = raw;
    const association = captureAssociation(input as ManagedEffectAssociation, context.source.sourceId, context.source.systemId);
    if (sourceId !== context.source.sourceId || canonical(association) !== row.association_json || effectId(association) !== id
      || runKey(context.source.sourceId, association.identity) !== row.run_key || row.step_id !== association.stepId || row.generation !== association.identity.generation) executionFailure('INTEGRITY');
    const origin = lookupReceipt(context.db, `effect:${id}`, context.source);
    if (!origin || origin.receipt.count !== 1) executionFailure('INTEGRITY');
    const event = readEntry(context.db, origin.receipt.first.sequence, context.source);
    if (event.record.schema.id !== 'oar.execution.association' || event.record.schema.version !== 1 || event.record.type !== 'effect.associated'
      || canonical(event.record.identity) !== canonical(association.identity)
      || canonical(event.record.payload) !== canonical({ inline: { effectId: id, decisionId: row.decision_id, association } })) executionFailure('INTEGRITY');
    identifier(row.decision_id); const state = readState(context, 'decision', id, association.identity);
    const record = state && !state.body ? validateDecisionRecord(state.record, row.decision_id) : undefined;
    if (state && (state.metadata.kind !== 'decision' || state.metadata.decisionIdDigest !== digest(row.decision_id))) executionFailure('INTEGRITY');
    return freeze({ association, decisionId: row.decision_id, ...(record ? { record } : {}),
      ...(state ? { metadata: state.metadata as DecisionLogMetadata, bodyState: state.body ? 'requires-body' : 'inline' } : {}) }) as ManagedEffectView;
  } catch { return executionFailure('INTEGRITY'); }
}
export function associateEffect(context: ExecutionDatabaseContext, association: CapturedEffectAssociation, decisionId: string): void {
  identifier(decisionId); const id = effectId(association), existing = readEffect(context, id);
  if (existing) {
    if (existing.decisionId !== decisionId || canonical(existing.association) !== canonical(association)) executionFailure('EFFECT_BINDING_CONFLICT'); return;
  }
  if (readState(context, 'decision', id, association.identity)) executionFailure('INTEGRITY');
  const encoded = canonical(association);
  context.db.prepare('INSERT INTO main.oar_execution_effects VALUES(?,?,?,?,?,?,?)').run(id, runKey(context.source.sourceId, association.identity), association.stepId,
    association.identity.generation, decisionId, encoded, digest(encoded));
  context.binding.appendInTransaction({ requestId: `effect:${id}`, records: [{ identity: association.identity, schema: { id: 'oar.execution.association', version: 1 },
    type: 'effect.associated', causal: [], payload: { inline: { effectId: id, decisionId, association: association as any } } }] });
}
/** Global fixed-key batches validate immutable data BEFORE scope exclusion. Total guard work is not constant. */
export function visitEffects(context: ExecutionDatabaseContext, visit: (id: string, effect: ManagedEffectView) => void): void {
  let after: string | null = null;
  for (;;) {
    const ids: Record<string, unknown>[] = context.db.prepare('SELECT effect_id FROM main.oar_execution_effects WHERE (? IS NULL OR effect_id>?) ORDER BY effect_id LIMIT 256').all(after, after);
    for (const row of ids) { if (typeof row.effect_id !== 'string') executionFailure('INTEGRITY'); const effect = readEffect(context, row.effect_id); if (!effect) executionFailure('INTEGRITY'); visit(row.effect_id, effect); }
    if (ids.length < 256) return; after = String(ids.at(-1)!.effect_id);
  }
}
export function unresolved(record?: Pick<DecisionRecord, 'status'>): boolean { return !!record && ['intent', 'dispatched', 'needs-owner'].includes(record.status); }
export function assertResolvedRun(context: ExecutionDatabaseContext, identity: RunIdentity, except?: string): void {
  const key = runKey(context.source.sourceId, identity);
  visitEffects(context, (id, effect) => {
    if (id !== except && runKey(context.source.sourceId, effect.association.identity) === key && unresolved(effect.metadata)) executionFailure('OUTCOME_UNKNOWN');
  });
}
/** Data inspection never acquires or recovers an execution lease. */
export function inspectManagedEffect(database: LogExecutionDatabase, input: ManagedEffectAssociation): ManagedEffectView | undefined {
  const context = executionContext(database), association = captureAssociation(input, context.source.sourceId, context.source.systemId);
  return context.transaction(() => { const effect = readEffect(context, effectId(association)); if (effect && canonical(effect.association) !== canonical(association)) executionFailure('EFFECT_BINDING_CONFLICT'); return effect; });
}
