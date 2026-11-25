import type { AgentOptions, AuthStatus, TransportKind } from '../public/types.js';
import type { Runtime } from '../core/runtime.js';
export interface RoutingTask { id: string; version: string; inputDigest: string; tags?: readonly string[] }
export interface RoutingRule { id: string; allTags: readonly string[]; models: readonly string[] }
export interface AutoModelSelection {
  mode: 'auto'; candidates?: readonly string[]; providers?: readonly string[];
  allowUnverifiedModels?: boolean; allowUnknownAuth?: boolean;
  rules?: readonly RoutingRule[]; fallback?: string;
}
export type RoutingAgentDefinition = Omit<AgentOptions, 'model'> & { model: string | AutoModelSelection };
export interface CreateAgentContext {
  runtime: Runtime; receipts: RoutingReceiptStore; id?: string; task?: RoutingTask;
  sourceDigest?: string; signal?: AbortSignal; timeoutMs?: number;
}
export type RoutingCandidateCode = 'READY' | 'NOT_NEEDED' | 'NOT_IN_RULE' | 'PROVIDER_NOT_ALLOWED' |
  'MODEL_UNAVAILABLE' | 'MODEL_UNVERIFIED' | 'CLI_MISSING' | 'AUTH_REQUIRED' | 'AUTH_UNKNOWN' |
  'SUBSCRIPTION_REQUIRED' | 'CLI_UNSUPPORTED' | 'POLICY_UNSUPPORTED' | 'PROBE_FAILED' | 'ABORTED' | 'TIMEOUT';
export interface RoutingCandidate {
  model: string; provider: string; modelId: string; status: 'eligible' | 'excluded' | 'not-evaluated'; code: RoutingCandidateCode;
  transport?: TransportKind; fingerprintDigest?: string; authState?: 'authenticated' | 'not-authenticated' | 'unknown'; authSource?: AuthStatus['source'];
}
export interface RoutingSelected { model: string; provider: string; modelId: string; transport: TransportKind; fingerprintDigest: string }
export interface RoutingReceipt {
  format: 1; purpose: 'selection-proposal'; id: string; createdAt: number; configDigest: string; taskDigest: string;
  sourceDigest?: string; policy: { mode: 'fixed' | 'auto'; version: 'priority-v1'; ruleId?: string };
  decision: 'selected' | 'abstained'; reason: 'FIXED' | 'PRIORITY' | 'RULE' | 'FALLBACK' | 'NO_CANDIDATES' |
    'NO_ELIGIBLE_CANDIDATE' | 'NO_MATCHING_RULE' | 'ABORTED' | 'TIMEOUT';
  candidates: readonly RoutingCandidate[]; nativeDispatches: 0; selected?: RoutingSelected; digest: string;
}
/** Implementations must atomically reject every existing ID, including identical proposals. */
export interface RoutingReceiptStore { save(receipt: RoutingReceipt): Promise<void>; load(id: string): Promise<RoutingReceipt | undefined> }
export class RoutingSelectionError extends Error {
  constructor(readonly code: 'NO_ROUTE' | 'ABORTED' | 'TIMEOUT', readonly receipt: RoutingReceipt) {
    super(`Routing selection ${code}`); this.name = 'RoutingSelectionError';
  }
}
