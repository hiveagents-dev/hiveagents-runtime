import { randomUUID } from 'node:crypto';

import type { ControlBufferLimits } from '../../control/event-spool.js';
import { InteractionBroker } from '../../control/interaction-broker.js';
import { CONTROL_TRANSPORTS, type ControlAdapterRegistration } from '../../core/registry.js';
import {
  AgentRuntimeError,
  SessionNotFoundError,
  UnsupportedCapabilityError,
} from '../../public/errors.js';
import type {
  InteractionResponse,
  SessionIdentity,
  SessionPersistence,
  SupportLevel,
} from '../../public/types.js';
import {
  toBrokerResponse,
  type ControlForkRequest,
  type ControlSessionHandle,
  type ControlSessionRequest,
  type ControlSessionState,
  type ControlTurnHandle,
  type ControlTurnRequest,
} from '../../session/control-session.js';
import type { AdapterStreamItem } from '../provider.js';
import { claudeQueryOptions } from './configuration.js';
import { CLAUDE_CONTROL_CAPABILITY_VERDICTS, ClaudeControlSession } from './session.js';
import type { McpToolSchemaLoader } from './tools.js';
import { loadClaudeAgentSdk, type ClaudeAgentSdk, type SdkPermissionMode } from './sdk.js';

export const CLAUDE_CONTROL_ADAPTER_VERSION = '0.1.0';

/**
 * The adapter's own verdicts plus the two fork shapes this factory implements.
 * A fork is a fresh `Query` resuming the parent transcript with
 * `forkSession: true`: with a prompt that is a complete operation, while
 * promptless the child exists but its native id stays unconfirmed until its
 * first turn — hence 'partial', not 'full'. They live here rather than in
 * `CLAUDE_CONTROL_CAPABILITY_VERDICTS` because the fork behaviour belongs to
 * this factory, not to `ClaudeControlSession`.
 */
const CLAUDE_CONTROL_VERDICTS = Object.freeze({
  ...CLAUDE_CONTROL_CAPABILITY_VERDICTS,
  turns: 'full',
  resume: 'full',
  structuredOutput: 'none',
  forkWithPrompt: 'full',
  forkWithoutPrompt: 'partial',
} satisfies Record<string, SupportLevel>);

export interface ClaudeControlFactoryOptions {
  loadMcpSchemas?: McpToolSchemaLoader;
  /** Injected SDK; absent, the optional package is imported on first turn. */
  sdk?: ClaudeAgentSdk;
  loadSdk?: () => Promise<ClaudeAgentSdk>;
  sdkVersion?: string;
  buffering?: ControlBufferLimits;
}

/**
 * The SDK `Query` is the transport. Anything that ends its stream ends the
 * transport too, so a provider-unavailable or protocol failure is treated as
 * transport death; every other typed error (a declined approval, a rejected
 * input) leaves the session usable.
 */
const TRANSPORT_DEATH_CODES = new Set(['PROVIDER_UNAVAILABLE', 'PROTOCOL_ERROR']);

/** How long reconcile() waits for an abandoned turn to drain before answering 'unknown'. */
export const CLAUDE_CONTROL_RECONCILE_GRACE_MS = 5_000;

function permissionMode(ceiling: string | undefined): SdkPermissionMode {
  switch (ceiling) {
    case 'plan':
    case 'acceptEdits':
    case 'bypassPermissions':
      return ceiling;
    default:
      return 'default';
  }
}

class ClaudeControlHandle implements ControlSessionHandle {
  readonly transportEpoch: string;
  identity: SessionIdentity | undefined;
  readonly #session: ClaudeControlSession;
  readonly #broker: InteractionBroker;
  readonly #request: ControlSessionRequest;
  readonly #options: ClaudeControlFactoryOptions;
  readonly #persistence: SessionPersistence;
  #state: ControlSessionState = 'active';

  constructor(input: {
    epoch: string;
    session: ClaudeControlSession;
    broker: InteractionBroker;
    request: ControlSessionRequest;
    options: ClaudeControlFactoryOptions;
    identity?: SessionIdentity;
  }) {
    this.transportEpoch = input.epoch;
    this.#session = input.session;
    this.#broker = input.broker;
    this.#request = input.request;
    this.#options = input.options;
    this.#persistence = input.request.persistence;
    this.identity = input.identity;
  }

  state(): ControlSessionState {
    if (this.#state === 'active' && this.#session.deliveryFailure) return this.#persistence === 'provider' ? 'unknown' : 'failed';
    return this.#state;
  }

  async startTurn(request: ControlTurnRequest): Promise<ControlTurnHandle> {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const inner = this.#session.stream(
      request.input,
      { signal, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.onInteraction === undefined ? {} : { onInteraction: request.onInteraction }) },
    );
    return {
      stream: this.#guard(inner),
      // The SDK acknowledges an interrupt without reporting an outcome, so the
      // receipt stays 'unknown' rather than claiming a terminal it never saw.
      interrupt: () => {
        controller.abort();
        return this.#session.interrupt();
      },
    };
  }

  async *#guard(inner: AsyncIterable<AdapterStreamItem>): AsyncIterable<AdapterStreamItem> {
    try {
      yield* inner;
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : undefined;
      if (this.#session.deliveryFailure || code === undefined || TRANSPORT_DEATH_CODES.has(code)) {
        this.#state = this.#persistence === 'provider' ? 'unknown' : 'failed';
        this.#broker.expireAll(randomUUID());
      }
      throw error;
    }
  }

  async respond(interactionId: string, response: InteractionResponse): Promise<void> {
    await this.#broker.respond(interactionId, toBrokerResponse(response));
  }

  /**
   * The SDK acknowledges an interrupt without reporting the turn's outcome, so
   * a cancelled turn whose result arrives after the runtime's grace leaves the
   * Session 'unknown' while the Query is in fact alive. The runtime keeps
   * draining that turn to its terminal; once the drain has settled the session
   * is active again. A turn still draining answers 'unknown' honestly — the
   * caller may reconcile again — and a dead transport keeps its state.
   */
  async reconcile(): Promise<ControlSessionState> {
    if (this.state() !== 'active') return this.state();
    const idle = await this.#session.awaitIdle(CLAUDE_CONTROL_RECONCILE_GRACE_MS);
    return idle ? 'active' : 'unknown';
  }

  async fork(request: ControlForkRequest): Promise<ControlSessionHandle> {
    if (this.#persistence !== 'provider') {
      throw new UnsupportedCapabilityError(
        { provider: 'claude', transport: 'control', retryable: false },
        'A Claude fork replays a persisted transcript; a process-only session has none',
      );
    }
    const source = this.#session.nativeSessionId;
    if (source === undefined) {
      throw new SessionNotFoundError(
        { provider: 'claude', transport: 'control', retryable: false },
        'Claude cannot fork a session before its first turn confirms a native id',
      );
    }
    return openClaudeControlSession(
      {
        ...this.#request,
        ...(request.model === undefined ? {} : { model: request.model }),
        resume: { ...forkRef(this.#request, source) },
      },
      this.#options,
      true,
    );
  }

  async close(): Promise<void> {
    this.#state = 'closed';
    await this.#session.close();
  }
}

function forkRef(request: ControlSessionRequest, sourceId: string) {
  return {
    schemaVersion: 1 as const,
    provider: 'claude' as const,
    id: sourceId,
    cwd: request.cwd,
    transport: 'control' as const,
    persistence: 'provider' as const,
    createdAt: new Date().toISOString(),
  };
}

export async function openClaudeControlSession(
  request: ControlSessionRequest,
  options: ClaudeControlFactoryOptions = {},
  forkSession = false,
): Promise<ControlSessionHandle> {
  if (request.tools?.length && !request.experimentalApi) throw new UnsupportedCapabilityError(
    { provider: 'claude', transport: 'control', retryable: false }, 'Claude application tools require experimentalApi: true',
  );
  const queryOptions = claudeQueryOptions(request);
  const epoch = randomUUID();
  const broker = new InteractionBroker({ provider: 'claude', epoch });
  const sdk = options.sdk ?? (options.loadSdk ? await options.loadSdk() : await loadClaudeAgentSdk());
  const session = new ClaudeControlSession({
    sessionId: randomUUID(),
    authorityEpoch: request.envelope.authorityEpoch,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(options.loadMcpSchemas === undefined ? {} : { loadMcpSchemas: options.loadMcpSchemas }),
    cwd: request.cwd,
    persistence: request.persistence,
    model: request.model.id,
    permissionMode: permissionMode(request.envelope.permissionModeCeiling),
    broker,
    sdk,
    queryOptions,
    buffering: { ...options.buffering },
    env: request.env as Record<string, string | undefined>,
    ...(request.envelope.modelAllowlist === undefined
      ? {}
      : { allowedModels: request.envelope.modelAllowlist }),
    ...(request.resume === undefined ? {} : { resume: request.resume.id }),
    ...(forkSession ? { forkSession: true } : {}),
    ...(request.executablePath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: request.executablePath }),
  });
  // A fork mints a new native id, so the child stays unidentified until its
  // first turn; a plain resume already knows which transcript it reopened.
  const identity = request.resume === undefined || forkSession
    ? undefined
    : {
        ...request.resume,
        transportEpoch: epoch,
        ...(request.resume.model === undefined ? { model: request.model.id } : {}),
      };
  return new ClaudeControlHandle({
    epoch,
    session,
    broker,
    request,
    options,
    ...(identity === undefined ? {} : { identity }),
  });
}

/**
 * Data-only registration: the core learns the token, verdicts and evidence
 * source from here and never imports the adapter itself.
 */
export function createClaudeControlRegistration(
  options: ClaudeControlFactoryOptions = {},
): ControlAdapterRegistration {
  return {
    token: CONTROL_TRANSPORTS.claude.token,
    provider: 'claude',
    packageName: CONTROL_TRANSPORTS.claude.packageName,
    adapterVersion: CLAUDE_CONTROL_ADAPTER_VERSION,
    capabilityVerdicts: CLAUDE_CONTROL_VERDICTS,
    evidenceSource: 'sdk-capability',
    protocolVersion: 'claude-agent-sdk-query',
    ...(options.sdkVersion === undefined ? {} : { sdkVersion: options.sdkVersion }),
    createSession: (request) => openClaudeControlSession(request, options),
  };
}
