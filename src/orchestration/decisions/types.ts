import type { JsonValue } from '../workflow/types.js';

export interface DecisionBinding {
  readonly input: JsonValue;
  readonly inputHash: string;
  readonly authorityHash: string;
  readonly inputVersion: string;
  readonly authorityVersion: string;
}
export interface DecisionAuthorization {
  decision: 'allow' | 'wait' | 'deny';
  reason: string;
  /** Epoch milliseconds; checked again after async authorization and durable intent persistence. */
  expiresAt: number;
  nextAt?: number;
}
export interface DecisionReceipt {
  intentId: string;
  inputHash: string;
  authorityHash: string;
  inputVersion: string;
  authorityVersion: string;
  approval: DecisionAuthorization;
  resultHash: string;
  evidence: string[];
  verifiedAt: number;
}
export interface DecisionRecord {
  format: 1;
  id: string;
  binding: DecisionBinding;
  status: 'waiting' | 'denied' | 'intent' | 'dispatched' | 'verified' | 'needs-owner';
  attempts: number;
  reason: string;
  authorization?: DecisionAuthorization;
  intentId?: string;
  result?: JsonValue;
  receipt?: DecisionReceipt;
}
/** App-owned, exclusive for the entire run including callback drainage. No expiry-based takeover. */
export interface DecisionLease {
  load(): Promise<unknown | undefined>;
  /** Atomic durable replacement; rejection must never be reported as a completed effect. */
  save(record: DecisionRecord): Promise<void>;
  release(): Promise<void>;
}
export interface DecisionStore { acquire(id: string): Promise<DecisionLease> }
export interface DecisionContext {
  readonly id: string;
  readonly binding: DecisionBinding;
  readonly signal: AbortSignal;
}
export interface DecisionEffectContext extends DecisionContext {
  readonly intentId: string;
  readonly attempt: number;
}
export interface DecisionRunOptions {
  id: string;
  binding: DecisionBinding;
  signal?: AbortSignal;
  now?: () => number;
  /** App condition only; a true condition never grants authority. */
  condition?: (context: DecisionContext) => boolean | Promise<boolean>;
  /** Trusted application port; called afresh immediately before every new dispatch. */
  authorize(context: DecisionContext): DecisionAuthorization | Promise<DecisionAuthorization>;
  /** Synchronous trusted check of live input/authority identity after persistence, immediately before dispatch.
   * execute must check again at its own effect boundary if it awaits other work first. */
  isCurrent(context: DecisionContext): boolean;
  execute(context: DecisionEffectContext): JsonValue | Promise<JsonValue>;
  verify(result: JsonValue, context: DecisionEffectContext): { verified: boolean; evidence: readonly string[] }
    | Promise<{ verified: boolean; evidence: readonly string[] }>;
}
