import Ajv from 'ajv';

import { freeze, snapshot } from '../../shared/json.js';
import { DependencyCycleError, dependencyWaves } from '../workflow/graph.js';
import { DYNAMIC_EFFORT_PATTERN, resolveDynamicLimits } from './limits.js';
import { DynamicPlanError, type DynamicPlanErrorCode, type DynamicPlanIssue } from './plan-error.js';
import { PLAN_BOUNDS } from './plan-schema.js';
import { STEP_ID, parseReference, resolvePath, templateReferences, type TemplateReference } from './template.js';
import type {
  DynamicLimits, DynamicPermissionMode, DynamicPlanStep, DynamicWorkflowMeta, DynamicWorkflowPlan, JsonValue,
} from './types.js';

export { DYNAMIC_PLAN_JSON_SCHEMA, PLAN_BOUNDS } from './plan-schema.js';

/**
 * Plan validation: a plan is JSON a model may write, so it is checked as untrusted input before anything
 * runs. Every object is closed (an unknown key anywhere is an error), every string is bounded, every
 * reference resolves, the step graph is acyclic and nothing exceeds the application's `DynamicLimits`.
 */

/** The limits a plan is checked against, with the contract's defaults applied. */
export interface PlanLimits {
  readonly maxAgents: number;
  readonly maxItems: number;
  readonly agentTimeoutMs: number;
  readonly permissions: DynamicPermissionMode;
  readonly models: readonly string[];
}

const MAX_ISSUES = 64;
const RESULT_TYPES = new Set(['object', 'array', 'string', 'number', 'integer']);
const COMMON_KEYS = ['kind', 'id', 'prompt', 'phase', 'schema', 'model', 'effort', 'permissions', 'isolation', 'timeoutMs'];
const STEP_KEYS = { agent: COMMON_KEYS, map: [...COMMON_KEYS, 'over', 'maxItems'] } as const;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
// Keep in step with the bundled runner's effort rule (agent-runner.ts), so a plan never names an effort it refuses.
const EFFORT = DYNAMIC_EFFORT_PATTERN;
/** Keywords whose value ajv runs as a regular expression over the agent's (model-steerable) output. */
const REGEX_KEYWORDS = new Set(['pattern', 'patternProperties', 'format']);
// Identifiers register a schema under a name in the compiler: a model-written id could collide with, or
// shadow, another schema compiled in the same process. Plans use inline schemas only.
const ID_KEYWORDS = new Set(['$id', '$anchor', '$dynamicAnchor', '$recursiveAnchor', '$schema']);
/** Keywords holding data, not subschemas: never searched for keywords. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);
/** Keywords whose value maps names (any string, `pattern` included) to subschemas. */
const SCHEMA_MAPS = new Set(['properties', 'definitions', '$defs', 'dependentSchemas', 'dependencies']);

/**
 * Applies the contract defaults to `DynamicLimits` through the engine's own `resolveDynamicLimits`, so a
 * plan is checked against exactly the limits the run enforces. A malformed limit is the application's
 * error: a TypeError, the same the engine throws.
 */
export function planLimits(limits?: DynamicLimits): PlanLimits {
  const resolved = resolveDynamicLimits(limits);
  return Object.freeze({
    maxAgents: resolved.maxAgents,
    maxItems: resolved.maxItems,
    agentTimeoutMs: resolved.agentTimeoutMs,
    permissions: resolved.permissions,
    models: resolved.models,
  });
}

class Issues {
  readonly list: DynamicPlanIssue[] = [];
  add(code: DynamicPlanErrorCode, path: string, message: string): void {
    if (this.list.length < MAX_ISSUES) this.list.push({ code, path, message });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closed(value: unknown, path: string, allowed: readonly string[], required: readonly string[], issues: Issues): value is Record<string, unknown> {
  if (!isRecord(value)) { issues.add('SHAPE', path, 'must be a JSON object'); return false; }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.add('UNKNOWN_KEY', `${path}.${key}`, `unknown key (allowed: ${allowed.join(', ')})`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) issues.add('MISSING', `${path}.${key}`, 'is required');
  return true;
}

function label(value: unknown, path: string, maximum: number, issues: Issues, multiline = false): string | undefined {
  if (value === undefined) return undefined; // reported as MISSING by `closed`
  if (typeof value !== 'string' || !value.trim()) { issues.add('LABEL', path, 'must be a non-empty string'); return undefined; }
  if (value.length > maximum) { issues.add('LABEL', path, `must be at most ${maximum} characters`); return undefined; }
  // CONTROL leaves out \t and \n, which only a multi-line label may hold.
  if (CONTROL.test(value) || (!multiline && /[\n\t]/.test(value))) {
    issues.add('LABEL', path, multiline ? 'must not contain control characters' : 'must be one line without control characters');
    return undefined;
  }
  return value;
}

function hasProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProtoKey);
  if (!isRecord(value)) return false;
  return Object.keys(value).some(key => key === '__proto__' || hasProtoKey(value[key]));
}

/**
 * Finds every regex-backed keyword in a plan schema. ajv runs such a regex synchronously over the agent's
 * output, which a prompt injection can steer: a backtracking pattern would block the event loop past every
 * timeout. A plan (model-written) may not use them; a script's schema (application code) still may.
 */
function regexKeywords(schema: unknown, path: string, issues: Issues): number {
  if (Array.isArray(schema)) return schema.reduce((found: number, entry, index) => found + regexKeywords(entry, `${path}[${index}]`, issues), 0);
  if (!isRecord(schema)) return 0;
  let found = 0;
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}.${key}`;
    if (REGEX_KEYWORDS.has(key)) {
      issues.add('SCHEMA_PATTERN', at, `"${key}" is not allowed in a plan schema (a regular expression over agent output); use enum, const, minLength or maxLength`);
      found += 1;
    } else if (ID_KEYWORDS.has(key)) {
      issues.add('SCHEMA', at, `"${key}" is not allowed in a plan schema (plans use inline schemas, never named ones)`);
      found += 1;
    } else if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      for (const [name, entry] of Object.entries(value)) found += regexKeywords(entry, `${at}.${name}`, issues);
    } else if (!DATA_KEYWORDS.has(key)) {
      found += regexKeywords(value, at, issues);
    }
  }
  return found;
}

function checkSchema(value: unknown, path: string, issues: Issues, compiler: () => Ajv): Record<string, unknown> | undefined {
  if (!isRecord(value)) { issues.add('SCHEMA', path, 'must be a JSON Schema object'); return undefined; }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PLAN_BOUNDS.schemaBytes) {
    issues.add('SCHEMA', path, `must be at most ${PLAN_BOUNDS.schemaBytes} bytes`); return undefined;
  }
  if (hasProtoKey(value)) { issues.add('SCHEMA', path, 'must not use the key __proto__'); return undefined; }
  if (regexKeywords(value, path, issues) > 0) return undefined;
  if (typeof value.type !== 'string' || !RESULT_TYPES.has(value.type)) {
    issues.add('SCHEMA', `${path}.type`, 'must be "object", "array", "string", "number" or "integer"'); return undefined;
  }
  const ajv = compiler();
  try {
    ajv.compile(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.add('SCHEMA', path, `does not compile: ${message.length > 200 ? `${message.slice(0, 197)}...` : message}`);
    return undefined;
  } finally {
    ajv.removeSchema();
  }
  return value;
}

function phasesOf(value: unknown, issues: Issues): Array<{ title: string; detail?: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > PLAN_BOUNDS.phases) {
    issues.add('PHASE', '$.meta.phases', `must be an array of 1..${PLAN_BOUNDS.phases} phases`); return undefined;
  }
  const seen = new Set<string>();
  return value.flatMap((phase, index) => {
    const path = `$.meta.phases[${index}]`;
    if (!closed(phase, path, ['title', 'detail'], ['title'], issues)) return [];
    const title = label(phase.title, `${path}.title`, PLAN_BOUNDS.nameChars, issues);
    const detail = phase.detail === undefined ? undefined : label(phase.detail, `${path}.detail`, PLAN_BOUNDS.descriptionChars, issues, true);
    if (title === undefined) return [];
    if (seen.has(title)) issues.add('DUPLICATE', `${path}.title`, `phase "${title}" is declared twice`);
    seen.add(title);
    return [detail === undefined ? { title } : { title, detail }];
  });
}

interface CheckedStep {
  readonly step: Record<string, unknown>;
  readonly path: string;
  readonly references: Array<{ reference: TemplateReference; path: string }>;
}

function checkStep(raw: unknown, index: number, context: {
  /** Declared phase titles; undefined when none are declared, null when the declaration itself is invalid. */
  limits: PlanLimits; phases: ReadonlySet<string> | undefined | null; issues: Issues; compiler: () => Ajv;
}): CheckedStep | undefined {
  const { limits, phases, issues } = context;
  const path = `$.steps[${index}]`;
  const kind = isRecord(raw) ? raw.kind : undefined;
  if (isRecord(raw) && kind !== 'agent' && kind !== 'map') issues.add('TYPE', `${path}.kind`, 'must be "agent" or "map"');
  const keys = kind === 'agent' || kind === 'map' ? STEP_KEYS[kind] : STEP_KEYS.map;
  if (!closed(raw, path, keys, kind === 'map' ? ['kind', 'id', 'prompt', 'over'] : ['kind', 'id', 'prompt'], issues)) return undefined;
  const step: Record<string, unknown> = { kind: raw.kind, id: raw.id, prompt: raw.prompt };
  const references: CheckedStep['references'] = [];
  if (typeof raw.id !== 'string' || !STEP_ID.test(raw.id)) issues.add('ID', `${path}.id`, `must match ${STEP_ID.source}`);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
    issues.add('TYPE', `${path}.prompt`, 'must be a non-empty string');
  } else if (Buffer.byteLength(raw.prompt, 'utf8') > PLAN_BOUNDS.promptBytes) {
    issues.add('LIMIT', `${path}.prompt`, `must be at most ${PLAN_BOUNDS.promptBytes} bytes`);
  } else {
    try {
      for (const reference of templateReferences(raw.prompt)) {
        if (kind !== 'map' && (reference.kind === 'item' || reference.kind === 'index')) {
          issues.add('REFERENCE', `${path}.prompt`, `{{${reference.source}}} is only available in a map step`);
        }
        references.push({ reference, path: `${path}.prompt` });
      }
    } catch (error) {
      issues.add('TEMPLATE', `${path}.prompt`, (error as Error).message.replace(/^\$: /, ''));
    }
  }
  if (kind === 'map' && raw.over !== undefined) {
    if (typeof raw.over !== 'string' || raw.over.length > PLAN_BOUNDS.overChars) {
      issues.add('TYPE', `${path}.over`, `must be a reference string of at most ${PLAN_BOUNDS.overChars} characters`);
    } else {
      try {
        const reference = parseReference(raw.over);
        if (reference.kind !== 'args' && reference.kind !== 'steps') throw new Error('over must be args.<path>, steps.<id> or steps.<id>.<path>');
        references.push({ reference, path: `${path}.over` });
        step.over = reference.source;
      } catch (error) {
        issues.add('REFERENCE', `${path}.over`, (error as Error).message);
      }
    }
  }
  if (raw.phase !== undefined) {
    const phase = label(raw.phase, `${path}.phase`, PLAN_BOUNDS.nameChars, issues);
    if (phase !== undefined && phases === undefined) issues.add('PHASE', `${path}.phase`, 'names a phase but meta.phases declares none');
    else if (phase !== undefined && phases && !phases.has(phase)) issues.add('PHASE', `${path}.phase`, `"${phase}" is not a declared phase`);
    step.phase = raw.phase;
  } else if (phases) {
    issues.add('PHASE', `${path}.phase`, 'is required when meta.phases is declared');
  }
  if (raw.schema !== undefined) step.schema = checkSchema(raw.schema, `${path}.schema`, issues, context.compiler);
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !limits.models.includes(raw.model)) {
      issues.add('MODEL', `${path}.model`, limits.models.length
        ? `must be one of the allowed models: ${limits.models.join(', ')}` : 'no model may be named: omit it for the default model');
    }
    step.model = raw.model;
  }
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || !EFFORT.test(raw.effort)) issues.add('TYPE', `${path}.effort`, `must match ${EFFORT.source}`);
    step.effort = raw.effort;
  }
  if (raw.permissions !== undefined) {
    if (raw.permissions !== 'analyze' && raw.permissions !== 'edit') issues.add('TYPE', `${path}.permissions`, 'must be "analyze" or "edit"');
    else if (raw.permissions === 'edit' && limits.permissions !== 'edit') issues.add('PERMISSIONS', `${path}.permissions`, 'exceeds the run ceiling "analyze"');
    step.permissions = raw.permissions;
  }
  if (raw.isolation !== undefined) {
    if (raw.isolation !== 'none' && raw.isolation !== 'worktree') issues.add('TYPE', `${path}.isolation`, 'must be "none" or "worktree"');
    step.isolation = raw.isolation;
  }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1 || (raw.timeoutMs as number) > limits.agentTimeoutMs) {
      issues.add('LIMIT', `${path}.timeoutMs`, `must be an integer in 1..${limits.agentTimeoutMs}`);
    }
    step.timeoutMs = raw.timeoutMs;
  }
  if (kind === 'map' && raw.maxItems !== undefined) {
    if (!Number.isSafeInteger(raw.maxItems) || (raw.maxItems as number) < 1 || (raw.maxItems as number) > limits.maxItems) {
      issues.add('LIMIT', `${path}.maxItems`, `must be an integer in 1..${limits.maxItems}`);
    }
    step.maxItems = raw.maxItems;
  }
  return { step, path, references };
}

/** Steps whose outputs a step reads (templates and `over`), without duplicates, in first-use order. */
export function stepDependencies(step: DynamicPlanStep): string[] {
  const ids = templateReferences(step.prompt).flatMap(reference => (reference.kind === 'steps' ? [reference.step] : []));
  if (step.kind === 'map') {
    const over = parseReference(step.over);
    if (over.kind === 'steps') ids.unshift(over.step);
  }
  return [...new Set(ids)];
}

/** The plan's steps in dependency waves: each wave's steps depend only on earlier waves. */
export function planWaves(plan: DynamicWorkflowPlan): DynamicPlanStep[][] {
  return dependencyWaves(plan.steps.map(step => ({ id: step.id, dependencies: stepDependencies(step), step })))
    .map(wave => wave.map(entry => entry.step));
}

function checkReferences(checked: readonly CheckedStep[], issues: Issues): void {
  const byId = new Map<string, Record<string, unknown>>();
  for (const { step } of checked) if (typeof step.id === 'string') byId.set(step.id, step);
  for (const { references } of checked) {
    for (const { reference, path } of references) {
      if (reference.kind !== 'steps') continue;
      const target = byId.get(reference.step);
      if (!target) { issues.add('REFERENCE', path, `{{${reference.source}}} names no step of the plan`); continue; }
      const textual = target.kind === 'agent' && target.schema === undefined;
      const isOver = path.endsWith('.over');
      if (textual && (reference.path.length > 0 || isOver)) {
        issues.add('REFERENCE', path, `step ${reference.step} has no schema: its output is text, so ${isOver ? 'it is not an array' : 'it has no fields'}`);
      } else if (isOver && reference.path.length === 0 && target.kind === 'agent' && (target.schema as { type?: unknown } | undefined)?.type !== 'array') {
        issues.add('REFERENCE', path, `step ${reference.step} does not return an array (its schema type is not "array")`);
      }
    }
  }
}

/**
 * Validates a plan and returns a frozen, typed copy holding only the known keys. Throws `DynamicPlanError`
 * listing every issue found (code + JSON path). `limits` are the run's limits: a plan never exceeds them.
 */
export function validatePlan(value: unknown, limits?: DynamicLimits): DynamicWorkflowPlan {
  const resolved = planLimits(limits);
  let input: unknown;
  try {
    input = JSON.parse(JSON.stringify(snapshot(value)));
  } catch {
    throw DynamicPlanError.of('NOT_JSON', '$', 'must be plain JSON data (no functions, accessors, cycles or non-finite numbers)');
  }
  const issues = new Issues();
  let ajv: Ajv | undefined;
  const compiler = () => (ajv ??= new Ajv({ allErrors: true, strict: true }));
  if (!closed(input, '$', ['format', 'meta', 'steps', 'result'], ['format', 'meta', 'steps'], issues)) throw new DynamicPlanError(issues.list);
  if (input.format !== undefined && input.format !== 1) issues.add('FORMAT', '$.format', 'must be 1');
  let meta: DynamicWorkflowMeta | undefined;
  let phases: ReadonlySet<string> | undefined | null;
  if (input.meta !== undefined && closed(input.meta, '$.meta', ['name', 'description', 'phases'], ['name', 'description'], issues)) {
    const name = label(input.meta.name, '$.meta.name', PLAN_BOUNDS.nameChars, issues);
    const description = label(input.meta.description, '$.meta.description', PLAN_BOUNDS.descriptionChars, issues, true);
    const declared = phasesOf(input.meta.phases, issues);
    if (input.meta.phases !== undefined) phases = declared ? new Set(declared.map(phase => phase.title)) : null;
    meta = { name: name ?? '', description: description ?? '', ...(declared ? { phases: declared } : {}) };
  }
  const checked: CheckedStep[] = [];
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > PLAN_BOUNDS.steps) {
      issues.add('LIMIT', '$.steps', `must be an array of 1..${PLAN_BOUNDS.steps} steps`);
    } else {
      input.steps.forEach((raw, index) => {
        const step = checkStep(raw, index, { limits: resolved, phases, issues, compiler });
        if (step) checked.push(step);
      });
      const agents = input.steps.filter(step => isRecord(step) && step.kind === 'agent').length;
      if (agents > resolved.maxAgents) issues.add('LIMIT', '$.steps', `declares ${agents} agent steps; the run allows ${resolved.maxAgents} agents`);
    }
  }
  const seen = new Set<string>();
  for (const { step, path } of checked) {
    if (typeof step.id !== 'string') continue;
    if (seen.has(step.id)) issues.add('DUPLICATE', `${path}.id`, `step id "${step.id}" is used twice`);
    seen.add(step.id);
  }
  checkReferences(checked, issues);
  if (input.result !== undefined && (typeof input.result !== 'string' || !seen.has(input.result))) {
    issues.add('RESULT', '$.result', 'must name a step of the plan');
  }
  // The cycle check needs a well-formed graph: every id valid and unique (unknown references are skipped).
  const ids = checked.map(({ step }) => step.id);
  if (ids.every(id => typeof id === 'string' && STEP_ID.test(id)) && seen.size === ids.length) {
    try {
      dependencyWaves(checked.map(({ step, references }) => ({
        id: step.id as string,
        dependencies: [...new Set(references.flatMap(({ reference }) =>
          (reference.kind === 'steps' && seen.has(reference.step) ? [reference.step] : [])))],
      })));
    } catch (error) {
      if (!(error instanceof DependencyCycleError)) throw error;
      issues.add('CYCLE', '$.steps', `the steps reference each other in a cycle: ${error.cycle.join(' -> ')}`);
    }
  }
  if (issues.list.length > 0) throw new DynamicPlanError(issues.list);
  const plan: DynamicWorkflowPlan = {
    format: 1,
    meta: meta!,
    steps: checked.map(({ step }) => step as unknown as DynamicPlanStep),
    ...(input.result !== undefined ? { result: input.result as string } : {}),
  };
  return freeze(plan);
}

export type DynamicAgentCount = number | 'unknown-until-run';

export interface DynamicPlanEstimate {
  /** Agent calls of a full run: exact when every map is over `args`, else 'unknown-until-run'. */
  readonly agents: DynamicAgentCount;
  /** Agent calls known now (maps over earlier outputs count 0). */
  readonly minAgents: number;
  /** Most agent calls the limits allow (each unknown map at its item ceiling). */
  readonly maxAgents: number;
  /** Dependency waves (sequential stages). */
  readonly waves: number;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly kind: 'agent' | 'map'; readonly phase?: string; readonly agents: DynamicAgentCount }>;
  readonly phases: ReadonlyArray<{ readonly title: string; readonly agents: DynamicAgentCount }>;
}

/**
 * Cost projection of a validated plan, without running anything. A map over `args` is counted from
 * `args`; one that is not an array or holds more items than allowed throws `DynamicPlanError` now,
 * as the run would refuse it before its first call.
 */
export function estimatePlan(plan: DynamicWorkflowPlan, args?: JsonValue, limits?: DynamicLimits): DynamicPlanEstimate {
  const resolved = planLimits(limits);
  let maxAgents = 0;
  const steps = plan.steps.map((step, index) => {
    let agents: DynamicAgentCount = 1;
    if (step.kind === 'map') {
      const ceiling = step.maxItems ?? resolved.maxItems;
      const over = parseReference(step.over);
      agents = 'unknown-until-run';
      if (over.kind === 'args') {
        const items = resolvePath(args, over.path);
        agents = itemCount(items, ceiling, `$.steps[${index}].over`, over.source);
      }
      maxAgents += typeof agents === 'number' ? agents : ceiling;
    } else {
      maxAgents += 1;
    }
    return { id: step.id, kind: step.kind, ...(step.phase !== undefined ? { phase: step.phase } : {}), agents };
  });
  const sum = (counts: readonly DynamicAgentCount[]): DynamicAgentCount =>
    counts.every(count => typeof count === 'number') ? (counts as number[]).reduce((a, b) => a + b, 0) : 'unknown-until-run';
  return freeze({
    agents: sum(steps.map(step => step.agents)),
    minAgents: steps.reduce((total, step) => total + (typeof step.agents === 'number' ? step.agents : 0), 0),
    maxAgents,
    waves: planWaves(plan).length,
    steps,
    phases: (plan.meta.phases ?? []).map(phase => ({
      title: phase.title, agents: sum(steps.filter(step => step.phase === phase.title).map(step => step.agents)),
    })),
  });
}

/**
 * Checks a validated plan against the run's args before anything runs: every `{{args.<path>}}` names a
 * value and every map over `args` is an array within its item ceiling. Throws `DynamicPlanError`.
 */
export function checkPlanArgs(plan: DynamicWorkflowPlan, args: JsonValue | undefined, limits?: DynamicLimits): void {
  const resolved = planLimits(limits);
  for (const [index, step] of plan.steps.entries()) {
    const path = `$.steps[${index}]`;
    for (const reference of templateReferences(step.prompt)) {
      if (reference.kind === 'args' && resolvePath(args, reference.path) === undefined) {
        throw DynamicPlanError.of('MISSING_VALUE', `${path}.prompt`, `{{${reference.source}}} names no value in args`);
      }
    }
    if (step.kind !== 'map') continue;
    const over = parseReference(step.over);
    if (over.kind === 'args') itemCount(resolvePath(args, over.path), step.maxItems ?? resolved.maxItems, `${path}.over`, over.source);
  }
}

/** The number of items a map runs over; throws OVER_NOT_ARRAY / MAX_ITEMS. */
export function itemCount(items: JsonValue | undefined, ceiling: number, path: string, source: string): number {
  if (!Array.isArray(items)) {
    throw DynamicPlanError.of('OVER_NOT_ARRAY', path, `${source} is ${items === undefined ? 'absent' : items === null ? 'null' : `a ${typeof items}`}, not an array`);
  }
  if (items.length > ceiling) throw DynamicPlanError.of('MAX_ITEMS', path, `${source} has ${items.length} items; at most ${ceiling} are allowed`);
  return items.length;
}
