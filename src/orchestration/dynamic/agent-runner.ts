import { isAbsolute } from 'node:path';
import { rethrowExecutionHalt } from '../../public/execution-halt.js';
import type { Runtime } from '../../core/runtime.js';
import { AgentRuntimeError, observedUsageLimitReset, type RuntimeErrorCode } from '../../public/errors.js';
import type { AgentOptions, PermissionIntent, Turn, TurnOptions, Usage } from '../../public/types.js';
import { DYNAMIC_EFFORT_PATTERN } from './limits.js';
import { DynamicRunnerError, type DynamicRunnerErrorCode } from './runner-error.js';
import type {
  DynamicAgentRequest, DynamicAgentRunner, DynamicPermissionMode, JsonValue,
} from './types.js';

/**
 * A `DynamicAgentRunner` built on SDK Agents.
 *
 * Each agent call builds a fresh Agent from the application's base options, runs one turn and
 * closes it. The base options are the application's own trusted configuration (default model,
 * `cwd`, `environment`, `context`, `providerOptions`, ...); what the workflow chooses per call is
 * narrowed to:
 * - `model`: the base model, or a model listed in `models` (any other is refused, MODEL_NOT_ALLOWED).
 *   The engine checks a call's model against `DynamicLimits.models` first: a model a call names must
 *   be listed in both;
 * - `permissions`: the base `permissions` with `mode` set per call: 'edit' when the call asks for it
 *   and the ceiling allows it, else 'analyze'. Every other base field (`network`, `strict`,
 *   `minimumEnforcement`, `additionalDirectories`) is kept as the application set it, so a policy the
 *   provider cannot enforce is refused exactly as a plain Agent refuses it. A base whose `mode` is
 *   above the ceiling (or 'unrestricted' at all) is refused when the runner is built;
 * - `cwd`: the call's (its isolated worktree) or the base's;
 * - `effort`: the call's or the base's, matching `DYNAMIC_EFFORT_PATTERN`;
 * - `memory`: `false` unless the base sets `memory` explicitly, so a Runtime memory default never
 *   recalls into, or captures from, a workflow agent the application did not opt in.
 *
 * Structured output: the call's `schema` is the turn's `outputSchema`. When the Agent rejects the
 * provider's output against it (STRUCTURED_OUTPUT_ERROR) and the rejected output is JSON, the runner
 * returns it (with the observed usage) instead of failing, so the engine validates it and re-asks with
 * the schema errors up to `schemaRetries` times.
 *
 * Agents run as the user, with the user's CLI login and on the user's machine. The permission
 * ceiling is enforced by the Agent's own permission translation for the provider; it narrows what
 * the CLI may do, it is not a sandbox. `providerOptions` and base `permissions` fields such as
 * `network: 'allow'` or `additionalDirectories` are passed through as the application configured them
 * and can widen what the CLI allows: keep them to what every agent of every workflow may do.
 *
 * Errors are `DynamicRunnerError`s with a closed code, a bounded SDK message and the failed turn's
 * usage when known; provider text never reaches the message. The SDK's typed usage/rate-limit rejection
 * (`USAGE_LIMIT`) becomes RATE_LIMITED, carrying the provider's confirmed reset time when the SDK has one,
 * so the engine adapts its concurrency and retries; nothing is inferred from provider text here. The Agent class is loaded on the first
 * call, so importing this module does not load the runtime.
 */

export { DynamicRunnerError } from './runner-error.js';
export type { DynamicRunnerErrorCode } from './runner-error.js';

export interface AgentRunnerOptions {
  /** The application's base Agent options; `model` is the default model of the workflow's agents. */
  agent: AgentOptions;
  /** Runtime the Agents run on. Default: the SDK's default runtime. */
  runtime?: Runtime;
  /** Most an agent may do. Default 'analyze'. */
  ceiling?: DynamicPermissionMode;
  /** Models a request may name besides the base model. Absent: only the base model. */
  models?: readonly string[];
  /** Close each Agent after its turn. Default true; false skips `close()` (and its wait for memory captures). */
  closeAgents?: boolean;
}

type RunnerResult = { text: string; output?: JsonValue; usage?: Usage };

const MODES: readonly DynamicPermissionMode[] = ['analyze', 'edit'];
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const UNSUPPORTED_CODES: ReadonlySet<RuntimeErrorCode> = new Set<RuntimeErrorCode>([
  'UNSUPPORTED_CAPABILITY', 'REQUIRED_TRANSPORT_UNAVAILABLE', 'UNKNOWN_PROVIDER', 'UNKNOWN_MODEL',
  'AMBIGUOUS_MODEL', 'MODEL_PROVIDER_MISMATCH', 'MODEL_UNAVAILABLE_FOR_AUTH', 'UNSUPPORTED_CLI_VERSION',
]);

export function agentRunner(input: AgentRunnerOptions): DynamicAgentRunner {
  if (!input || typeof input !== 'object') throw new TypeError('agentRunner needs an options object');
  const { agent: base, runtime } = input;
  if (!base || typeof base !== 'object' || typeof base.model !== 'string' || base.model.length === 0) {
    throw new TypeError('agent must be Agent options with a model');
  }
  const ceiling = input.ceiling ?? 'analyze';
  if (!MODES.includes(ceiling)) throw new TypeError("ceiling must be 'analyze' or 'edit'");
  if (base.permissions !== undefined && (!base.permissions || typeof base.permissions !== 'object' || Array.isArray(base.permissions))) {
    throw new TypeError('agent.permissions must be a permission object');
  }
  const baseMode = base.permissions?.mode;
  if (baseMode !== undefined && baseMode !== 'analyze' && baseMode !== 'respond' && !(baseMode === 'edit' && ceiling === 'edit')) {
    throw new TypeError(`The base agent options set permissions above the ceiling '${ceiling}'`);
  }
  if (base.cwd !== undefined && (typeof base.cwd !== 'string' || !isAbsolute(base.cwd))) {
    throw new TypeError('agent.cwd must be an absolute path');
  }
  if (base.effort !== undefined && (typeof base.effort !== 'string' || !DYNAMIC_EFFORT_PATTERN.test(base.effort))) {
    throw new TypeError('agent.effort must be a short lowercase word');
  }
  if (input.models !== undefined && (!Array.isArray(input.models)
    || input.models.some(model => typeof model !== 'string' || model.length === 0))) {
    throw new TypeError('models must be an array of model ids');
  }
  const allowed = new Set([base.model, ...(input.models ?? [])]);
  const closeAgents = input.closeAgents !== false;
  const { permissions: basePermissions, ...rest } = base;
  // Every safety field of the base is kept (copied now, so a later change by the caller is not seen);
  // only `mode` is chosen per call.
  const { mode: _mode, ...kept } = basePermissions ?? { mode: 'analyze' };
  const policy: Omit<PermissionIntent, 'mode'> = {
    ...kept,
    ...(Array.isArray(kept.additionalDirectories) ? { additionalDirectories: [...kept.additionalDirectories] } : {}),
  };
  const fixed: Omit<AgentOptions, 'model'> = { ...rest, memory: base.memory === undefined ? false : base.memory };

  return {
    async run(request: DynamicAgentRequest) {
      const { options, turn } = prepare(request, fixed, policy, base, allowed, ceiling);
      // Loaded here, not at module level: the orchestration entry must not load the whole runtime.
      const { Agent } = await import('../../public/agent.js');
      const { agentTransport } = await import('../../public/agent-readiness.js');
      const activeRuntime = runtime ?? (await import('../../core/runtime.js')).defaultRuntime;
      let agent: InstanceType<typeof Agent> | undefined;
      try {
        agent = new Agent(options, activeRuntime);
        const transport = agentTransport(options, activeRuntime, agent.model.provider);
        return result(await agent.send(request.prompt, {
          ...turn, ...(transport === 'exec' ? { awaitSettlement: true } : {}),
        }), turn, request.signal);
      } catch (error) {
        rethrowExecutionHalt(error);
        const rejected = rejectedOutput(error, turn);
        if (rejected) return rejected;
        throw toRunnerError(error, request.signal);
      } finally {
        if (agent && closeAgents) await agent.close().catch(rethrowExecutionHalt);
      }
    },
  };
}

function prepare(
  request: DynamicAgentRequest, fixed: Omit<AgentOptions, 'model'>, policy: Omit<PermissionIntent, 'mode'>,
  base: AgentOptions, allowed: ReadonlySet<string>, ceiling: DynamicPermissionMode,
): { options: AgentOptions; turn: TurnOptions } {
  if (!request || typeof request !== 'object' || !request.options || typeof request.options !== 'object') {
    throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'request' });
  }
  const { options: call, signal } = request;
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'prompt' });
  }
  if (!(signal instanceof AbortSignal)) throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'signal' });
  if (signal.aborted) throw new DynamicRunnerError('ABORTED');
  const mode = call.permissions;
  if (!MODES.includes(mode)) throw new DynamicRunnerError('PERMISSION_DENIED');
  if (mode === 'edit' && ceiling !== 'edit') throw new DynamicRunnerError('PERMISSION_DENIED');
  const model = call.model ?? base.model;
  if (typeof model !== 'string' || !allowed.has(model)) throw new DynamicRunnerError('MODEL_NOT_ALLOWED');
  if (request.cwd !== undefined && (typeof request.cwd !== 'string' || !isAbsolute(request.cwd))) {
    throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'cwd' });
  }
  if (call.effort !== undefined && (typeof call.effort !== 'string' || !DYNAMIC_EFFORT_PATTERN.test(call.effort))) {
    throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'effort' });
  }
  const timeoutMs = call.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'timeoutMs' });
  }
  const schema = call.schema;
  if (schema !== undefined && (!schema || typeof schema !== 'object' || Array.isArray(schema))) {
    throw new DynamicRunnerError('INVALID_REQUEST', { detail: 'schema' });
  }
  const cwd = request.cwd ?? base.cwd;
  const effort = call.effort ?? base.effort;
  const options: AgentOptions = {
    ...fixed,
    model,
    // The base policy with only the mode the call is allowed: its safety fields always reach the Agent.
    permissions: { ...policy, mode: mode === 'edit' ? 'edit' : 'analyze' },
    ...(cwd === undefined ? {} : { cwd }),
    ...(effort === undefined ? {} : { effort }),
  };
  const turn: TurnOptions = {
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(schema === undefined ? {} : { outputSchema: schema }),
  };
  return { options, turn };
}

function result(turn: Turn, options: TurnOptions, signal: AbortSignal): RunnerResult {
  const usage = turn.usage;
  const failed = (code: DynamicRunnerErrorCode, detail?: string) =>
    new DynamicRunnerError(code, { ...(detail === undefined ? {} : { detail }), ...(usage === undefined ? {} : { usage }) });
  if (turn.status === 'refused') throw failed('REFUSED');
  if (turn.status === 'interrupted') throw failed(signal.aborted ? 'ABORTED' : 'PROVIDER_FAILED', 'interrupted');
  if (turn.status !== 'completed') throw failed('PROVIDER_FAILED', turn.status === 'failed' ? 'failed' : 'unknown status');
  const text = typeof turn.text === 'string' ? turn.text : '';
  if (turn.output !== undefined && !isJson(turn.output, 0)) throw failed('OUTPUT_INVALID');
  return {
    text,
    ...(options.outputSchema !== undefined && turn.output !== undefined ? { output: turn.output as JsonValue } : {}),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * The provider's structured output the Agent rejected against the call's schema, when it is JSON: the
 * engine validates it and re-asks with the schema errors. Anything else (no output, not JSON, an invalid
 * schema) is not salvaged and fails as OUTPUT_INVALID.
 */
function rejectedOutput(error: unknown, options: TurnOptions): RunnerResult | undefined {
  if (options.outputSchema === undefined || !(error instanceof AgentRuntimeError) || error.code !== 'STRUCTURED_OUTPUT_ERROR') return undefined;
  const diagnostics: unknown = error.context.sanitizedDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object' || !Object.hasOwn(diagnostics, 'originalResponse')) return undefined;
  const output = (diagnostics as { originalResponse?: unknown }).originalResponse;
  if (output === undefined || !isJson(output, 0)) return undefined;
  const usage = error.context.observedUsage;
  const copy = structuredClone(output) as JsonValue;
  return { text: JSON.stringify(copy), output: copy, ...(usage === undefined ? {} : { usage }) };
}

function toRunnerError(error: unknown, signal: AbortSignal): DynamicRunnerError {
  if (error instanceof DynamicRunnerError) return error;
  if (error instanceof AgentRuntimeError) {
    const runtimeCode = error.code;
    const usage = error.context.observedUsage;
    const code: DynamicRunnerErrorCode = runtimeCode === 'TIMEOUT' ? 'TIMEOUT'
      : runtimeCode === 'ABORTED' ? 'ABORTED'
      : runtimeCode === 'USAGE_LIMIT' ? 'RATE_LIMITED'
      : runtimeCode === 'STRUCTURED_OUTPUT_ERROR' ? (schemaRefused(error) ? 'INVALID_REQUEST' : 'OUTPUT_INVALID')
      : UNSUPPORTED_CODES.has(runtimeCode) ? 'UNSUPPORTED'
      : signal.aborted ? 'ABORTED'
      : 'PROVIDER_FAILED';
    const retryAt = code === 'RATE_LIMITED' && typeof error.context.provider === 'string'
      ? observedUsageLimitReset(error, error.context.provider) : undefined;
    return new DynamicRunnerError(code, {
      runtimeCode, cause: error, ...(usage === undefined ? {} : { usage }), ...(retryAt === undefined ? {} : { retryAt }),
    });
  }
  if (signal.aborted) return new DynamicRunnerError('ABORTED', { cause: error });
  // TypeError/RangeError from the SDK's own validation, or anything else: never its text.
  return new DynamicRunnerError('PROVIDER_FAILED', { cause: error });
}

/** The Agent refused the schema itself (it did not compile): re-asking cannot help. */
function schemaRefused(error: AgentRuntimeError): boolean {
  const diagnostics: unknown = error.context.sanitizedDiagnostics;
  return !!diagnostics && typeof diagnostics === 'object' && Object.hasOwn(diagnostics, 'schemaError');
}

function isJson(value: unknown, depth: number): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJson(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(item => isJson(item, depth + 1));
}
