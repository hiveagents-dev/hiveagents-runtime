import { handoffDecisionInput } from './inspection.js';
import { bindDecision } from '../decisions/binding.js';
import { DecisionRunner } from '../decisions/runner.js';
import type { DecisionContext, DecisionEffectContext, DecisionRecord } from '../decisions/types.js';
import { digest, fields, freeze, identifier, snapshotHandoff, snapshotTarget } from './bundle.js';
import type { HandoffContext, HandoffEffectContext, HandoffRunOptions } from './types.js';

/** One application effect, exclusively executed by DecisionRunner. References never grant authority. */
export async function runHandoff(options: HandoffRunOptions): Promise<DecisionRecord> {
  const { id, handoffId, store, decisionStore, sourceDigest, signal, authorize, isCurrent, execute, verify } = options;
  signal?.throwIfAborted(); identifier(id); identifier(handoffId); digest(sourceDigest);
  const target = snapshotTarget(options.target);
  const rawAuthority = fields(options.authority, ['id', 'version']);
  identifier(rawAuthority.id); identifier(rawAuthority.version);
  const authority = freeze({ id: rawAuthority.id, version: rawAuthority.version });
  const loaded = await store.load(handoffId);
  signal?.throwIfAborted();
  if (loaded === undefined) throw Error('Handoff not found');
  const handoff = snapshotHandoff(loaded, handoffId);
  if (handoff.source.digest !== sourceDigest) throw Error('Handoff source digest changed');
  const targetKeys = ['id', 'version', 'provider', 'model'] as const;
  if (targetKeys.some(key => target[key] !== handoff.destination[key])) throw Error('Handoff destination does not match target');
  if (handoff.unresolvedEffects.length) throw Error('Handoff has unresolved ambiguous effects; owner reconciliation required');
  const binding = bindDecision({
    input: handoffDecisionInput(handoff),
    inputVersion: 'task-handoff:1', authority, authorityVersion: authority.version,
  });
  const context = (value: DecisionContext): HandoffContext => Object.freeze({ ...value, handoff, target });
  const effect = (value: DecisionEffectContext): HandoffEffectContext => Object.freeze({ ...value, handoff, target });
  return new DecisionRunner(decisionStore).run({ id, binding, ...(signal === undefined ? {} : { signal }),
    authorize: value => authorize(context(value)), isCurrent: value => isCurrent(context(value)),
    execute: value => execute(effect(value)),
    verify: (result, value) => { value.signal.throwIfAborted(); return verify(result, effect(value)); },
  });
}
