import { randomUUID } from 'node:crypto';
import { canonical, freeze, identifier, method, object, ownObject } from '../../shared/json.js';
import { isExecutionHalted, ExecutionHaltedError } from '../../public/execution-halt.js';
import { decisionHash, sameDecisionBinding, snapshotBinding } from '../decisions/binding.js';
import { validateDecisionRecord } from '../decisions/runner.js';
import type { DecisionRecord } from '../decisions/types.js';
import type { JsonValue } from '../workflow/types.js';
import { digest } from './encoding.js';
import { executionContext } from './execution-database.js';
import type { LogExecutionDatabase } from './execution-database.js';
import { executionFailure } from './execution-types.js';
import type { CapturedEffectAssociation } from './execution-types.js';
import { effectId } from './execution-validation.js';
import { acquireOwner, assertOwner, markOwnerActive, markOwnerDrained, releaseOwner } from './leases.js';
import { commitState, hydrateState, prepareState, readState } from './materialized.js';
import { readEffect } from './effects.js';
import type { LogJsonValue, LogPosition } from './types.js';
import type { DecisionReconciliationOptions } from './decision-reconciliation-types.js';

function halted(error: unknown): unknown {
  return isExecutionHalted(error) ? error : new ExecutionHaltedError({ sanitizedDiagnostics: { reason: 'ORIGINAL_EFFECT_UNVERIFIED' } }, { cause: error });
}
/** Only this original-association method may make an owner-required record verified, without dispatch. */
export async function reconcileOriginalDecision(database: LogExecutionDatabase, association: CapturedEffectAssociation, input: DecisionReconciliationOptions): Promise<DecisionRecord> {
  const options = ownObject(input, ['id', 'intentId', 'binding', 'verifyApplied']); identifier(options.id); identifier(options.intentId);
  const verifyApplied = method<DecisionReconciliationOptions['verifyApplied']>(options, 'verifyApplied');
  const context = executionContext(database), key = effectId(association);
  const initial = context.transaction(() => {
    const effect = readEffect(context, key), state = readState(context, 'decision', key, association.identity);
    if (!effect || effect.decisionId !== options.id || canonical(effect.association) !== canonical(association) || !state
      || state.metadata.kind !== 'decision' || !['intent', 'dispatched', 'needs-owner', 'verified'].includes(state.metadata.status)) executionFailure('OUTCOME_UNKNOWN');
    // Verification is not a new dispatch. Other unresolved effects remain untouched and cannot deadlock reconciliation.
    return { state, owner: acquireOwner(context, 'decision', association.identity) };
  }, true);
  markOwnerActive(context, initial.owner); let failed = false, failure: unknown, uncertainCommit = false;
  const checkBody = () => {
    assertOwner(context, initial.owner); const effect = readEffect(context, key), state = readState(context, 'decision', key, association.identity);
    if (!effect || effect.decisionId !== options.id || canonical(effect.association) !== canonical(association) || !state
      || state.revision !== initial.state.revision || state.recordDigest !== initial.state.recordDigest || state.recordJson !== initial.state.recordJson) executionFailure('OUTCOME_UNKNOWN');
  };
  const check = () => context.transaction(checkBody);
  const position = (): LogPosition => {
    const row = context.db.prepare("SELECT sequence,event_digest FROM main.oar_execution_states WHERE kind='decision' AND state_key=?").get(key);
    if (!row || !Number.isSafeInteger(row.sequence) || typeof row.event_digest !== 'string') executionFailure('INTEGRITY');
    return Object.freeze({ sourceId: context.source.sourceId, sequence: Number(row.sequence), digest: row.event_digest });
  };
  try {
    return await context.codec.operation(async () => {
      const capturedBinding = await context.codec.capture(options.binding, check); check(); const binding = snapshotBinding(capturedBinding as unknown as DecisionReconciliationOptions['binding']);
      const original = validateDecisionRecord(await hydrateState(context, 'decision', initial.state, check), options.id); check();
      if (original.intentId !== options.intentId || !sameDecisionBinding(original.binding, binding)) executionFailure('EFFECT_BINDING_CONFLICT');
      if (original.status === 'verified') return original;
      if (!original.authorization || original.authorization.decision !== 'allow' || original.attempts < 1) executionFailure('OUTCOME_UNKNOWN');
      const originalPosition = context.transaction(() => { checkBody(); return position(); });
      const verdict = await verifyApplied(freeze({ association, record: freeze(original) })); check(); object(verdict, ['verified', 'result', 'evidence']);
      if (typeof verdict.verified !== 'boolean') executionFailure('OUTCOME_UNKNOWN');
      if (!verdict.verified) return original;
      if (!Object.hasOwn(verdict, 'result') || !Array.isArray(verdict.evidence) || verdict.evidence.length < 1 || verdict.evidence.length > 64) executionFailure('OUTCOME_UNKNOWN');
      const captured = await context.codec.capture({ result: verdict.result, evidence: verdict.evidence }, check); check(); object(captured, ['result', 'evidence']);
      const evidence = captured.evidence as unknown[];
      if (evidence.some(value => typeof value !== 'string' || !value.trim() || value.length > 1024)) executionFailure('OUTCOME_UNKNOWN');
      const result = captured.result as JsonValue, resultHash = decisionHash(result), now = Date.now(); if (!Number.isSafeInteger(now) || now < 0) executionFailure('OUTCOME_UNKNOWN');
      const next: DecisionRecord = { ...original, status: 'verified', result, reason: 'Original-target postcondition reconciled by owner', receipt: {
        intentId: original.intentId, inputHash: original.binding.inputHash, authorityHash: original.binding.authorityHash,
        inputVersion: original.binding.inputVersion, authorityVersion: original.binding.authorityVersion, approval: original.authorization,
        resultHash, evidence: evidence as string[], verifiedAt: now,
      } };
      validateDecisionRecord(next, options.id);
      const prepared = await prepareState(context, 'decision', key, association.identity, next as unknown as LogJsonValue, initial.state.revision, 'decision.verified', check); check();
      uncertainCommit = true;
      context.transaction(() => {
        checkBody(); commitState(context, 'decision', key, association.identity, prepared); const verifiedPosition = position();
        const metadata = { kind: 'decision-reconciliation', status: 'verified', decisionIdDigest: digest(options.id), intentIdDigest: digest(options.intentId),
          associationDigest: digest(canonical(association)), inputHash: original.binding.inputHash, authorityHash: original.binding.authorityHash,
          inputVersionDigest: digest(original.binding.inputVersion), authorityVersionDigest: digest(original.binding.authorityVersion), resultHash,
          evidenceDigests: (evidence as string[]).map(digest), original: { ...originalPosition }, verified: { ...verifiedPosition } };
        context.binding.appendInTransaction({ requestId: `reconciliation:${randomUUID()}`, records: [{ identity: association.identity,
          schema: { id: 'oar.execution.reconciliation', version: 1 }, type: 'decision.reconciled', causal: [originalPosition, verifiedPosition], payload: { inline: metadata } }] });
      }, true);
      uncertainCommit = false; return next;
    });
  } catch (error) { failed = true; failure = halted(error); throw failure; }
  finally {
    try {
      if (uncertainCommit) executionFailure('OUTCOME_UNKNOWN');
      context.transaction(() => releaseOwner(context, initial.owner), true);
    } catch (secondary) { throw failed ? new AggregateError([failure, secondary], 'Original effect reconciliation is uncertain', { cause: failure }) : halted(secondary); }
    finally { markOwnerDrained(context, initial.owner); }
  }
}
