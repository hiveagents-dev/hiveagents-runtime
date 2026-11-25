import type { ApplicationTool } from '../tools/types.js';
import type { LaunchTarget } from '../process/resolve-binary.js';
import type { MemoryOption } from './memory-types.js';
import type { PinnedOption } from './pinned-types.js';

export type { PinnedOption, PinnedTurnNote } from './pinned-types.js';

export type BuiltinProviderId = 'claude' | 'codex';
export type ProviderId = BuiltinProviderId | (string & {});
export type TransportKind = 'exec' | 'control';
export type TransportPreference = 'auto' | TransportKind;
export type SessionPersistence = 'provider' | 'process';

export type SessionState =
  | 'opening' | 'idle' | 'running' | 'interrupted' | 'unknown' | 'failed' | 'closing' | 'closed';

export interface ContextPolicy {
  profile?: 'native' | 'project' | 'clean';
  memory?: 'inherit' | 'off' | 'read-only';
}

export interface PermissionIntent {
  /** respond: Claude exec only, clean context, explicit non-coding prompt and no filesystem tools. */
  mode: 'analyze' | 'respond' | 'edit' | 'unrestricted';
  network?: 'deny' | 'allow';
  additionalDirectories?: string[];
  minimumEnforcement?: 'harness' | 'sandbox' | 'external';
  strict?: boolean;
}

export interface EnvironmentPolicy {
  mode: 'inherit' | 'minimal' | 'explicit';
  variables?: Record<string, string>;
  passthrough?: string[];
}

export type CapabilityRequirement = boolean | 'required' | 'preferred';

export interface CapabilityRequirements {
  interactiveApprovals?: CapabilityRequirement;
  userInputDuringTurn?: CapabilityRequirement;
  steering?: CapabilityRequirement;
  inProcessTools?: CapabilityRequirement;
  processPersistence?: CapabilityRequirement;
  messageDeltas?: CapabilityRequirement;
  /** @deprecated Use messageDeltas; provider chunks are not token boundaries. */
  tokenDeltas?: CapabilityRequirement;
  dynamicPermissions?: CapabilityRequirement;
  sessionInspection?: CapabilityRequirement;
  checkpointOrRollback?: CapabilityRequirement;
  subagentLifecycle?: CapabilityRequirement;
  subagentMessages?: CapabilityRequirement;
  subagentDeltas?: CapabilityRequirement;
  refusalDetection?: CapabilityRequirement;
  /** Fork nativo confirmando el hijo con un primer turn; ambos exec CLIs lo soportan. */
  forkWithPrompt?: CapabilityRequirement;
  /** Fork sin prompt: sólo control transports; ningún exec CLI lo soporta. */
  forkWithoutPrompt?: CapabilityRequirement;
  images?: CapabilityRequirement;
  files?: CapabilityRequirement;
}

export type CapabilitySupport = 'supported' | 'partial' | 'unsupported' | 'unverified';
export type SupportLevel = 'full' | 'partial' | 'none' | 'unknown';
export type CapabilityEvidenceSource =
  | 'live-handshake'
  | 'generated-schema'
  | 'sdk-capability'
  | 'compatibility-manifest';

export interface CapabilityStatus {
  support: SupportLevel;
  detail?: string;
  evidence: Array<{ source: CapabilityEvidenceSource; fingerprint: string }>;
}

export type PermissionModeCeiling = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export interface SafetyEnvelope {
  authorityEpoch: string;
  filesystem: { readonlyRoots: string[]; writableRoots: string[] };
  network: Array<{ protocol: 'http' | 'https' | 'tcp'; host: string; ports?: number[] }>;
  tools: string[];
  executables: string[];
  mcpServers: string[];
  environmentVariables: string[];
  settingsPersistence: 'none' | 'session' | 'durable';
  enforcedBy: Array<'harness' | 'sandbox' | 'external'>;
  /** Highest permission mode a session may adopt; absent means unrestricted. */
  permissionModeCeiling?: PermissionModeCeiling;
  /** Models a session may switch to; absent means unrestricted, empty denies all. */
  modelAllowlist?: string[];
}

export interface NegotiatedPlan {
  provider: ProviderId;
  transport: TransportKind;
  fingerprint: {
    adapterVersion: string;
    cliVersion: string;
    executableRealpath: string;
    executableDigest?: string;
  launchIdentityDigest?: string;
    protocolVersion?: string;
    sdkVersion?: string;
  };
  capabilities: Record<string, CapabilityStatus>;
  envelope: SafetyEnvelope;
  warnings: RuntimeWarning[];
}

export interface CapabilityReport {
  provider: ProviderId;
  transport: TransportKind;
  features: Record<string, CapabilitySupport>;
  unsupported: string[];
  warnings: RuntimeWarning[];
  contextSources: ContextSourceReport;
  enforcement?: EnforcementReport;
}

export interface ContextSourceReport {
  profile: 'native' | 'project' | 'clean';
  memory: 'inherit' | 'off' | 'read-only';
  active: string[];
  inactive: string[];
  unavoidable: string[];
  unknown: string[];
}

export interface EnforcementReport {
  requested: PermissionIntent;
  effective: {
    filesystem: string;
    network: string;
    approvals: string;
    enforcedBy: Array<'harness' | 'sandbox' | 'external'>;
  };
  unsupported: string[];
  warnings: string[];
}

export interface ProviderOptions {
  external?: Record<string, Record<string, unknown>>;
  claude?: {
    /** Replace the CLI coding persona for non-coding workflows; append preserves it. */
    systemPromptMode?: 'append' | 'replace';
    settings?: string | Record<string, unknown>;
    mcpConfigs?: string[];
    /** Exec transport only: built-in tool names. [] emits --tools ""; MCP is governed separately. */
    tools?: string[];
    /** Exec transport only: restrict MCP to mcpConfigs; an empty server map disables MCP. */
    strictMcpConfig?: boolean;
  };
  codex?: {
    config?: Record<string, unknown>;
    skipGitRepoCheck?: boolean;
    /** Exec transport only: `--ignore-user-config`, the owner's `$CODEX_HOME/config.toml` is not loaded (auth still is). */
    ignoreUserConfig?: boolean;
    /** Exec transport only: `--ignore-rules`, no execpolicy `.rules` file is loaded. */
    ignoreRules?: boolean;
    /** Exec transport only: `--ephemeral`, no session files are written, so the session cannot be resumed. */
    ephemeral?: boolean;
  };
  /** Opt-in gate for control transports; never implied by experimentalApi. */
  experimentalControl?: boolean;
  /** Opt-in gate for dynamic tools; never implied by experimentalControl. */
  experimentalApi?: boolean;
}

export interface AgentOptions {
  /** Host callbacks require explicit control transport gates. */
  tools?: readonly ApplicationTool[];
  model: string;
  cwd?: string;
  instructions?: string;
  effort?: string;
  transport?: TransportPreference;
  context?: ContextPolicy;
  permissions?: PermissionIntent;
  environment?: EnvironmentPolicy;
  capabilities?: CapabilityRequirements;
  providerOptions?: ProviderOptions;
  requireAuth?: 'any' | 'subscription';
  /** Opt-in pinned constraints on every turn. See `PinnedOption`. */
  pinned?: PinnedOption;
  /**
   * Opt-in per-agent memory: recalled items reach each turn as reference data, never as
   * instructions. Absent, the Runtime's default applies; `false` opts out of it. See `MemoryOption`.
   */
  memory?: MemoryOption | false;
}

export interface SessionOptions {
  persistence?: SessionPersistence;
  resume?: SessionRef;
  name?: string;
}

export interface SessionRef {
  schemaVersion: 1;
  provider: ProviderId;
  id: string;
  model?: string;
  cwd: string;
  transport: TransportKind;
  persistence: SessionPersistence;
  /** @deprecated Legacy refs may omit the transport epoch. */
  transportEpoch?: string;
  cliVersion?: string;
  createdAt: string;
}

export interface SessionIdentity extends SessionRef {
  transportEpoch: string;
  sessionId?: string;
  forkedFromId?: string;
  parentSessionId?: string;
}

export interface PersistedSessionRef extends SessionIdentity {
  persistence: 'provider';
}

export type AgentInput =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; path: string }
      | { type: 'file'; path: string }
    >;

export interface InteractionBinding {
  interactionId: string;
  provider: ProviderId;
  transportEpoch: string;
  providerRequestId?: string | number;
  method: string;
  sessionId: string;
  turnId?: string;
  itemId?: string;
  payloadDigest: string;
  expiresAt?: string;
}

export interface InteractionBase {
  binding: InteractionBinding;
  availableDecisions: readonly string[];
  signal: AbortSignal;
}

export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  secret?: boolean;
  allowOther?: boolean;
  multiple?: boolean;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export type InteractionRequest =
  | (InteractionBase & { kind: 'command-approval'; command?: unknown; cwd?: unknown })
  | (InteractionBase & { kind: 'file-change-approval'; paths?: unknown })
  | (InteractionBase & { kind: 'network-approval'; destination?: unknown })
  | (InteractionBase & { kind: 'tool-approval'; toolName: string; input?: unknown })
  | (InteractionBase & { kind: 'permission'; requested: unknown })
  | (InteractionBase & { kind: 'user-input'; questions: UserQuestion[] })
  | (InteractionBase & { kind: 'elicitation'; serverName: string; schema?: object })
  | (InteractionBase & { kind: 'dynamic-tool'; toolName: string; arguments: unknown });

export type InteractionResponse =
  | { kind: 'approval'; decision: string; reason?: string }
  | { kind: 'user-input'; answers: Record<string, string[]> }
  | { kind: 'permission'; decision: string; granted?: unknown }
  | { kind: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: unknown }
  | { kind: 'dynamic-tool'; success: boolean; content?: unknown; error?: string };

export interface TurnOptions {
  signal?: AbortSignal;
  signalBehavior?: 'interrupt' | 'detach';
  /** Exec only: retain the operation until actual adapter work and cleanup settle after abort.
   * Defaults to false (bounded cleanup). Noncooperative work can keep it pending indefinitely.
   * Control turns reject true before dispatch. */
  awaitSettlement?: boolean;
  /**
   * Turn deadline in milliseconds: an integer in 1..2^31-1 (Node timers clamp
   * anything else to 1 ms). Defaults to 600 000. Out of range throws a
   * RangeError before the turn starts, on the exec and control paths alike.
   */
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  onInteraction?: (request: InteractionRequest) => Promise<InteractionResponse>;
}

export interface TurnToken {
  readonly value: string;
}

export interface InterruptReceipt {
  requested: boolean;
  terminal: 'interrupted' | 'completed' | 'failed' | 'unknown';
}

export interface SteerReceipt {
  accepted: boolean;
  turnId?: string;
}

export interface TurnHandle {
  readonly token: TurnToken;
  readonly turnId: Promise<string | undefined>;
  /** Live single-consumer events; a lag beyond 4096 events/64 MiB fails this observer with OUTPUT_LIMIT without cancelling result. */
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<Turn>;
  interrupt(reason?: string): Promise<InterruptReceipt>;
  detach(): void;
  respond(interactionId: string, response: InteractionResponse): Promise<void>;
  /**
   * Present only when the negotiated capabilities include steering. Its
   * absence is the capability answer: no probing, no throwing stub.
   */
  steer?(input: AgentInput): Promise<SteerReceipt>;
}

export interface OneShotOptions extends TurnOptions {
  context?: ContextPolicy;
}

export interface ForkOptions extends TurnOptions {
  model?: string;
  name?: string;
}

export interface RuntimeWarning {
  code: string;
  message: string;
  providerMetadata?: unknown;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reportedCostUsd?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  perModel?: Record<string, ModelUsage>;
  reportedCostUsd?: number;
  costMeaning: 'provider-reported' | 'api-equivalent' | 'estimate' | 'unavailable';
}

export interface Turn {
  id?: string;
  session: SessionIdentity;
  /**
   * 'refused' comes only from a native provider refusal signal, never inferred from text. No built-in
   * transport nor the Gemini/Antigravity adapters has an evidenced signal today, so none returns it;
   * their `refusalDetection` capability says 'unsupported' or 'none'.
   */
  status: 'completed' | 'failed' | 'interrupted' | 'refused';
  text: string;
  output?: unknown;
  usage?: Usage;
  events: AgentEvent[];
  warnings: RuntimeWarning[];
  providerMetadata: unknown;
}

export type AgentEvent =
  | { type: 'session.started'; session: SessionRef }
  | { type: 'turn.started'; turnId?: string }
  | { type: 'message.delta'; text: string }
  | { type: 'message.completed'; text: string }
  | { type: 'tool.started'; id: string; name: string; input?: unknown }
  | { type: 'tool.updated'; id: string; update: unknown }
  | { type: 'tool.completed'; id: string; output?: unknown; error?: unknown }
  | { type: 'interaction.requested'; request: InteractionRequest }
  | { type: 'subagent.started'; id: string; metadata?: unknown }
  | { type: 'subagent.completed'; id: string; metadata?: unknown }
  | { type: 'context.compacted'; metadata?: unknown }
  | { type: 'turn.completed'; turn: Turn }
  | { type: 'provider.event'; provider: ProviderId; event: unknown };

export interface AuthStatus {
  authenticated: boolean;
  source: 'subscription' | 'api-key' | 'cloud-provider' | 'oauth' | 'oss' | 'unknown';
  state?: 'authenticated' | 'not-authenticated' | 'unknown';
  evidence?: 'provider-status' | 'local-configuration' | 'turn-result';
  account?: { plan?: string };
}

export interface ProviderInstallation {
  launchTarget?: LaunchTarget;
  identityFiles?: string[];
  installed: boolean;
  path?: string;
  realpath?: string;
  version?: string;
}

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  aliases: string[];
  source: 'agent-sdk' | 'app-server' | 'compatibility-catalog' | 'explicit';
  availability: 'available' | 'unavailable' | 'unverified';
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportedEffort?: string[];
}

export interface ModelCatalog {
  provider: ProviderId;
  source: ModelInfo['source'];
  models: ModelInfo[];
  fetchedAt: string;
}

export interface AgentReadinessOptions {
  signal?: AbortSignal;
  /** Fresh preparation budget in milliseconds; defaults to 600000. */
  timeoutMs?: number;
  /** Wait for actual pending probe settlement after cancellation or timeout. */
  awaitSettlement?: boolean;
}

export interface AgentReadiness {
  ready: boolean;
  provider: ProviderId;
  model: ModelInfo;
  installation: ProviderInstallation;
  auth: AuthStatus;
  capabilities: CapabilityReport;
  plan: NegotiatedPlan;
}

export interface ProviderDoctorReport {
  provider: ProviderId;
  installation: ProviderInstallation;
  auth: AuthStatus;
  transports: Array<{ kind: TransportKind; available: boolean; detail?: string }>;
  models: ModelCatalog;
  memory: 'active' | 'inactive' | 'unknown';
  instructionSources: string[];
  warnings: RuntimeWarning[];
  fingerprint?: NegotiatedPlan['fingerprint'];
  capabilityEvidence?: Record<
    string,
    { support: SupportLevel; sources: CapabilityEvidenceSource[] }
  >;
}

export interface DoctorReport {
  generatedAt: string;
  providers: ProviderDoctorReport[];
}
