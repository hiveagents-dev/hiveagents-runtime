import type { SessionRef } from '../../public/types.js';
import type { DecisionContext, DecisionEffectContext, DecisionRunOptions, DecisionStore } from '../decisions/types.js';
import type { JsonValue } from '../workflow/types.js';

export interface HandoffTarget {
  readonly id: string;
  readonly version: string;
  readonly provider?: string;
  readonly model?: string;
}
export interface TaskHandoffDraft {
  id: string;
  goal: string;
  requirements: readonly string[];
  context: JsonValue;
  source: { id: string; version: string; digest: string; episodeId?: string };
  destination: HandoffTarget;
  /** Provenance only. Never passed to an implicit Agent or native resume operation. */
  sourceSession?: SessionRef;
  evidence: readonly { id: string; digest: string }[];
  artifacts: readonly { uri: string; digest: string }[];
  pending: readonly string[];
  unresolvedEffects: readonly string[];
}
export interface TaskHandoff extends Readonly<TaskHandoffDraft> {
  readonly source: Readonly<TaskHandoffDraft['source']>;
  readonly sourceSession?: Readonly<SessionRef>;
  readonly evidence: readonly Readonly<TaskHandoffDraft['evidence'][number]>[];
  readonly artifacts: readonly Readonly<TaskHandoffDraft['artifacts'][number]>[];
  readonly format: 1;
  readonly digest: string;
}
/** Trusted application port; save must atomically reject an existing id with different content. */
export interface HandoffStore {
  save(handoff: TaskHandoff): Promise<void>;
  load(id: string): Promise<TaskHandoff | undefined>;
}
export interface HandoffContext extends DecisionContext {
  readonly handoff: TaskHandoff;
  readonly target: HandoffTarget;
}
export interface HandoffEffectContext extends DecisionEffectContext {
  readonly handoff: TaskHandoff;
  readonly target: HandoffTarget;
}
export interface HandoffRunOptions {
  id: string;
  handoffId: string;
  store: HandoffStore;
  decisionStore: DecisionStore;
  target: HandoffTarget;
  sourceDigest: string;
  authority: { id: string; version: string };
  authorize(context: HandoffContext): ReturnType<DecisionRunOptions['authorize']>;
  isCurrent(context: HandoffContext): boolean;
  execute(context: HandoffEffectContext): ReturnType<DecisionRunOptions['execute']>;
  verify(result: JsonValue, context: HandoffEffectContext): ReturnType<DecisionRunOptions['verify']>;
  signal?: AbortSignal;
}
