import { canonical, object } from '../../shared/json.js';
import { sameDecisionBinding } from '../decisions/binding.js';
import { validateDecisionRecord } from '../decisions/runner.js';
import type { DecisionLease, DecisionRecord, DecisionStore } from '../decisions/types.js';
import type { CapturedEffectAssociation, ManagedEffectAssociation } from './execution-types.js';
import { executionFailure, safeExecutionFailure } from './execution-types.js';
import { executionContext } from './execution-database.js';
import type { LogExecutionDatabase } from './execution-database.js';
import { captureAssociation, effectId } from './execution-validation.js';
import { acquireOwner, assertOwner, markOwnerActive, markOwnerDrained, releaseOwner } from './leases.js';
import { commitState, hydrateState, prepareState, readState } from './materialized.js';
import { assertResolvedRun, associateEffect, readEffect } from './effects.js';
import type { LogJsonValue } from './types.js';
import { reconcileOriginalDecision } from './decision-reconciliation.js';
import type { DecisionReconciliationOptions } from './decision-reconciliation-types.js';
function validateTransition(previous: DecisionRecord | undefined, next: DecisionRecord): void {
  if (!previous) { if (!['waiting', 'denied', 'intent'].includes(next.status) || next.attempts !== (next.status === 'intent' ? 1 : 0)) executionFailure('INVALID_STATE'); return; }
  if (!sameDecisionBinding(previous.binding, next.binding)) executionFailure('EFFECT_BINDING_CONFLICT');
  if (canonical(previous) === canonical(next)) return;
  const allowed: Record<DecisionRecord['status'], readonly DecisionRecord['status'][]> = { waiting: ['waiting', 'denied', 'intent', 'needs-owner'], denied: [], intent: ['dispatched', 'needs-owner'], dispatched: ['dispatched', 'verified', 'needs-owner'], verified: [], 'needs-owner': [] };
  if (!allowed[previous.status].includes(next.status) || next.attempts !== previous.attempts + (next.status === 'intent' ? 1 : 0)
    || previous.intentId && next.intentId !== previous.intentId) executionFailure('INVALID_STATE');
}
/** One managed immutable effect association. Run-level ownership conservatively serializes callbacks. */
export class LogDecisionStore implements DecisionStore {
  readonly #database!: LogExecutionDatabase; readonly #association!: CapturedEffectAssociation;
  constructor(options: { database: LogExecutionDatabase; association: ManagedEffectAssociation; requireResolvedRun?: true }) {
    try {
      object(options, ['database', 'association', 'requireResolvedRun']); if (options.requireResolvedRun !== undefined && options.requireResolvedRun !== true) executionFailure('INVALID_STATE');
      const context = executionContext(options.database); this.#database = options.database;
      this.#association = captureAssociation(options.association, context.source.sourceId, context.source.systemId);
    } catch { return executionFailure('INVALID_STATE'); }
  }
  reconcile(options: DecisionReconciliationOptions): Promise<DecisionRecord> { return reconcileOriginalDecision(this.#database, this.#association, options); }
  async acquire(id: string): Promise<DecisionLease> {
    const context = executionContext(this.#database), association = this.#association, key = effectId(association);
    const acquired = context.transaction(() => {
      associateEffect(context, association, id); assertResolvedRun(context, association.identity, key);
      const owner = acquireOwner(context, 'decision', association.identity), state = readState(context, 'decision', key, association.identity);
      return { owner, revision: state?.revision ?? 0 };
    }, true);
    const owner = acquired.owner; markOwnerActive(context, owner); let revision = acquired.revision, released = false, poisoned = false, busy = false;
    const assert = () => { if (released || poisoned) executionFailure('OUTCOME_UNKNOWN'); assertOwner(context, owner); };
    const captureSnapshot = () => context.transaction(() => { assert(); return readState(context, 'decision', key, association.identity); });
    const checkSnapshot = (snapshot: ReturnType<typeof readState>) => context.transaction(() => {
      assert(); const effect = readEffect(context, key), current = readState(context, 'decision', key, association.identity);
      if (!effect || canonical(effect.association) !== canonical(association) || (current?.revision ?? 0) !== revision
        || current?.recordDigest !== snapshot?.recordDigest || current?.recordJson !== snapshot?.recordJson) executionFailure('OUTCOME_UNKNOWN');
    });
    return {
      async load() {
        if (busy) executionFailure('CODEC_BUSY'); busy = true;
        try { return await context.codec.operation(async () => {
          const snapshot = captureSnapshot(); if (!snapshot) return undefined;
          const record = await hydrateState(context, 'decision', snapshot, () => checkSnapshot(snapshot)); checkSnapshot(snapshot);
          return validateDecisionRecord(record, id);
        }); } catch (error) { poisoned = true; return safeExecutionFailure(error); } finally { busy = false; }
      },
      async save(input) {
        if (busy) executionFailure('CODEC_BUSY'); busy = true;
        try {
          await context.codec.operation(async () => {
            const snapshot = captureSnapshot(), check = () => checkSnapshot(snapshot);
            const captured = await context.codec.capture(input, check); check(); const next = validateDecisionRecord(captured, id);
            const previous = snapshot ? await hydrateState(context, 'decision', snapshot, check) : undefined; check();
            validateTransition(previous ? validateDecisionRecord(previous, id) : undefined, next);
            const prepared = await prepareState(context, 'decision', key, association.identity, next as unknown as LogJsonValue, revision, `decision.${next.status}`, check); check();
            const saved = context.transaction(() => { assert(); assertResolvedRun(context, association.identity, key); return commitState(context, 'decision', key, association.identity, prepared); }, true);
            revision = saved.revision;
          });
        } catch (error) { poisoned = true; safeExecutionFailure(error); } finally { busy = false; }
      },
      async release() {
        if (released) return;
        if (busy) executionFailure('OUTCOME_UNKNOWN');
        try { if (poisoned) executionFailure('OUTCOME_UNKNOWN'); context.transaction(() => releaseOwner(context, owner), true); released = true; }
        finally { markOwnerDrained(context, owner); }
      },
    };
  }
}
