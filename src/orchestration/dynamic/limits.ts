/**
 * Dynamic workflows: limits, meta and per-call option validation.
 *
 * Everything here is synchronous and pure, so an invalid limit, meta or agent option is refused with a
 * `TypeError` before anything runs. Errors raised here are SDK-authored; the engine may surface their
 * message in a report (`isDynamicUsageError`), never a provider's text.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import { canonical, snapshot } from '../../shared/json.js';
import type {
  DynamicAgentOptions, DynamicJsonSchema, DynamicLimits, DynamicPermissionMode, DynamicWorkflowMeta, JsonValue,
} from './types.js';

const usageErrors = new WeakSet<Error>();

/** A `TypeError` the engine authored (its message is safe to report). */
export function dynamicUsageError(message: string): TypeError {
  const error = new TypeError(message);
  usageErrors.add(error);
  return error;
}

export function isDynamicUsageError(error: unknown): error is TypeError {
  return error instanceof TypeError && usageErrors.has(error);
}

/** Defaults and hard ceilings of `DynamicLimits` (the contract's JSDoc). */
export const DYNAMIC_LIMIT_BOUNDS = Object.freeze({
  maxAgents: Object.freeze({ min: 1, default: 50, max: 1000 }),
  /** The ceiling of the adaptive window. */
  concurrency: Object.freeze({ min: 1, default: 8, max: 16 }),
  /** Where the window starts; the default is min(4, concurrency) and it may never exceed `concurrency`. */
  initialConcurrency: Object.freeze({ min: 1, default: 4, max: 16 }),
  maxItems: Object.freeze({ min: 1, default: 256, max: 4096 }),
  schemaRetries: Object.freeze({ min: 0, default: 2, max: 5 }),
  rateLimitRetries: Object.freeze({ min: 0, default: 3, max: 10 }),
  /** 15 minutes by default; 24 hours at most (beyond that a timer is no longer a meaningful bound). */
  agentTimeoutMs: Object.freeze({ min: 1, default: 15 * 60_000, max: 24 * 60 * 60_000 }),
});

/**
 * The one shape an agent `effort` may take, wherever it is checked (call options, plans, the bundled
 * runner): a short lowercase word. `--effort <value>` reaches the CLI argv, so a value that could read as
 * an option never gets there.
 */
export const DYNAMIC_EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Prompt and schema size bounds, so one call cannot hold unbounded memory in the journal. */
export const DYNAMIC_PROMPT_MAX_CHARS = 1_000_000;
export const DYNAMIC_SCHEMA_MAX_CHARS = 65_536;
const LABEL_MAX = 128;
const TEXT_MAX = 4096;
const PHASES_MAX = 64;

export interface ResolvedDynamicLimits {
  readonly maxAgents: number;
  readonly concurrency: number;
  readonly initialConcurrency: number;
  readonly maxItems: number;
  readonly tokens: number | undefined;
  readonly agentTimeoutMs: number;
  readonly permissions: DynamicPermissionMode;
  readonly models: readonly string[];
  readonly schemaRetries: number;
  readonly rateLimitRetries: number;
}

/** Agent options after validation; `permissions` and `isolation` carry their defaults. */
export interface ResolvedAgentOptions {
  readonly label?: string;
  readonly phase?: string;
  readonly schema?: DynamicJsonSchema;
  readonly model?: string;
  readonly effort?: string;
  readonly permissions: DynamicPermissionMode;
  readonly isolation: 'none' | 'worktree';
  readonly timeoutMs?: number;
}

const PERMISSIONS: readonly DynamicPermissionMode[] = ['analyze', 'edit'];
const LIMIT_KEYS = [
  'maxAgents', 'concurrency', 'initialConcurrency', 'maxItems', 'tokens', 'agentTimeoutMs', 'permissions', 'models',
  'schemaRetries', 'rateLimitRetries',
];
const OPTION_KEYS = ['label', 'phase', 'schema', 'model', 'effort', 'permissions', 'isolation', 'timeoutMs'];

/** A plain data object (no proxy, accessor or class instance) with only the allowed keys. */
export function plainObject(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw dynamicUsageError(`${field} must be a plain object`);
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.includes(key)) throw dynamicUsageError(`${field} has an unknown field ${JSON.stringify(key.slice(0, 64))}`);
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw dynamicUsageError(`${field}.${key} must be a data property`);
    if (descriptor.value !== undefined) copy[key] = descriptor.value;
  }
  return copy;
}

/** A short single-line label: nonempty, at most `max` characters, no control characters. */
export function dynamicLabel(value: unknown, field: string, max = LABEL_MAX): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw dynamicUsageError(`${field} must be a nonempty single-line string of at most ${max} characters`);
  }
  return value;
}

function text(value: unknown, field: string, max = TEXT_MAX): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw dynamicUsageError(`${field} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

function integer(value: unknown, field: string, bounds: { min: number; max: number }): number {
  if (!Number.isSafeInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
    throw dynamicUsageError(`${field} must be an integer from ${bounds.min} to ${bounds.max}`);
  }
  return value as number;
}

function permission(value: unknown, field: string): DynamicPermissionMode {
  if (!PERMISSIONS.includes(value as DynamicPermissionMode)) throw dynamicUsageError(`${field} must be 'analyze' or 'edit'`);
  return value as DynamicPermissionMode;
}

/** Validates the application's limits and fills the defaults; out-of-range values are refused, never clamped. */
export function resolveDynamicLimits(limits: DynamicLimits | undefined): ResolvedDynamicLimits {
  const input = limits === undefined ? {} : plainObject(limits, 'Limits', LIMIT_KEYS);
  const bound = (key: keyof typeof DYNAMIC_LIMIT_BOUNDS): number =>
    input[key] === undefined ? DYNAMIC_LIMIT_BOUNDS[key].default : integer(input[key], `limits.${key}`, DYNAMIC_LIMIT_BOUNDS[key]);
  let models: string[] = [];
  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || input.models.length > 64) throw dynamicUsageError('limits.models must be an array of at most 64 model ids');
    models = input.models.map((model, index) => dynamicLabel(model, `limits.models[${index}]`));
    if (new Set(models).size !== models.length) throw dynamicUsageError('limits.models must not repeat a model id');
  }
  const concurrency = bound('concurrency');
  const initialConcurrency = input.initialConcurrency === undefined
    ? Math.min(DYNAMIC_LIMIT_BOUNDS.initialConcurrency.default, concurrency)
    : integer(input.initialConcurrency, 'limits.initialConcurrency', { min: DYNAMIC_LIMIT_BOUNDS.initialConcurrency.min, max: concurrency });
  return Object.freeze({
    maxAgents: bound('maxAgents'),
    concurrency,
    initialConcurrency,
    maxItems: bound('maxItems'),
    tokens: input.tokens === undefined ? undefined : integer(input.tokens, 'limits.tokens', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    agentTimeoutMs: bound('agentTimeoutMs'),
    permissions: input.permissions === undefined ? 'analyze' : permission(input.permissions, 'limits.permissions'),
    models: Object.freeze(models),
    schemaRetries: bound('schemaRetries'),
    rateLimitRetries: bound('rateLimitRetries'),
  });
}

/** Validates and copies the workflow's meta: labelled name, description, unique declared phases. */
export function validateDynamicMeta(meta: DynamicWorkflowMeta): DynamicWorkflowMeta {
  const input = plainObject(meta, 'Meta', ['name', 'description', 'phases']);
  const name = dynamicLabel(input.name, 'meta.name');
  const description = text(input.description, 'meta.description');
  if (input.phases === undefined) return Object.freeze({ name, description });
  if (!Array.isArray(input.phases) || input.phases.length > PHASES_MAX) {
    throw dynamicUsageError(`meta.phases must be an array of at most ${PHASES_MAX} phases`);
  }
  const phases = input.phases.map((phase, index) => {
    const entry = plainObject(phase, `meta.phases[${index}]`, ['title', 'detail']);
    const title = dynamicLabel(entry.title, `meta.phases[${index}].title`);
    return Object.freeze(entry.detail === undefined ? { title } : { title, detail: text(entry.detail, `meta.phases[${index}].detail`) });
  });
  if (new Set(phases.map(phase => phase.title)).size !== phases.length) throw dynamicUsageError('meta.phases titles must be unique');
  return Object.freeze({ name, description, phases: Object.freeze(phases) });
}

/** Strict JSON (no undefined, accessors, proxies, cycles or class instances), returned as plain objects. */
export function strictJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(snapshot(value))) as JsonValue;
}

/** Compiles schemas once per run (draft-07 as `outputSchema`, strict mode; unknown keywords and formats are refused). */
export class DynamicSchemaCache {
  readonly #ajv = new Ajv({ allErrors: true, strict: true });
  readonly #compiled = new Map<string, ValidateFunction>();

  compile(schema: DynamicJsonSchema): ValidateFunction {
    const key = canonical(schema);
    let validate = this.#compiled.get(key);
    if (!validate) {
      try { validate = this.#ajv.compile(schema); }
      catch { throw dynamicUsageError('Agent schema is not a valid JSON Schema (draft-07, strict mode)'); }
      this.#compiled.set(key, validate);
    }
    return validate;
  }
}

export interface AgentOptionScope {
  readonly limits: ResolvedDynamicLimits;
  readonly phases: ReadonlySet<string> | undefined;
  readonly isolationConfigured: boolean;
  readonly schemas: DynamicSchemaCache;
}

/** Validates one call's options against the run's limits; the result carries the defaults. */
export function resolveAgentOptions(options: DynamicAgentOptions | undefined, scope: AgentOptionScope): ResolvedAgentOptions {
  const input = options === undefined ? {} : plainObject(options, 'Agent options', OPTION_KEYS);
  const resolved: { -readonly [K in keyof ResolvedAgentOptions]: ResolvedAgentOptions[K] } = {
    permissions: input.permissions === undefined ? 'analyze' : permission(input.permissions, 'Agent permissions'),
    isolation: 'none',
  };
  if (input.label !== undefined) resolved.label = dynamicLabel(input.label, 'Agent label');
  if (input.phase !== undefined) {
    resolved.phase = dynamicLabel(input.phase, 'Agent phase');
    if (scope.phases && !scope.phases.has(resolved.phase)) throw dynamicUsageError(`Agent phase ${JSON.stringify(resolved.phase)} is not declared in meta.phases`);
  }
  if (resolved.permissions === 'edit' && scope.limits.permissions !== 'edit') {
    throw dynamicUsageError("Agent permissions 'edit' exceed the run's ceiling 'analyze'");
  }
  if (input.model !== undefined) {
    resolved.model = dynamicLabel(input.model, 'Agent model');
    if (!scope.limits.models.includes(resolved.model)) throw dynamicUsageError(`Agent model ${JSON.stringify(resolved.model)} is not allowed by limits.models`);
  }
  if (input.effort !== undefined) {
    if (typeof input.effort !== 'string' || !DYNAMIC_EFFORT_PATTERN.test(input.effort)) {
      throw dynamicUsageError('Agent effort must be a short lowercase word (^[a-z][a-z0-9-]{0,31}$)');
    }
    resolved.effort = input.effort;
  }
  if (input.isolation !== undefined) {
    if (input.isolation !== 'none' && input.isolation !== 'worktree') throw dynamicUsageError("Agent isolation must be 'none' or 'worktree'");
    if (input.isolation === 'worktree' && !scope.isolationConfigured) {
      throw dynamicUsageError("Agent isolation 'worktree' requires DynamicRunOptions.isolation");
    }
    resolved.isolation = input.isolation;
  }
  if (input.timeoutMs !== undefined) {
    resolved.timeoutMs = integer(input.timeoutMs, 'Agent timeoutMs', { min: 1, max: scope.limits.agentTimeoutMs });
  }
  if (input.schema !== undefined) {
    if (typeof input.schema !== 'object' || input.schema === null || Array.isArray(input.schema)) {
      throw dynamicUsageError('Agent schema must be a JSON Schema object');
    }
    let schema: DynamicJsonSchema;
    try { schema = strictJson(input.schema) as DynamicJsonSchema; }
    catch { throw dynamicUsageError('Agent schema must be strict JSON'); }
    if (JSON.stringify(schema).length > DYNAMIC_SCHEMA_MAX_CHARS) throw dynamicUsageError(`Agent schema exceeds ${DYNAMIC_SCHEMA_MAX_CHARS} characters`);
    scope.schemas.compile(schema);
    resolved.schema = schema;
  }
  return resolved;
}

export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > DYNAMIC_PROMPT_MAX_CHARS) {
    throw dynamicUsageError(`Agent prompt must be a nonempty string of at most ${DYNAMIC_PROMPT_MAX_CHARS} characters`);
  }
  return prompt;
}
