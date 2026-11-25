import { randomUUID } from 'node:crypto';
import { ExecutionHaltedError, isExecutionHalted } from '../../public/execution-halt.js';
import { jsonClone, nonempty } from '../workflow/checkpoint.js';
import { decisionHash, sameDecisionBinding, snapshotBinding } from './binding.js';
import type { DecisionAuthorization, DecisionEffectContext, DecisionRecord, DecisionRunOptions, DecisionStore } from './types.js';

function authorization(value: DecisionAuthorization): DecisionAuthorization {
  const next = jsonClone(value);
  if (!['allow', 'wait', 'deny'].includes(next.decision) || typeof next.reason !== 'string'
    || !Number.isFinite(next.expiresAt) || (next.nextAt !== undefined && !Number.isFinite(next.nextAt))) throw new Error('Invalid authorization');
  return Object.freeze(next);
}
function preserveHalt(primary: unknown, secondary: unknown): unknown {
  return isExecutionHalted(primary) || isExecutionHalted(secondary)
    ? new AggregateError([primary, secondary], 'Execution halted during decision cleanup', { cause: primary }) : secondary;
}

export function validateDecisionRecord(value: unknown, id: string): DecisionRecord {
  const next = jsonClone(value) as DecisionRecord;
  if (!next || next.format !== 1 || next.id !== id || !['waiting', 'denied', 'intent', 'dispatched', 'verified', 'needs-owner'].includes(next.status)
    || !Number.isSafeInteger(next.attempts) || next.attempts < 0 || typeof next.reason !== 'string') throw new Error('Invalid decision checkpoint');
  snapshotBinding(next.binding);
  if (next.authorization) authorization(next.authorization);
  if (['intent', 'dispatched', 'verified'].includes(next.status) && (!next.intentId || !next.authorization || next.authorization.decision !== 'allow' || next.attempts < 1)) throw new Error('Invalid decision intent');
  if (['dispatched', 'verified'].includes(next.status) && !Object.hasOwn(next, 'result')) throw new Error('Missing decision result');
  if (next.status === 'verified' && (!next.receipt || next.receipt.intentId !== next.intentId || next.receipt.resultHash !== decisionHash(next.result!)
    || !sameDecisionBinding(next.receipt, next.binding) || !Array.isArray(next.receipt.evidence) || !next.receipt.evidence.length
    || !next.receipt.evidence.every(e => typeof e === 'string' && e.trim()))) throw new Error('Invalid verification receipt');
  return next;
}

/**
 * A durable wait/decision around one app-owned effect, not a business workflow.
 * Recovered intents require owner reconciliation; this runner never replays an
 * ambiguous effect. Give reconciled replacement work its own id and authority.
 */
export class DecisionRunner {
  constructor(private readonly store: DecisionStore) {}
  async run(options: DecisionRunOptions): Promise<DecisionRecord> {
    nonempty(options.id, 'Decision id');
    const binding = snapshotBinding(options.binding), signal = options.signal ?? new AbortController().signal;
    const context = Object.freeze({ id: options.id, binding, signal });
    const now = options.now ?? Date.now;
    let observedClock: number | undefined;
    const clock = () => {
      const value = now(); if (!Number.isFinite(value)) throw new Error('Invalid decision clock');
      if (observedClock !== undefined && value < observedClock) throw new ExecutionHaltedError({ sanitizedDiagnostics: { reason: 'DECISION_CLOCK_ROLLBACK' } });
      observedClock = value; return value;
    };
    signal.throwIfAborted();
    const lease = await this.store.acquire(options.id);
    let failed = false, failure: unknown;
    try {
      const loaded = await lease.load();
      let state: DecisionRecord = loaded === undefined ? { format: 1, id: options.id, binding, status: 'waiting', attempts: 0, reason: 'Waiting for condition' } : validateDecisionRecord(loaded, options.id);
      const save = async (next: DecisionRecord) => {
        await lease.save(jsonClone(next)); state = next; return jsonClone(next);
      };
      if (!sameDecisionBinding(state.binding, binding)) {
        return state.status === 'needs-owner' ? jsonClone(state)
          : await save({ ...state, status: 'needs-owner', reason: 'Input or authority version changed; owner reconciliation required' });
      }
      if (state.status === 'verified' || state.status === 'denied' || state.status === 'needs-owner') return jsonClone(state);
      if (state.status === 'intent') return await save({ ...state, status: 'needs-owner', reason: 'Interrupted effect is ambiguous; owner reconciliation required' });
      const verify = async () => {
        const effect: DecisionEffectContext = Object.freeze({ ...context, intentId: state.intentId!, attempt: state.attempts });
        const verdict = await options.verify(jsonClone(state.result!), effect);
        signal.throwIfAborted();
        if (!verdict.verified) return jsonClone(state);
        if (!Array.isArray(verdict.evidence) || !verdict.evidence.length || !verdict.evidence.every(e => typeof e === 'string' && e.trim())) throw new Error('Verified result requires evidence');
        const { inputHash, authorityHash, inputVersion, authorityVersion } = binding;
        return save({ ...state, status: 'verified', reason: 'Result verified', receipt: {
          intentId: state.intentId!, inputHash, authorityHash, inputVersion, authorityVersion,
          approval: state.authorization!, resultHash: decisionHash(state.result!), evidence: [...verdict.evidence], verifiedAt: clock(),
        } });
      };
      if (state.status === 'dispatched') return await verify();
      signal.throwIfAborted();
      clock(); // Establish a floor before callbacks that may await a changed local clock.
      if (state.authorization?.nextAt !== undefined && clock() < state.authorization.nextAt) return jsonClone(state);
      if (options.condition && !await options.condition(context)) {
        signal.throwIfAborted();
        return loaded === undefined ? await save(state) : jsonClone(state);
      }
      signal.throwIfAborted();
      const approval = authorization(await options.authorize(context));
      signal.throwIfAborted();
      if (approval.decision !== 'allow' || approval.expiresAt <= clock()) {
        const next: DecisionRecord = { ...state, authorization: approval,
          status: approval.decision === 'deny' ? 'denied' : 'waiting',
          reason: approval.expiresAt <= clock() ? 'Authorization expired' : approval.reason };
        return loaded !== undefined && JSON.stringify(next) === JSON.stringify(state) ? jsonClone(state) : await save(next);
      }
      await save({ ...state, status: 'intent', authorization: approval, attempts: state.attempts + 1, intentId: randomUUID(), reason: approval.reason });
      // Persistence may yield long enough to invalidate approval; no effect crosses that gap.
      if (signal.aborted || approval.expiresAt <= clock() || options.isCurrent(context) !== true) {
        return await save({ ...state, status: 'needs-owner', reason: 'Authorization expired, changed or cancelled before dispatch; owner reconciliation required' });
      }
      try {
        const result = jsonClone(await options.execute(Object.freeze({ ...context, intentId: state.intentId!, attempt: state.attempts })));
        await save({ ...state, status: 'dispatched', result });
      } catch (error) {
        try { await save({ ...state, status: 'needs-owner', reason: 'Effect failed or persistence is uncertain; owner reconciliation required' }); }
        catch (secondary) { throw preserveHalt(error, secondary); }
        throw error;
      }
      return await verify();
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      try { await lease.release(); } catch (secondary) { throw failed ? preserveHalt(failure, secondary) : secondary; }
    }
  }
}
