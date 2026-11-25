/**
 * Public export audit.
 *
 * This barrel is the package entry point, and it carries exactly what an
 * application needs to: build an `Agent` and drive `Session`s, inspect a
 * negotiated plan, register a control adapter, answer interactions, and
 * enforce a SafetyEnvelope. Everything else is a runtime internal and is
 * deliberately absent, because exporting it would freeze an implementation
 * detail into the compatibility surface:
 *
 * - bounded queues and the two-lane delivery (back-pressure mechanics that
 *   belong to the transports, not to callers);
 * - the Codex JSON-RPC peer, JSONL channel, app-server connection, process
 *   supervisor and identity records;
 * - the pinned Codex wire schemas and the generated-schema validators;
 * - the control adapters' own session, thread, turn, projector and interaction
 *   bridge classes — a control adapter is registered with data through
 *   `ControlAdapterRegistration`, never by importing adapter internals;
 * - executable pinning (`PinnedExecAdapter`, `createExecutablePin`), which is
 *   an implementation detail of readiness.
 *
 * Those modules stay reachable through deep imports so the test suite can
 * exercise them, and unreachable through the package entry so no application
 * can depend on them.
 */

// Agent, sessions, diagnostics and the public vocabulary.
export * from './public/agent.js';
export * from './public/doctor.js';
export * from './public/errors.js';
export { resolveProviderRateLimits, type ProviderRateLimitObservation, type ProviderRateLimitWindow } from './adapters/provider-limits.js';
export { ExecutionHaltedError, isExecutionHalted, rethrowExecutionHalt } from './public/execution-halt.js';
export * from './public/types.js';
export * from './public/memory-types.js';
export { isMemoryLabel, MEMORY_LABEL_MAX, MEMORY_OBSERVED_AT_MAX, profileText, recallableMemory } from './public/memory-items.js';
export * from './session/session.js';

// Transport negotiation and the provider adapter contract. Named exports, not
// `export *`: the wire parsers, argv builders, JSON-line decoders and process
// spawner behind these modules are implementation detail, and publishing them
// by accident would freeze them as API. Tests reach them by deep import.
export type {
  AdapterStreamItem,
  ExecAdapter,
  ExecProbeContext,
  ExecOperation,
  ExecTurnRequest,
  ProcessRunner,
  ProtocolFailure,
  ProtocolFailureKind,
  ProtocolResult,
} from './adapters/provider.js';
export { ClaudeExecAdapter } from './adapters/claude/exec-adapter.js';
/** The parser the Claude exec adapter applies to its JSONL output; public so a consumer can build the same results in its tests. */
export { parseClaudeJsonl } from './adapters/claude/protocol.js';
export type { ClaudeJsonlState } from './adapters/claude/protocol.js';
export { CodexExecAdapter } from './adapters/codex/exec-adapter.js';
export {
  COMPATIBILITY_MANIFEST,
  assessCliCompatibility,
  findCompatibilityEntry,
  validateCompatibilityManifest,
  type CliCompatibilityAssessment,
  type CliHelpProbe,
  type CompatibilityEntry,
} from './compatibility/manifest.js';
export {
  selectTransport,
  type TransportSelectionInput,
} from './core/capabilities.js';
export {
  normalizeContextPolicy,
  translateContext,
  type ContextTranslation,
} from './core/context.js';
export { buildEnvironment } from './core/environment.js';
export { compatibilityModels, resolveModel } from './core/models.js';
export { translatePermissions, type PermissionTranslation } from './core/permissions.js';
export { Runtime, defaultRuntime, type RuntimeOptions } from './core/runtime.js';

// The npx entry point, so a host can embed the same CLI.
export { runCli, type CliIo } from './cli/run-cli.js';
export { resolveBinary, type LaunchTarget } from './process/resolve-binary.js';
export type { ProcessOutcome, ProcessRequest } from './process/run-process.js';

// Registering a control adapter: tokens, the registration record, the
// experimental gates, and the typed messages for a missing transport.
export {
  AdapterRegistry,
  CONTROL_TRANSPORTS,
  EXEC_TRANSPORT_TOKENS,
  RUNTIME_ADAPTER_VERSION,
  assertExperimentalApiEnabled,
  controlSessionUnavailableMessage,
  controlUnavailableMessage,
  experimentalGates,
  type ControlAdapterRegistration,
  type ControlTransportToken,
  type ExecAdapterRegistration,
  type ExecTransportToken,
  type ExperimentalGates,
  type TransportToken,
} from './core/registry.js';

// The seam a control adapter implements for Session to drive.
export {
  toBrokerResponse,
  type ControlForkRequest,
  type ControlSessionFactory,
  type ControlSessionHandle,
  type ControlSessionRequest,
  type ControlSessionState,
  type ControlTurnHandle,
  type ControlTurnRequest,
} from './session/control-session.js';

// Exactly-once interaction settlement, so a third-party control adapter binds
// approvals to a payload and epoch instead of reinventing the ledger.
export {
  InteractionBroker,
  type InteractionHandle,
  // Nombres propios, no alias: la ligadura del broker y la decisión que lo
  // settlea son tipos distintos de los públicos `InteractionBinding`/
  // `InteractionResponse`, y compartir nombre los publicaba desambiguados por
  // un sufijo generado por el bundler.
  type BrokerBinding,
  type BrokerDecision,
} from './control/interaction-broker.js';

// SafetyEnvelope enforcement helpers.
export {
  PERMISSION_MODE_AUTHORITY,
  assertModelAllowed,
  assertPathWithinRoots,
  assertPermissionModeWithinCeiling,
  isModelAllowed,
  isPathWithinRoot,
  isPermissionModeWithinCeiling,
} from './security/safety-envelope.js';

// The two shipped control adapters, as data-only registrations.
export {
  CLAUDE_CONTROL_ADAPTER_VERSION,
  createClaudeControlRegistration,
  type ClaudeControlFactoryOptions,
} from './adapters/claude-control/factory.js';
export { CLAUDE_CONTROL_CAPABILITY_VERDICTS } from './adapters/claude-control/session.js';
export {
  CLAUDE_AGENT_SDK_PACKAGE,
  type ClaudeAgentSdk,
  type SdkPermissionMode,
} from './adapters/claude-control/sdk.js';
export {
  CODEX_CONTROL_ADAPTER_VERSION,
  CODEX_CONTROL_CAPABILITY_VERDICTS,
  createCodexControlRegistration,
  type CodexControlFactoryOptions,
  type CodexControlTransport,
  type CodexTransportStartOptions,
  type CodexTransportStarter,
} from './adapters/codex-control/factory.js';
export type {
  CodexDynamicToolContext,
  CodexDynamicToolDefinition,
} from './adapters/codex-control/dynamic-tools.js';

export type { ProviderRegistration } from './core/provider-registration.js';
export { createGeminiCliProvider, type GeminiCliProviderOptions } from './adapters/gemini/registration.js';
export { createAntigravityCliProvider, type AntigravityCliProviderOptions } from './adapters/antigravity/registration.js';
export { createClaudeProvider, createCodexProvider, createDefaultProviders } from './core/builtin-providers.js';

export type { ApplicationTool, ApplicationToolContext, ApplicationToolScope } from './tools/types.js';
