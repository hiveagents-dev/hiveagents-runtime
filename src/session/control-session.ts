import type { ApplicationTool } from '../tools/types.js';
import type { AdapterStreamItem } from '../adapters/provider.js';
import type { BrokerDecision } from '../control/interaction-broker.js';
import type {
  AgentInput,
  CapabilityStatus,
  ContextPolicy,
  InteractionRequest,
  InteractionResponse,
  InterruptReceipt,
  ModelInfo,
  SafetyEnvelope,
  SessionIdentity,
  SessionPersistence,
  SessionRef,
  SteerReceipt,
} from '../public/types.js';

/**
 * Adapter-level liveness of a control session, mirroring the Codex thread
 * registry: 'unknown' means the provider may still hold the session (a
 * persisted session whose transport died) and a reconcile is required before
 * any further turn; 'failed' is terminal (the session died with its process).
 */
export type ControlSessionState = 'active' | 'unknown' | 'failed' | 'closed';

export interface ControlTurnRequest {
  input: AgentInput;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  /** Reaches the provider's interaction broker; absent means "no handler". */
  onInteraction?: (request: InteractionRequest) => Promise<InteractionResponse>;
  providerParams?: Record<string, unknown>;
}

/**
 * One in-flight turn. `stream` carries the same items an exec adapter's
 * `stream()` produces, so `Session` projects both transports through one code
 * path. `steer` is present only on providers whose negotiated capabilities
 * include steering.
 */
export interface ControlTurnHandle {
  readonly stream: AsyncIterable<AdapterStreamItem>;
  interrupt(reason?: string): Promise<InterruptReceipt>;
  steer?(input: AgentInput): Promise<SteerReceipt>;
}

export interface ControlForkRequest {
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: ModelInfo;
  name?: string;
}

/**
 * The seam `Session` drives for a control transport. A registration supplies
 * one of these per session; the runtime core never imports adapter internals.
 */
export interface ControlSessionHandle {
  /** Epoch every SessionRef and interaction binding minted for this session carries. */
  readonly transportEpoch: string;
  /** Known at open time when the provider mints ids eagerly (Codex threads); Claude confirms on the first turn. */
  readonly identity: SessionIdentity | undefined;
  state(): ControlSessionState;
  startTurn(request: ControlTurnRequest): Promise<ControlTurnHandle>;
  respond(interactionId: string, response: InteractionResponse): Promise<void>;
  fork(request: ControlForkRequest): Promise<ControlSessionHandle>;
  close(): Promise<void>;
  /** Optional: re-establish a session left 'unknown' by a transport death. */
  reconcile?(): Promise<ControlSessionState>;
}

export interface ControlSessionRequest {
  /** Host callbacks require explicit control transport gates. */
  tools?: readonly ApplicationTool[];
  model: ModelInfo;
  cwd: string;
  persistence: SessionPersistence;
  env: NodeJS.ProcessEnv;
  /** Immutable authority for this session; a factory may narrow it, never widen it. */
  envelope: SafetyEnvelope;
  capabilities: Record<string, CapabilityStatus>;
  /** Dynamic tools stay gated behind this even when control is enabled. */
  experimentalApi: boolean;
  context?: ContextPolicy;
  instructions?: string;
  effort?: string;
  /** The session must bill the CLI login; factories pin what their CLI lets a config redirect. */
  requireSubscription?: boolean;
  /** Pinned provider executable resolved during readiness. */
  executablePath?: string;
  resume?: SessionRef;
  providerOptions?: Record<string, unknown>;
}

export type ControlSessionFactory =
  (request: ControlSessionRequest) => Promise<ControlSessionHandle>;

/**
 * Projects a public `InteractionResponse` onto the broker's decision record.
 * The broker validates the decision against what the provider advertised, so
 * an unmapped spelling fails there rather than being invented here.
 */
export function toBrokerResponse(response: InteractionResponse): BrokerDecision {
  switch (response.kind) {
    case 'approval':
      return {
        decision: response.decision,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
      };
    case 'user-input':
      return { decision: 'respond', answers: response.answers };
    case 'permission':
      return {
        decision: response.decision,
        ...(response.granted === undefined ? {} : { payload: response.granted }),
      };
    case 'elicitation':
      return {
        decision: response.action,
        ...(response.content === undefined ? {} : { content: response.content }),
      };
    case 'dynamic-tool':
      return response.success
        ? { decision: 'fulfill', ...(response.content === undefined ? {} : { result: response.content }) }
        : { decision: 'fail', ...(response.error === undefined ? {} : { error: response.error }) };
  }
}
