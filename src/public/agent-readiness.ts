import { types } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { ExecAdapter, ExecProbeTurn } from '../adapters/provider.js';
import type { CliCompatibilityAssessment } from '../compatibility/manifest.js';
import { OperationScope } from '../control/operation-scope.js';
import { validateSettlementOption } from '../control/exec-settlement.js';
import { validateTimeoutMs } from '../process/run-process.js';
import { selectTransport } from '../core/capabilities.js';
import { freeze } from '../shared/json.js';
import { buildEnvironment } from '../core/environment.js';
import { assertRespondCompatibility, assertRespondAuth } from '../core/respond-policy.js';
import { createExecutablePin, experimentalGates, PinnedExecAdapter, type ExecReprobe } from '../core/registry.js';
import type { Runtime } from '../core/runtime.js';
import { SubscriptionExecAdapter } from '../core/subscription-exec.js';
import { authenticationState, hasConfirmedSubscription, isAuthenticationConfirmed } from '../core/auth-evidence.js';
import { buildSafetyEnvelope, negotiateCapabilities, controlFeatures } from '../session/negotiation.js';
import { buildExecFeatures } from '../session/exec-capabilities.js';
import { envelopeMcpServers } from '../session/mcp-envelope.js';
import { CliNotInstalledError, NotAuthenticatedError, UnexpectedAuthSourceError, UnsupportedCliVersionError, UnsupportedCapabilityError } from './errors.js';
import type { AgentOptions, AgentReadiness, AgentReadinessOptions, CapabilityReport, CapabilityStatus, ModelInfo, NegotiatedPlan, PermissionIntent, RuntimeWarning, SessionPersistence } from './types.js';

export interface PreparedAgent {
  readonly readiness: AgentReadiness;
  readonly launchPlan: NegotiatedPlan;
  cwd: string;
  permissions: PermissionIntent;
  sessionAdapter: ExecAdapter;
}

/** Preparation has no session side effects; callers choose whether to retain its result. */
export async function prepareAgent(
  options: Readonly<AgentOptions>, runtime: Runtime, model: ModelInfo,
  persistence: SessionPersistence = 'provider', scope?: OperationScope,
): Promise<PreparedAgent> {
  const probe = async <T>(work: () => Promise<T> | T): Promise<T> => scope ? scope.race(work) : work();
  let sessionAdapter: ExecAdapter;
  const transport = agentTransport(options, runtime, model.provider, persistence);
  runtime.registration(model.provider).validateOptions(options, transport);
  const cwd = await probe(() => realpath(options.cwd ?? process.cwd()));
  const requestedPermissions = options.permissions ?? { mode: 'analyze' };
  const directories = requestedPermissions.additionalDirectories;
  const additionalDirectories = directories
    ? await Promise.all(directories.map((directory) => probe(() => realpath(directory))))
    : undefined;
  const permissionsIntent: PermissionIntent = {
    ...requestedPermissions,
    ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
  };
  const adapter = runtime.adapter(model.provider);
  const env = agentEnvironment(options);
  const installation = await probe(() => adapter.detect(env, scope));
  if (!installation.installed) {
    throw new CliNotInstalledError(model.provider, { retryable: false });
  }
  const providerOptions = model.provider === 'claude' ? options.providerOptions?.claude
    : model.provider === 'codex' ? options.providerOptions?.codex : options.providerOptions?.external?.[model.provider];
  const authTurn: ExecProbeTurn | undefined = options.requireAuth === 'subscription'
    ? { cwd, contextArgs: runtime.registration(model.provider).translateContext(options.context).args,
      ...(providerOptions === undefined ? {} : { providerOptions }) }
    : undefined;
  const auth = await probe(() => adapter.auth(env, scope, authTurn));
  if (!isAuthenticationConfirmed(auth)
    && !(authenticationState(auth) === 'unknown' && options.requireAuth !== 'subscription')) {
    throw new NotAuthenticatedError(model.provider, {
      retryable: false,
      ...(installation.version === undefined ? {} : { cliVersion: installation.version }),
    });
  }
  const compatibility: CliCompatibilityAssessment | undefined = installation.version
    ? await probe(() => adapter.compatibility?.(env, installation.version!, scope))
    : undefined;
  if (transport === 'exec' && installation.version && compatibility?.features.turns === 'unsupported') {
    throw new UnsupportedCliVersionError(model.provider, installation.version, {
      provider: model.provider,
      transport: 'exec',
      cliVersion: installation.version,
      retryable: false,
      sanitizedDiagnostics: { missingFlags: compatibility.missingFlags },
    });
  }
  if (options.requireAuth === 'subscription' && !hasConfirmedSubscription(auth)) {
    throw new UnexpectedAuthSourceError(model.provider, {
      retryable: false,
      sanitizedDiagnostics: { detectedSource: auth.source },
    });
  }
  if (options.effort && model.supportedEffort
    && !model.supportedEffort.includes(options.effort)) {
    throw new UnsupportedCapabilityError(
      { provider: model.provider, transport: 'exec', retryable: false },
      `Effort "${options.effort}" is not supported by ${model.id}`,
    );
  }
  const context = runtime.registration(model.provider).translateContext(options.context);
  const permissions = runtime.registration(model.provider).translatePermissions(
    permissionsIntent,
    transport,
  );
  assertRespondCompatibility(options, compatibility);
  const unsupported = [...context.unsupported, ...permissions.report.unsupported];
  if (options.permissions?.strict !== false && unsupported.length > 0) {
    throw new UnsupportedCapabilityError(
      { provider: model.provider, transport, retryable: false },
      `Requested policy cannot be enforced: ${unsupported.join(', ')}`,
    );
  }
  const compatibilityWarnings: RuntimeWarning[] = compatibility === undefined
    ? [{ code: 'COMPATIBILITY_NOT_PROBED', message: 'CLI help capabilities were not probed' }]
    : compatibility.evidence === 'live-contract'
      ? []
      : [{
          code: compatibility.missingFlags.length > 0 ? 'CLI_FLAGS_MISSING' : 'HELP_PROBED_ONLY',
          message: compatibility.missingFlags.length > 0
            ? `Installed CLI is missing flags: ${compatibility.missingFlags.join(', ')}`
            : `${model.provider} ${installation.version ?? 'unknown'} is help-probed but not live-contract verified`,
        }];
  const capabilities: CapabilityReport = {
    provider: model.provider,
    transport,
    features: buildExecFeatures(compatibility?.features, model.provider, !!adapter.stream),
    unsupported,
    warnings: [
      ...(auth.state === 'unknown' ? [{ code: 'AUTH_UNVERIFIED', message: 'Authentication is unverified; the requested turn will confirm it' }] : []),
      ...context.warnings.map((message) => ({ code: 'CONTEXT_PARTIAL', message })),
      ...compatibilityWarnings,
    ],
    contextSources: context.report,
    enforcement: permissions.report,
  };
  const executableRealpath = installation.realpath ?? installation.path ?? '';
  const fingerprint = `${model.provider}:${installation.version ?? 'unknown'}:${executableRealpath}`;
  const controlRegistration = runtime.controlRegistration(model.provider);
  if (transport === 'control' && controlRegistration) capabilities.features = controlFeatures(controlRegistration);
  const negotiatedCapabilities = negotiateCapabilities({
    transport,
    registration: controlRegistration,
    features: capabilities.features,
    fingerprint,
  });
  assertRequiredCapabilities(options, model, negotiatedCapabilities, transport);
  const requireSubscription = (exec: ExecAdapter) => transport === 'exec' && options.requireAuth === 'subscription'
    ? new SubscriptionExecAdapter(exec) : exec;
  const pin = await probe(() => createExecutablePin(installation.launchTarget?.command ?? executableRealpath, installation.version, { target: installation.launchTarget, identityFiles: installation.identityFiles }));
  if (pin) {
    const pinnedBase = runtime.adapterWithTarget(model.provider, pin.launchTarget ?? { command: pin.realpath, argsPrefix: [] });
    const reprobe: ExecReprobe = async (probeEnv, previous, context) => {
      const probed = await pinnedBase.detect(probeEnv, context);
      if (!probed.installed) {
        throw new CliNotInstalledError(model.provider, { retryable: false });
      }
      {
        const version = probed.version ?? previous.cliVersion ?? 'unknown';
        const reassessed = await pinnedBase.compatibility?.(probeEnv, version, context);
        assertRespondCompatibility(options, reassessed);
        assertRequiredCapabilities(options, model, negotiateCapabilities({
          transport,
          registration: controlRegistration,
          features: buildExecFeatures(reassessed?.features, model.provider, !!pinnedBase.stream),
          fingerprint,
        }), transport);
        if (options.permissions?.mode === 'respond') assertRespondAuth(options, await pinnedBase.auth(probeEnv, context, authTurn));
        if (reassessed?.features.turns === 'unsupported') {
          throw new UnsupportedCliVersionError(model.provider, version, {
            provider: model.provider,
            transport: 'exec',
            cliVersion: version,
            retryable: false,
            sanitizedDiagnostics: { missingFlags: reassessed.missingFlags },
          });
        }
      }
      const next = await createExecutablePin(
        probed.launchTarget?.command ?? probed.realpath ?? probed.path ?? previous.realpath,
        probed.version ?? previous.cliVersion,
        { target: probed.launchTarget ?? previous.launchTarget, identityFiles: probed.identityFiles ?? previous.identityFiles?.map((file) => file.realpath) },
      );
      if (!next) throw new CliNotInstalledError(model.provider, { retryable: false });
      return next;
    };
    sessionAdapter = new PinnedExecAdapter(requireSubscription(pinnedBase), pin, reprobe);
  } else {
    sessionAdapter = requireSubscription(adapter);
  }
  const envelope = buildSafetyEnvelope({
    tools: [...(permissionsIntent.mode === 'respond' ? options.providerOptions?.claude?.tools ?? [] : []),
      ...(options.tools ?? []).map(tool => tool.name)],
    mcpServers: envelopeMcpServers({
      provider: model.provider, transport, cwd, providerOptions,
      contextArgs: context.args, permissionArgs: permissions.args, applicationTools: options.tools?.length ?? 0,
    }),
    cwd,
    permissions: permissionsIntent,
    environmentVariables: Object.keys(env),
    executableRealpath,
    modelId: model.id,
    enforcedBy: permissions.report.effective.enforcedBy,
  });
  const readiness: AgentReadiness = {
    ready: true,
    provider: model.provider,
    model,
    installation,
    auth,
    capabilities,
    plan: {
      provider: model.provider,
      transport,
      fingerprint: {
        adapterVersion: transport === 'control' && controlRegistration
          ? controlRegistration.adapterVersion
          : runtime.registration(model.provider).exec.adapterVersion,
        cliVersion: installation.version ?? 'unknown',
        executableRealpath: pin?.realpath ?? executableRealpath,
        ...(pin === undefined ? {} : { executableDigest: pin.digest }),
        ...(pin?.launchIdentityDigest === undefined ? {} : { launchIdentityDigest: pin.launchIdentityDigest }),
        ...(transport === 'control' && controlRegistration?.protocolVersion !== undefined
          ? { protocolVersion: controlRegistration.protocolVersion }
          : {}),
        ...(transport === 'control' && controlRegistration?.sdkVersion !== undefined
          ? { sdkVersion: controlRegistration.sdkVersion }
          : {}),
      },
      capabilities: negotiatedCapabilities,
      envelope,
      warnings: capabilities.warnings,
    },
  };
  const launchPlan = freeze(structuredClone(readiness.plan));
  return { cwd, permissions: permissionsIntent, sessionAdapter, launchPlan, readiness: freeze(structuredClone(readiness)) };
}

function assertRequiredCapabilities(
  options: Readonly<AgentOptions>, model: ModelInfo,
  negotiated: Record<string, CapabilityStatus>,
  transport: 'exec' | 'control',
): void {
  for (const [name, value] of Object.entries(options.capabilities ?? {})) {
    if (value !== true && value !== 'required') continue;
    const key = name === 'tokenDeltas' ? 'messageDeltas' : name;
    const support = negotiated[key]?.support ?? 'unknown';
    if (support === 'unknown' || support === 'none') {
      throw new UnsupportedCapabilityError(
        { provider: model.provider, transport, retryable: false },
        `Required capability ${name} is ${support} on the ${transport} transport; unknown evidence does not satisfy a required capability`,
      );
    }
  }
}

export function agentEnvironment(options: Readonly<AgentOptions>): NodeJS.ProcessEnv {
  const profile = options.context?.profile ?? 'native';
  return buildEnvironment(options.environment ?? { mode: profile === 'native' ? 'inherit' : 'minimal' });
}

export function agentTransport(
  options: Readonly<AgentOptions>, runtime: Runtime, provider: string, persistence: SessionPersistence = 'provider',
) {
  const controlRegistered = runtime.controlRegistration(provider) !== undefined;
  const preference = options.transport ?? 'auto';
  return selectTransport({
    provider,
    preference: options.pinned && preference === 'auto' ? 'exec' : preference,
    requirements: options.capabilities ?? {},
    persistence,
    controlRegistered,
    controlAvailable: controlRegistered && experimentalGates(options.providerOptions).control,
    execCapabilities: runtime.registration(provider).execCapabilities,
  });
}

/** Snapshot and validate before starting any asynchronous preparation. */
export async function freshAgentReadiness(
  options: Readonly<AgentOptions>, runtime: Runtime, model: ModelInfo,
  readinessOptions: AgentReadinessOptions,
): Promise<AgentReadiness> {
  if (!readinessOptions || typeof readinessOptions !== 'object' || types.isProxy(readinessOptions)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(readinessOptions))) {
    throw new TypeError('Readiness options must be a plain object');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(readinessOptions)) {
    const descriptor = Object.getOwnPropertyDescriptor(readinessOptions, key)!;
    if (typeof key !== 'string' || !['signal', 'timeoutMs', 'awaitSettlement'].includes(key)
      || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid readiness option');
    snapshot[key] = descriptor.value;
  }
  const { signal, timeoutMs, awaitSettlement } = snapshot;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') throw new TypeError('timeoutMs must be a number');
  validateSettlementOption(awaitSettlement);
  const scope = new OperationScope(Object.assign(Object.create(null), {
    timeoutMs: validateTimeoutMs(timeoutMs), ...(signal === undefined ? {} : { signal }),
    context: { provider: model.provider, retryable: true },
  }));
  try {
    return (await scope.race(() => prepareAgent(options, runtime, model, 'provider', scope))).readiness;
  } finally {
    try {
      if (awaitSettlement) { await scope.drain(); scope.rethrowExecutionHalt(); }
    } finally { scope.dispose(); }
  }
}
