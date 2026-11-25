import { settleExecScope } from '../control/exec-settlement.js';
import { raceExecWork, resultUsage, streamStepUsage } from '../control/exec-usage.js';
import type { AdapterStreamItem } from '../adapters/provider.js';
import { OperationScope } from '../control/operation-scope.js';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';

import { validateProviderId } from './provider-registration.js';
import type { ExecAdapter, ExecProbeContext, ExecProbeTurn, ExecTurnRequest } from '../adapters/provider.js';
import type { LaunchTarget } from '../process/resolve-binary.js';
import type { ControlSessionFactory } from '../session/control-session.js';
import {
  RequiredTransportUnavailableError,
  UnsupportedCapabilityError,
} from '../public/errors.js';
import type {
  BuiltinProviderId,
  CapabilityEvidenceSource,
  ProviderId,
  SupportLevel,
} from '../public/types.js';

export const RUNTIME_ADAPTER_VERSION = '0.1.0-beta.3';

export type ExecTransportToken = 'claudeExecV1' | 'codexExecV1' | (string & {});
export type ControlTransportToken = 'claudeControlV1' | 'codexAppServerV1' | (string & {});
export type TransportToken = ExecTransportToken | ControlTransportToken;

export const EXEC_TRANSPORT_TOKENS: Readonly<Record<BuiltinProviderId, ExecTransportToken>> =
  Object.freeze({ claude: 'claudeExecV1', codex: 'codexExecV1' });

export const CONTROL_TRANSPORTS: Readonly<
  Record<BuiltinProviderId, { token: ControlTransportToken; packageName: string }>
> = Object.freeze({
  claude: Object.freeze({
    token: 'claudeControlV1' as const,
    packageName: '@open-agent-runtime/claude-control',
  }),
  codex: Object.freeze({
    token: 'codexAppServerV1' as const,
    packageName: '@open-agent-runtime/codex-control',
  }),
});

export interface ExecAdapterRegistration {
  adapter: ExecAdapter;
  token?: ExecTransportToken;
  adapterVersion?: string;
  /** Rebuilds the adapter bound to a pinned executable (constructor `target`). */
  withTarget?: (target: LaunchTarget) => ExecAdapter;
}

/**
 * A control adapter registers itself with data, never by the core importing
 * adapter internals: verdicts, versions, and evidence source are supplied here.
 */
export interface ControlAdapterRegistration {
  token: ControlTransportToken;
  provider: ProviderId;
  packageName: string;
  adapterVersion: string;
  capabilityVerdicts: Readonly<Record<string, SupportLevel>>;
  evidenceSource: CapabilityEvidenceSource;
  sdkVersion?: string;
  protocolVersion?: string;
  /**
   * Opens a live control session. A registration may advertise verdicts for
   * discovery without shipping one; `openSession` then fails with a typed
   * error naming the gap rather than pretending the transport is usable.
   */
  createSession?: ControlSessionFactory;
}

export function controlSessionUnavailableMessage(provider: ProviderId): string {
  const { token } = CONTROL_TRANSPORTS[provider as BuiltinProviderId] ?? { token: `${provider}ControlV1` };
  const factory = provider === 'claude' ? 'createClaudeControlRegistration'
    : provider === 'codex' ? 'createCodexControlRegistration' : undefined;
  return `Control transport ${token} is registered for ${provider} but supplied no session factory; `
    + (factory ? `use ${factory} from hiveagents-runtime to create a working registration` : 'the adapter must supply createSession');
}

export function controlUnavailableMessage(provider: ProviderId): string {
  const { token } = CONTROL_TRANSPORTS[provider as BuiltinProviderId] ?? { token: `${provider}ControlV1` };
  const factory = provider === 'claude' ? 'createClaudeControlRegistration'
    : provider === 'codex' ? 'createCodexControlRegistration' : undefined;
  return `Control transport for ${provider} is not registered: token ${token}. `
    + (factory ? `Import ${factory} from hiveagents-runtime, pass its result in Runtime({ controlAdapters: [...] }), `
      + 'and enable providerOptions.experimentalControl' : 'Pass a control adapter with createSession in Runtime({ controlAdapters: [...] })');
}

export class AdapterRegistry {
  readonly #exec = new Map<ProviderId, ExecAdapterRegistration>();
  readonly #control = new Map<ProviderId, ControlAdapterRegistration>();

  registerExec(registration: ExecAdapterRegistration): void {
    const provider = registration.adapter.id;
    if (registration.token && !/^[a-zA-Z][a-zA-Z0-9]*V[1-9][0-9]*$/.test(registration.token)) {
      throw new TypeError('Transport token must be versioned');
    }
    if (typeof provider !== 'string' || (!Object.hasOwn(EXEC_TRANSPORT_TOKENS, provider) && !registration.token)) {
      throw new TypeError(
        `Exec adapter id ${String(provider)} names no known provider; `
        + `expected one of ${Object.keys(EXEC_TRANSPORT_TOKENS).join(', ')}`,
      );
    }
    validateProviderId(provider);
    if (this.#exec.has(provider)) {
      throw new TypeError(`Exec adapter for ${provider} is already registered`);
    }
    if (registration.token && this.tokens().includes(registration.token)) throw new TypeError(`Transport token ${registration.token} is already registered`);
    this.#exec.set(provider, { ...registration });
  }

  registerControl(registration: ControlAdapterRegistration): void {
    validateProviderId(registration.provider);
    if (!/^[a-zA-Z][a-zA-Z0-9]*V[1-9][0-9]*$/.test(registration.token)
      || !registration.adapterVersion?.trim() || !registration.packageName?.trim()
      || !['live-handshake', 'generated-schema', 'sdk-capability', 'compatibility-manifest'].includes(registration.evidenceSource)
      || Object.values(registration.capabilityVerdicts).some((support) => !['full', 'partial', 'none', 'unknown'].includes(support))) {
      throw new TypeError('Invalid control adapter registration');
    }
    const expected = CONTROL_TRANSPORTS[registration.provider as BuiltinProviderId];
    if ((expected && registration.token !== expected.token) || (!expected && !this.#exec.has(registration.provider))) {
      throw new TypeError(
        `Control token ${registration.token} does not match provider ${registration.provider}; `
        + `expected ${expected?.token ?? 'a known provider'}`,
      );
    }
    if (this.#control.has(registration.provider)) {
      throw new TypeError(`Control adapter ${registration.token} is already registered`);
    }
    if (this.tokens().includes(registration.token)) throw new TypeError(`Transport token ${registration.token} is already registered`);
    this.#control.set(registration.provider, registration);
  }

  execRegistration(provider: ProviderId): ExecAdapterRegistration | undefined {
    return this.#exec.get(provider);
  }

  control(provider: ProviderId): ControlAdapterRegistration | undefined {
    return this.#control.get(provider);
  }

  requireControl(provider: ProviderId): ControlAdapterRegistration {
    const registration = this.#control.get(provider);
    if (registration) return registration;
    throw new RequiredTransportUnavailableError(
      { provider, transport: 'control', retryable: false },
      controlUnavailableMessage(provider),
    );
  }

  providers(): ProviderId[] {
    return [...this.#exec.keys()];
  }

  tokens(): TransportToken[] {
    return [
      ...[...this.#exec.entries()].map(([provider, registration]) => registration.token ?? EXEC_TRANSPORT_TOKENS[provider as BuiltinProviderId]),
      ...[...this.#control.values()].map((registration) => registration.token),
    ];
  }
}

export interface ExperimentalGates {
  control: boolean;
  api: boolean;
}

/** Both gates default to false and neither implies the other. */
export function experimentalGates(
  options: { experimentalControl?: boolean; experimentalApi?: boolean } | undefined,
): ExperimentalGates {
  return {
    control: options?.experimentalControl === true,
    api: options?.experimentalApi === true,
  };
}

export function assertExperimentalApiEnabled(gates: ExperimentalGates, provider: ProviderId): void {
  if (gates.api) return;
  throw new UnsupportedCapabilityError(
    { provider, transport: 'control', retryable: false },
    'Dynamic tools require the explicit experimentalApi opt-in; '
    + 'experimentalControl does not imply it',
  );
}

/**
 * Identity of the executable inspected during readiness probes. Every later
 * execution must resolve to this same binary or re-probe (§18).
 */
export interface ExecutablePin {
  realpath: string;
  launchTarget?: LaunchTarget;
  identityFiles?: ExecutablePin[];
  launchIdentityDigest?: string;
  /**
   * SHA-256 of the bytes at the last probe or rehash. It is recomputed whenever the inode or ctime
   * move, so a same-size replacement that restored mtime is still caught; a digest that differs
   * triggers a re-probe.
   */
  digest: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Inode and ctime at the last probe or rehash; absent on pins built by hand, which rehash once. */
  ino?: number;
  ctimeMs?: number;
  cliVersion?: string;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function createExecutablePin(
  path: string | undefined,
  cliVersion?: string,
  launch?: { target?: LaunchTarget | undefined; identityFiles?: readonly string[] | undefined },
): Promise<ExecutablePin | undefined> {
  if (!path) return undefined;
  try {
    const resolved = await realpath(path);
    const stats = await stat(resolved);
    if (!stats.isFile()) return undefined;
    const digest = await sha256File(resolved);
    const identityFiles: ExecutablePin[] = [];
    const canonical = new Map<string, string>();
    for (const file of launch?.identityFiles ?? []) {
      const identity = await createExecutablePin(file);
      if (!identity) throw new TypeError(`Cannot pin declared launch identity ${file}`);
      identityFiles.push(identity);
      canonical.set(file, identity.realpath);
    }
    const argsPrefix = await Promise.all((launch?.target?.argsPrefix ?? []).map(async (argument) => {
      if (canonical.has(argument)) return canonical.get(argument)!;
      const argumentPath = await realpath(argument).catch(() => undefined);
      return identityFiles.some((file) => file.realpath === argumentPath) ? argumentPath! : argument;
    }));
    const launchTarget = launch?.target ? { command: resolved, argsPrefix } : undefined;
    const launchIdentityDigest = launchTarget || identityFiles.length
      ? createHash('sha256').update(JSON.stringify({ command: resolved, argsPrefix: launchTarget?.argsPrefix ?? [], executable: digest, files: identityFiles.map((file) => [file.realpath, file.digest]) })).digest('hex') : undefined;
    return {
      realpath: resolved,
      ...(launchTarget ? { launchTarget } : {}),
      ...(identityFiles.length ? { identityFiles } : {}),
      ...(launchIdentityDigest ? { launchIdentityDigest } : {}),
      digest,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: stats.ino,
      ctimeMs: stats.ctimeMs,
      ...(cliVersion === undefined ? {} : { cliVersion }),
    };
  } catch (error) {
    if (launch?.identityFiles?.length || launch?.target) throw error;
    return undefined;
  }
}

export type ExecReprobe = (
  env: NodeJS.ProcessEnv,
  previous: ExecutablePin,
  context?: ExecProbeContext,
) => Promise<ExecutablePin>;

/**
 * Revalidates executable identity before every execution; a changed binary
 * triggers `reprobe` so no turn runs under another binary's verdict.
 */
export class PinnedExecAdapter implements ExecAdapter {
  readonly id: ProviderId;
  stream?: NonNullable<ExecAdapter['stream']>;
  readonly #inner: ExecAdapter;
  readonly #reprobe: ExecReprobe;
  #pin: ExecutablePin;

  constructor(inner: ExecAdapter, pin: ExecutablePin, reprobe: ExecReprobe) {
    this.id = inner.id;
    this.#inner = inner;
    this.#pin = pin;
    this.#reprobe = reprobe;
    const innerStream = inner.stream?.bind(inner);
    if (innerStream) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      this.stream = async function* (request: ExecTurnRequest) {
        const scope = new OperationScope({ timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}), context: { provider: self.id, transport: 'exec', retryable: true } });
        let iterator: AsyncIterator<AdapterStreamItem> | undefined, exhausted = false;
        try {
          self.#pin = await scope.race(() => self.#validate(request.env, scope));
          iterator = innerStream({ ...request, timeoutMs: scope.remainingMs(), signal: scope.signal })[Symbol.asyncIterator]();
          for (;;) {
            const step = await raceExecWork(scope, () => iterator!.next(), request.awaitSettlement, streamStepUsage);
            if (step.done) { exhausted = true; return; }
            yield step.value;
          }
        } finally { await settleExecScope(scope, request.awaitSettlement, iterator, exhausted); }
      };
    }
  }

  get pin(): ExecutablePin {
    return this.#pin;
  }

  detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext): ReturnType<ExecAdapter['detect']> {
    return this.#inner.detect(env, context);
  }

  auth(env: NodeJS.ProcessEnv, context?: ExecProbeContext, turn?: ExecProbeTurn): ReturnType<ExecAdapter['auth']> {
    return this.#inner.auth(env, context, turn);
  }

  models(): ReturnType<ExecAdapter['models']> {
    return this.#inner.models();
  }

  async compatibility(
    env: NodeJS.ProcessEnv,
    version: string,
    context?: ExecProbeContext,
  ): ReturnType<NonNullable<ExecAdapter['compatibility']>> {
    return this.#inner.compatibility?.(env, version, context);
  }

  async execute(request: ExecTurnRequest): ReturnType<ExecAdapter['execute']> {
    const scope = new OperationScope({ timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}), context: { provider: this.id, transport: 'exec', retryable: true } });
    try {
      this.#pin = await scope.race(() => this.#validate(request.env, scope));
      return await raceExecWork(scope, () => this.#inner.execute({ ...request, timeoutMs: scope.remainingMs(), signal: scope.signal }), request.awaitSettlement, resultUsage);
    } finally { if (request.awaitSettlement) await scope.drain(); scope.dispose(); }
  }

  async #validate(env: NodeJS.ProcessEnv, context?: ExecProbeContext): Promise<ExecutablePin> {
    try {
      for (const file of this.#pin.identityFiles ?? []) {
        const current = await createExecutablePin(file.realpath);
        if (!current || current.digest !== file.digest) return this.#reprobe(env, this.#pin, context);
      }
      const resolved = await realpath(this.#pin.realpath);
      const stats = await stat(resolved);
      if (
        resolved === this.#pin.realpath
        && stats.isFile()
        && stats.size === this.#pin.sizeBytes
        && stats.mtimeMs === this.#pin.mtimeMs
      ) {
        if (stats.ino === this.#pin.ino && stats.ctimeMs === this.#pin.ctimeMs) return this.#pin;
        // Inode or ctime moved under unchanged size and mtime: only the bytes can tell.
        if (await sha256File(resolved) === this.#pin.digest) {
          return { ...this.#pin, ino: stats.ino, ctimeMs: stats.ctimeMs };
        }
      }
    } catch {
      // The pinned executable no longer resolves; fall through to re-probe.
    }
    return this.#reprobe(env, this.#pin, context);
  }
}
