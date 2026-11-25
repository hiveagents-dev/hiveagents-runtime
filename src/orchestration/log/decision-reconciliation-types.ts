import type { DecisionBinding, DecisionRecord } from '../decisions/types.js';
import type { JsonValue } from '../workflow/types.js';
import type { CapturedEffectAssociation } from './execution-types.js';
/** Trusted app-owned original-target verification only; never an execution or Host stopped-work proof. */
export interface DecisionReconciliationOptions {
  readonly id: string; readonly intentId: string; readonly binding: DecisionBinding;
  readonly verifyApplied: (context: Readonly<{ association: CapturedEffectAssociation; record: Readonly<DecisionRecord> }>) =>
    Readonly<{ verified: boolean; result?: JsonValue; evidence: readonly string[] }>
    | Promise<Readonly<{ verified: boolean; result?: JsonValue; evidence: readonly string[] }>>;
}
