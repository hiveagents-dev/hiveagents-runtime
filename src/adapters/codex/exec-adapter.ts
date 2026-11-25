import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assessCliCompatibility } from '../../compatibility/manifest.js';
import { compatibilityModels } from '../../core/models.js';
import { ExecStreamPump } from '../../process/exec-stream-pump.js';
import { guardJsonlFrames } from '../../process/json-lines.js';
import type { LaunchTarget } from '../../process/resolve-binary.js';
import { ExecDiscovery } from '../../process/exec-discovery.js';
import { runProcess } from '../../process/run-process.js';
import { UnsupportedCapabilityError } from '../../public/errors.js';
import type { AuthStatus, ProviderInstallation } from '../../public/types.js';
import {
  isSafeSessionId,
  type ExecAdapter,
  type ExecProbeContext,
  type AdapterStreamItem,
  type ExecTurnRequest,
  type ProcessRunner,
  type ProtocolResult,
} from '../provider.js';
import { classifyCodexFailure, parseCodexJsonl } from './protocol.js';

function withStructuredOutput(result: ProtocolResult, requested: boolean): ProtocolResult {
  if (!requested || result.failure || result.output !== undefined) return result;
  try {
    return { ...result, output: JSON.parse(result.text) as unknown };
  } catch {
    // Texto no-JSON: se expone como output crudo para que la re-validación de
    // la sesión (session.ts → validateOutput) falle con la respuesta original
    // disponible en sanitizedDiagnostics, como exige el spec §13.4.
    return { ...result, output: result.text };
  }
}

function jsonType(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (['string', 'number', 'boolean'].includes(typeof value)) return typeof value;
  return undefined;
}

// Claves cuyos hijos son mapas nombre→schema (el contenedor NO es un schema).
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
// Claves cuyos hijos son datos literales, nunca schemas: no se les inyecta type.
const LITERAL_KEYS = new Set(['const', 'enum', 'default', 'examples']);

function normalizeCodexSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCodexSchema);
  if (typeof value !== 'object' || value === null) return value;
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (LITERAL_KEYS.has(key)) return [key, child];
      if (SCHEMA_MAP_KEYS.has(key) && typeof child === 'object' && child !== null && !Array.isArray(child)) {
        return [key, Object.fromEntries(
          Object.entries(child as Record<string, unknown>)
            .map(([name, schema]) => [name, normalizeCodexSchema(schema)]),
        )];
      }
      return [key, normalizeCodexSchema(child)];
    }),
  );
  if (normalized.type === undefined && Object.hasOwn(normalized, 'const')) {
    const inferred = jsonType(normalized.const);
    if (inferred) normalized.type = inferred;
  }
  return normalized;
}

function tomlString(value: string): string {
  // JSON and TOML share these escapes, except TOML also forbids literal DEL
  // and invalid Unicode scalar values. Never trigger Codex's raw-string fallback.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Codex config requires valid Unicode.');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('Codex config requires valid Unicode.');
  }
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function tomlValue(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 16) throw new TypeError('Codex config nesting exceeds 16 levels.');
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return Object.is(value, -0) ? '-0.0' : String(value);
  if (value === null || typeof value !== 'object') throw new TypeError('Codex config contains an unsupported TOML value.');
  if (ancestors.has(value)) throw new TypeError('Codex config contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, (item) => tomlValue(item, ancestors, depth + 1)).join(', ')}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Codex config requires plain objects.');
    }
    return `{ ${Object.entries(value).map(([key, child]) =>
      `${tomlString(key)} = ${tomlValue(child, ancestors, depth + 1)}`).join(', ')} }`;
  } finally { ancestors.delete(value); }
}

/** Config values are TOML argv entries, not JSON inline tables or shell text. */
function codexConfigArgs(config: unknown): string[] {
  if (config === undefined) return [];
  if (config === null || typeof config !== 'object' || Array.isArray(config)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(config) as object | null)) {
    throw new TypeError('Codex config must be a plain object.');
  }
  const args: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(key)) throw new TypeError('Codex config keys must be dotted TOML identifiers.');
    const entry = `${key}=${tomlValue(value)}`;
    if (Buffer.byteLength(entry) > 65_536) throw new TypeError('A Codex config entry exceeds 64 KiB.');
    args.push('--config', entry);
  }
  if (Buffer.byteLength(args.join('\n')) > 262_144) throw new TypeError('Codex config exceeds 256 KiB.');
  return args;
}

/**
 * A TOML basic string made of printable ASCII only: quote, backslash and control characters take their short
 * escapes, every other non-ASCII scalar is \\uXXXX or \\UXXXXXXXX. No text can end the string early or reach the
 * parser as anything but this one value, and nothing depends on how the terminal or the CLI decodes bytes.
 */
function tomlAsciiString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Codex config requires valid Unicode.');
      out += `\\U${value.codePointAt(i)!.toString(16).padStart(8, '0')}`;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('Codex config requires valid Unicode.');
    else if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += '\\\\';
    else if (unit === 0x08) out += '\\b';
    else if (unit === 0x09) out += '\\t';
    else if (unit === 0x0a) out += '\\n';
    else if (unit === 0x0c) out += '\\f';
    else if (unit === 0x0d) out += '\\r';
    else if (unit >= 0x20 && unit < 0x7f) out += value[i];
    else out += `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return out + '"';
}

/**
 * `instructions` go to the model in the developer role, apart from the user's message: `-c developer_instructions=…`
 * (observed on the wire with codex-cli 0.153.4). A resumed or forked session replays the developer instructions it
 * started with and does not send new ones, so there the request is refused rather than run without them.
 */
function developerInstructionArgs(request: ExecTurnRequest): string[] {
  if (!request.instructions) return [];
  if (request.mode === 'resume' || request.mode === 'fork') {
    throw new UnsupportedCapabilityError(
      { provider: 'codex', transport: 'exec', retryable: false },
      'Codex exec resume and fork replay the developer instructions the session started with; new instructions would not be sent',
    );
  }
  const config = request.providerOptions?.config;
  if (config !== null && typeof config === 'object' && Object.hasOwn(config, 'developer_instructions')) {
    throw new TypeError('Pass Codex developer instructions either as instructions or as config.developer_instructions, not both.');
  }
  const entry = codexDeveloperInstructionsEntry(request.instructions);
  if (Buffer.byteLength(entry) > 65_536) throw new TypeError('A Codex config entry exceeds 64 KiB.');
  return ['--config', entry];
}

/** The `--config` entry that carries `text` as Codex developer instructions (its size is what Codex limits). */
export function codexDeveloperInstructionsEntry(text: string): string {
  return `developer_instructions=${tomlAsciiString(text)}`;
}

/**
 * `exec` flags a caller asks for through provider options, for a launch that must not load the owner's setup
 * (`ignoreUserConfig`, `ignoreRules`) or leave session files behind (`ephemeral`). A flag the context already
 * emits is not repeated.
 */
const CLOSING_FLAGS = [['ignoreUserConfig', '--ignore-user-config'], ['ignoreRules', '--ignore-rules'], ['ephemeral', '--ephemeral']] as const;
function closingArgs(request: ExecTurnRequest): string[] {
  const args: string[] = [];
  for (const [option, flag] of CLOSING_FLAGS) {
    const value = request.providerOptions?.[option];
    if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`providerOptions.codex.${option} must be true or false`);
    if (value && !request.contextArgs.includes(flag)) args.push(flag);
  }
  return args;
}

/** The default provider, stated so that a config.toml choosing another cannot move the bill off the login. */
export const CODEX_LOGIN_PROVIDER_ARGS = ['--config', 'model_provider="openai"'] as const;

export function buildCodexExecArgs(
  request: ExecTurnRequest,
  schemaPath: string | undefined,
): string[] {
  if ((request.mode === 'resume' || request.mode === 'fork') && !request.sessionId) {
    throw new TypeError(`${request.mode} requires a sessionId`);
  }
  if ((request.mode === 'resume' || request.mode === 'fork') && !isSafeSessionId(request.sessionId)) {
    throw new TypeError('sessionId is not a safe CLI argument');
  }

  // resume/fork accept fewer local flags, so top-level options must precede `exec`.
  const args = [
    '--model', request.modelId,
    '--cd', request.cwd,
    ...request.permissionArgs,
    ...codexConfigArgs(request.providerOptions?.config),
    ...developerInstructionArgs(request),
    ...(request.requireSubscription ? CODEX_LOGIN_PROVIDER_ARGS : []),
  ];
  if (request.effort) {
    // El valor se interpola dentro de un literal TOML: sólo identificadores
    // simples, para que un string arbitrario nunca alcance el parser de -c.
    if (!/^[a-z][a-z0-9-]*$/i.test(request.effort)) {
      throw new UnsupportedCapabilityError(
        { provider: 'codex', transport: 'exec', retryable: false },
        `Unsupported effort value: ${JSON.stringify(request.effort)}`,
      );
    }
    args.push('--config', `model_reasoning_effort="${request.effort}"`);
  }
  args.push('exec');
  if (request.mode === 'resume' || request.mode === 'fork') args.push(request.mode);
  args.push('--json', ...request.contextArgs, ...closingArgs(request));
  if (schemaPath) args.push('--output-schema', schemaPath);

  const skipGitRepoCheck = request.providerOptions?.skipGitRepoCheck === true;
  if (skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (request.mode === 'resume' || request.mode === 'fork') args.push(request.sessionId as string);
  args.push('-');
  return args;
}

function parseCodexAuth(
  outcome: { code: number | null; stdout: string; stderr: string },
  env: NodeJS.ProcessEnv,
): AuthStatus {
  const text = `${outcome.stdout}\n${outcome.stderr}`.trim().toLowerCase();
  const authenticated = outcome.code === 0 && !/not logged in|no credentials|please.*login/.test(text);
  const source: AuthStatus['source'] = !authenticated
    ? 'unknown'
    : text.includes('chatgpt')
      // `codex exec` sends CODEX_API_KEY over a saved login while `login status` keeps
      // naming the login. Observed on the wire with 0.153.4; OPENAI_API_KEY is not sent.
      ? env.CODEX_API_KEY ? 'api-key' : 'subscription'
      : text.includes('api key')
        ? 'api-key'
        : text.includes('ollama') || text.includes('lmstudio')
          ? 'oss'
          : 'unknown';
  return { authenticated, source };
}

export class CodexExecAdapter implements ExecAdapter {
  readonly id = 'codex' as const;
  readonly #runner: ProcessRunner;
  readonly #probeRunner: ProcessRunner;
  readonly #discovery: ExecDiscovery;

  constructor(options: { runner?: ProcessRunner; probeRunner?: ProcessRunner; target?: LaunchTarget } = {}) {
    this.#runner = options.runner ?? runProcess;
    this.#probeRunner = options.probeRunner ?? this.#runner;
    this.#discovery = new ExecDiscovery('codex', this.#probeRunner, options.target);
  }

  #target(env: NodeJS.ProcessEnv): LaunchTarget | undefined {
    return this.#discovery.target(env);
  }

  async detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext): Promise<ProviderInstallation> {
    return this.#discovery.detect(env, context);
  }

  async auth(env: NodeJS.ProcessEnv, context?: ExecProbeContext): Promise<AuthStatus> {
    const target = this.#target(env);
    if (!target) return { authenticated: false, source: 'unknown' };
    const outcome = await this.#probeRunner({
      command: target.command,
      args: [...target.argsPrefix, 'login', 'status'],
      cwd: process.cwd(),
      env,
      stdin: '',
      timeoutMs: Math.min(15_000, context?.remainingMs() ?? 15_000),
      ...(context ? { signal: context.signal } : {}),
      maxOutputBytes: 64 * 1024,
    });
    return parseCodexAuth(outcome, env);
  }

  async models() {
    return compatibilityModels('codex');
  }

  async compatibility(env: NodeJS.ProcessEnv, version: string, context?: ExecProbeContext) {
    const target = this.#target(env);
    if (!target) return undefined;
    const probe = async (args: string[]) => this.#probeRunner({
      command: target.command,
      args: [...target.argsPrefix, ...args],
      cwd: process.cwd(),
      env,
      stdin: '',
      timeoutMs: Math.min(15_000, context?.remainingMs() ?? 15_000),
      ...(context ? { signal: context.signal } : {}),
      maxOutputBytes: 256 * 1024,
    });
    const [main, resume, fork] = await Promise.all([
      probe(['exec', '--help']),
      probe(['exec', 'resume', '--help']),
      probe(['exec', 'fork', '--help']),
    ]);
    const assessment = assessCliCompatibility('codex', version, {
      main: `${main.stdout}\n${main.stderr}`,
      resume: `${resume.stdout}\n${resume.stderr}`,
      fork: `${fork.stdout}\n${fork.stderr}`,
    });
    // No captured exec event carries a refusal signal (tests/fixtures/codex/*.jsonl), so turns
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
        failure: { kind: 'provider-unavailable', message: 'Codex CLI not found' },
        nativeEvents: [],
      };
    }

    let temporaryDirectory: string | undefined;
    try {
      let schemaPath: string | undefined;
      if (request.outputSchema) {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'hiveagents-runtime-'));
        schemaPath = join(temporaryDirectory, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(normalizeCodexSchema(request.outputSchema)), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      const outcome = await guardJsonlFrames(onStdout => this.#runner({
        command: target.command,
        args: [...target.argsPrefix, ...buildCodexExecArgs(request, schemaPath)],
        cwd: request.cwd,
        env: request.env,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        onStdout,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
      const result = withStructuredOutput(parseCodexJsonl(outcome.stdout), request.outputSchema !== undefined);
      if (outcome.code !== 0 && result.failure?.kind === 'protocol') {
        return {
          ...result,
          failure: classifyCodexFailure([
            outcome.stderr.trim() || `Codex exited with code ${outcome.code}`,
          ]),
        };
      }
      return result;
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
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
          failure: { kind: 'provider-unavailable', message: 'Codex CLI not found' },
          nativeEvents: [],
        },
      };
      return;
    }

    let temporaryDirectory: string | undefined;
    let schemaPath: string | undefined;
    let args: string[];
    try {
      if (request.outputSchema) {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'hiveagents-runtime-'));
        schemaPath = join(temporaryDirectory, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(normalizeCodexSchema(request.outputSchema)), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      args = buildCodexExecArgs(request, schemaPath);
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }

    const parseState = { itemIndex: 0 };
    const pump = new ExecStreamPump(request.signal, line => parseCodexJsonl(line, parseState), parseCodexJsonl);
    const execution = this.#runner({
      command: target.command,
      args: [...target.argsPrefix, ...args],
      cwd: request.cwd,
      env: request.env,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      captureStdout: false, // The pump retains the incremental result; legacy runners still receive onStdout.
      signal: pump.signal, onStdout: pump.onStdout, onStdoutAsync: pump.onStdoutAsync,
      onFailure: error => pump.fail(error),
    }).then((outcome) => pump.finish((parsed) => {
      let result = withStructuredOutput(parsed, request.outputSchema !== undefined);
      if (outcome.code !== 0 && result.failure?.kind === 'protocol') {
        result = {
          ...result,
          failure: classifyCodexFailure([
            outcome.stderr.trim() || `Codex exited with code ${outcome.code}`,
          ]),
        };
      }
      return result;
    })).catch((error: unknown) => pump.fail(error))
      .finally(async () => {
        if (temporaryDirectory) {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    try { yield* pump.items(); }
    catch (error) {
      pump.cancel();
      if (request.awaitSettlement) { await execution; throw pump.afterSettlement(error); }
      throw error;
    } finally { pump.cancel(); if (request.awaitSettlement) await execution; }
  }
}
