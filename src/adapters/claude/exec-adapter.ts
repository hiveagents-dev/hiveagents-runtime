import { classifyClaudeFailure } from '../failure-classification.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { assessCliCompatibility } from '../../compatibility/manifest.js';
import { compatibilityModels } from '../../core/models.js';
import { ExecStreamPump } from '../../process/exec-stream-pump.js';
import { guardJsonlFrames } from '../../process/json-lines.js';
import type { LaunchTarget } from '../../process/resolve-binary.js';
import { ExecDiscovery } from '../../process/exec-discovery.js';
import { runProcess } from '../../process/run-process.js';
import type { AuthStatus, ProviderInstallation } from '../../public/types.js';
import {
  isSafeSessionId,
  type ExecAdapter,
  type ExecProbeContext,
  type ExecProbeTurn,
  type AdapterStreamItem,
  type ExecTurnRequest,
  type ProcessRunner,
  type ProtocolResult,
} from '../provider.js';
import { parseClaudeJsonl } from './protocol.js';

function claudeProviderArgs(options: Record<string, unknown> | undefined): string[] {
  if (!options) return [];
  if (options.systemPromptMode !== undefined && !['append', 'replace'].includes(String(options.systemPromptMode))) {
    throw new TypeError('systemPromptMode must be append or replace.');
  }
  const args: string[] = [];
  if (options.tools !== undefined) {
    if (!Array.isArray(options.tools) || !options.tools.every((tool) =>
      typeof tool === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(tool))) {
      throw new TypeError('Claude tools must be an array of built-in tool names.');
    }
    // Do not omit the empty argument: omission enables the provider defaults.
    args.push('--tools', options.tools.join(','));
  }
  if (options.strictMcpConfig !== undefined) {
    if (typeof options.strictMcpConfig !== 'boolean') throw new TypeError('strictMcpConfig must be boolean.');
    if (options.strictMcpConfig) args.push('--strict-mcp-config');
  }
  if (options.mcpConfigs !== undefined) {
    if (!Array.isArray(options.mcpConfigs) || !options.mcpConfigs.every((config) =>
      typeof config === 'string' && config.trim() !== '' && !config.includes('\0') && !config.startsWith('-'))) {
      throw new TypeError('Claude MCP configs must be non-empty paths or JSON strings.');
    }
    if (options.mcpConfigs.length) args.push('--mcp-config', ...options.mcpConfigs);
  }
  args.push(...claudeSettingsArgs(options));
  return args;
}

function claudeSettingsArgs(options: Record<string, unknown> | undefined): string[] {
  if (options?.settings === undefined) return [];
  const settings = typeof options.settings === 'string' ? options.settings
    : options.settings !== null && typeof options.settings === 'object' && !Array.isArray(options.settings)
      ? JSON.stringify(options.settings) : undefined;
  if (!settings || settings.includes('\0') || settings.startsWith('-')) throw new TypeError('Claude settings must be a path or JSON object.');
  return ['--settings', settings];
}

export function buildClaudeExecArgs(request: ExecTurnRequest, newSessionId: string): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', request.modelId,
  ];

  if (request.mode === 'resume' || request.mode === 'fork') {
    if (!request.sessionId) throw new TypeError(`${request.mode} requires a sessionId`);
    if (!isSafeSessionId(request.sessionId)) throw new TypeError('sessionId is not a safe CLI argument');
    args.push('--resume', request.sessionId);
    if (request.mode === 'fork') args.push('--fork-session');
  } else {
    args.push('--session-id', newSessionId);
  }

  if (request.instructions) args.push(request.providerOptions?.systemPromptMode === 'replace'
    ? '--system-prompt' : '--append-system-prompt', request.instructions);
  if (request.effort) args.push('--effort', request.effort);
  if (request.outputSchema) args.push('--json-schema', JSON.stringify(request.outputSchema));
  args.push(...claudeProviderArgs(request.providerOptions));
  // Availability (--tools) is distinct from permission. The responder may only
  // preapprove its existing public-search capability; other tools stay denied.
  if (request.permissionArgs.includes('dontAsk') && Array.isArray(request.providerOptions?.tools)
    && request.providerOptions.tools.includes('WebSearch')) args.push('--allowed-tools', 'WebSearch');
  args.push(...request.contextArgs, ...request.permissionArgs);
  return args;
}

/** Variables that make `-p` bill something other than the login, and that `auth status` does not report. */
function namesApiBilling(vars: Record<string, unknown>): boolean {
  return Boolean(vars.ANTHROPIC_AUTH_TOKEN || vars.ANTHROPIC_PROFILE
    || (vars.ANTHROPIC_FEDERATION_RULE_ID && vars.ANTHROPIC_ORGANIZATION_ID));
}

async function explicitClaudeSettings(settings: unknown, cwd: string): Promise<unknown> {
  if (typeof settings !== 'string') return settings;
  try {
    return JSON.parse(settings.trimStart().startsWith('{') ? settings : await readFile(resolve(cwd, settings), 'utf8'));
  } catch { throw new TypeError('Claude settings must be valid JSON or a readable JSON file.'); }
}

/** `-p` applies the `env` block of every settings layer the turn loads (seen on the wire with 2.1.228); `auth status` reports none. */
async function settingsMoveBilling(turn: ExecProbeTurn, env: NodeJS.ProcessEnv): Promise<boolean> {
  const files = [join(turn.cwd, '.claude', 'settings.json'), join(turn.cwd, '.claude', 'settings.local.json')];
  if (!turn.contextArgs.includes('--setting-sources')) {
    files.push(join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), 'settings.json'));
  }
  // A malformed layer is skipped, as the CLI itself does.
  const layers: unknown[] = await Promise.all(files.map((file) => readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as unknown).catch(() => undefined)));
  layers.push(await explicitClaudeSettings(turn.providerOptions?.settings, turn.cwd));
  return layers.some((layer) => {
    const block = (layer as { env?: unknown } | null | undefined)?.env;
    if (typeof block !== 'object' || block === null) return false;
    const vars = block as Record<string, unknown>;
    return Boolean(vars.ANTHROPIC_API_KEY || vars.ANTHROPIC_BASE_URL) || namesApiBilling(vars);
  });
}

function parseClaudeAuth(raw: string, env: NodeJS.ProcessEnv, movedBySettings: boolean): AuthStatus {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const authenticated = value.loggedIn === true;
    const method = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : '';
    const loginSource: AuthStatus['source'] = !authenticated
      ? 'unknown'
      : method.includes('claude.ai') || method.includes('oauth')
        ? 'subscription'
        : method.includes('api')
          ? 'api-key'
          : method.includes('bedrock') || method.includes('vertex')
            ? 'cloud-provider'
            : 'unknown';
    // `-p` bills these ahead of the login, while authMethod keeps naming the login.
    // apiKeySource reveals API keys and helpers; bearer tokens, profiles and federation show only in the environment.
    const keyInUse = (typeof value.apiKeySource === 'string' && !['', 'none'].includes(value.apiKeySource))
      || namesApiBilling(env) || movedBySettings;
    const source = loginSource === 'subscription' && keyInUse ? 'api-key' : loginSource;
    const plan = typeof value.subscriptionType === 'string' && source === loginSource ? value.subscriptionType : undefined;
    return {
      authenticated,
      source,
      ...(plan === undefined ? {} : { account: { plan } }),
    };
  } catch {
    return { authenticated: false, source: 'unknown' };
  }
}

export class ClaudeExecAdapter implements ExecAdapter {
  readonly id = 'claude' as const;
  readonly #runner: ProcessRunner;
  readonly #probeRunner: ProcessRunner;
  readonly #discovery: ExecDiscovery;

  constructor(options: { runner?: ProcessRunner; probeRunner?: ProcessRunner; target?: LaunchTarget } = {}) {
    this.#runner = options.runner ?? runProcess;
    this.#probeRunner = options.probeRunner ?? this.#runner;
    this.#discovery = new ExecDiscovery('claude', this.#probeRunner, options.target);
  }

  #target(env: NodeJS.ProcessEnv): LaunchTarget | undefined {
    return this.#discovery.target(env);
  }

  async detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext): Promise<ProviderInstallation> {
    return this.#discovery.detect(env, context);
  }

  async auth(env: NodeJS.ProcessEnv, context?: ExecProbeContext, turn?: ExecProbeTurn): Promise<AuthStatus> {
    const target = this.#target(env);
    if (!target) return { authenticated: false, source: 'unknown' };
    // Directory and flags decide which settings load, and with them which credential the turn would use.
    const turnArgs = turn ? [...turn.contextArgs, ...claudeSettingsArgs(turn.providerOptions)] : [];
    const movedBySettings = turn ? await settingsMoveBilling(turn, env) : false;
    const outcome = await this.#probeRunner({
      command: target.command,
      args: [...target.argsPrefix, ...turnArgs, 'auth', 'status', '--json'],
      cwd: turn?.cwd ?? process.cwd(),
      env,
      stdin: '',
      timeoutMs: Math.min(15_000, context?.remainingMs() ?? 15_000),
      ...(context ? { signal: context.signal } : {}),
      maxOutputBytes: 64 * 1024,
    });
    return parseClaudeAuth(outcome.stdout, env, movedBySettings);
  }

  async models() {
    return compatibilityModels('claude');
  }

  async compatibility(env: NodeJS.ProcessEnv, version: string, context?: ExecProbeContext) {
    const target = this.#target(env);
    if (!target) return undefined;
    const outcome = await this.#probeRunner({
      command: target.command,
      args: [...target.argsPrefix, '--help'],
      cwd: process.cwd(),
      env,
      stdin: '',
      timeoutMs: Math.min(15_000, context?.remainingMs() ?? 15_000),
      ...(context ? { signal: context.signal } : {}),
      maxOutputBytes: 256 * 1024,
    });
    const assessment = assessCliCompatibility('claude', version, {
      main: `${outcome.stdout}\n${outcome.stderr}`,
    });
    // No captured result frame carries a refusal signal (tests/fixtures/claude/*.jsonl), so turns
    // never report `refused`; say so instead of leaving the capability unknown.
    return { ...assessment, features: { ...assessment.features, refusalDetection: 'unsupported' as const } };
  }

  async execute(request: ExecTurnRequest): Promise<ProtocolResult> {
    const target = this.#target(request.env);
    if (!target) {
      return {
        completed: false,
        failed: true,
        refused: false,
        text: '',
        events: [],
        failure: { kind: 'provider-unavailable', message: 'Claude CLI not found' },
        nativeEvents: [],
      };
    }
    const outcome = await guardJsonlFrames(onStdout => this.#runner({
      command: target.command,
      args: [...target.argsPrefix, ...buildClaudeExecArgs(request, randomUUID())],
      cwd: request.cwd,
      env: request.env,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      onStdout,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
    const result = parseClaudeJsonl(outcome.stdout);
    if (outcome.code !== 0 && result.failure?.kind === 'protocol') {
      return {
        ...result,
        failure: classifyClaudeFailure({ result: outcome.stderr.trim() || `Claude exited with code ${outcome.code}` }),
      };
    }
    return result;
  }

  async *stream(request: ExecTurnRequest): AsyncIterable<AdapterStreamItem> {
    const target = this.#target(request.env);
    if (!target) {
      yield {
        kind: 'result',
        result: {
          completed: false,
          failed: true,
          refused: false,
          text: '',
          events: [],
          failure: { kind: 'provider-unavailable', message: 'Claude CLI not found' },
          nativeEvents: [],
        },
      };
      return;
    }

    const parseState = { toolFallbackIndex: 0 };
    const pump = new ExecStreamPump(request.signal, line => parseClaudeJsonl(line, parseState), parseClaudeJsonl);
    const execution = this.#runner({
      command: target.command,
      args: [...target.argsPrefix, ...buildClaudeExecArgs(request, randomUUID())],
      cwd: request.cwd,
      env: request.env,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      captureStdout: false, // The pump retains the incremental result; legacy runners still receive onStdout.
      signal: pump.signal, onStdout: pump.onStdout, onStdoutAsync: pump.onStdoutAsync,
      onFailure: error => pump.fail(error),
    }).then((outcome) => pump.finish((parsed) => {
      let result = parsed;
      // Paridad con execute(): un exit != 0 sin envelope no es un error de
      // protocolo anónimo — se reclasifica con el stderr disponible.
      if (outcome.code !== 0 && result.failure?.kind === 'protocol') {
        result = {
          ...result,
          failure: classifyClaudeFailure({ result: outcome.stderr.trim() || `Claude exited with code ${outcome.code}` }),
        };
      }
      return result;
    })).catch((error: unknown) => pump.fail(error));
    try { yield* pump.items(); }
    catch (error) {
      pump.cancel();
      if (request.awaitSettlement) { await execution; throw pump.afterSettlement(error); }
      throw error;
    } finally { pump.cancel(); if (request.awaitSettlement) await execution; }
  }
}
