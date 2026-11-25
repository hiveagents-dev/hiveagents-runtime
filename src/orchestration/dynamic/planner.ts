import type { Runtime } from '../../core/runtime.js';
import type { AgentOptions, ContextPolicy, Turn } from '../../public/types.js';
import { DynamicPlanError, DynamicPlannerError, type DynamicPlanIssue } from './plan-error.js';
import {
  DYNAMIC_PLAN_JSON_SCHEMA, checkPlanArgs, estimatePlan, planLimits, validatePlan, type DynamicPlanEstimate,
} from './plan.js';
import { PLANNER_INSTRUCTIONS, plannerPrompt } from './planner-prompt.js';
import type { DynamicLimits, DynamicWorkflowPlan, JsonValue } from './types.js';

export { PLANNER_INSTRUCTIONS, describeArgs, plannerPrompt, type PlannerPromptInput } from './planner-prompt.js';

/**
 * A model writes the plan; the application approves and runs it.
 *
 * `planWorkflow` builds a restricted Agent for each attempt and closes it afterwards, with the same
 * discipline as the memory curator's distiller: `permissions: { mode: 'analyze' }`, the exec transport,
 * `context: { profile: 'clean', memory: 'off' }`, `memory: false`, no application tools, no pinned
 * constraints, and for Claude `providerOptions.claude = { tools: [], strictMcpConfig: true }` (`--tools ""`
 * and `--strict-mcp-config` without an MCP config: no built-in tool and no MCP server). Options that would
 * change any of that are refused with a TypeError. Any provider other than Claude is refused unless the
 * caller passes `allowProviderReadTools: true`, accepting that the CLI keeps its read tools.
 *
 * The goal reaches the model as an indented, labelled data block, never as instructions; the limits are
 * stated in the prompt and enforced by `validatePlan`. A reply that is not JSON or not a valid plan is
 * sent back with every validation error, up to `maxRepairs` times; after that `DynamicPlannerError`.
 * The planner never runs the plan.
 *
 * The Agent class is loaded on the first call, so importing this module does not load the runtime.
 */

/** The Agent options a planner may set; everything that grants tools, permissions, context or memory is excluded. */
export type PlannerAgentOptions = Omit<
  AgentOptions, 'tools' | 'permissions' | 'memory' | 'pinned' | 'instructions' | 'providerOptions' | 'transport' | 'context'
> & {
  /** Only `exec`, which is forced anyway. */
  transport?: 'exec';
  /** Only the clean profile with provider memory off, which is forced anyway. */
  context?: { profile?: 'clean'; memory?: 'off' };
};

export interface PlanWorkflowOptions {
  /** What the workflow should achieve; untrusted data for the planner. */
  goal: string;
  agent: PlannerAgentOptions;
  /** Runtime the planner's Agents run on. Default: the SDK's default runtime. */
  runtime?: Runtime;
  /** The limits the plan will run under; stated in the prompt and enforced by validation. */
  limits?: DynamicLimits;
  /** The run's args: the planner sees their shape (paths and types, never values); the estimate counts maps over them. */
  args?: JsonValue;
  /** Application guidance appended to the fixed instructions. */
  instructions?: string;
  /** Required for a provider other than Claude: that CLI keeps its read tools. Default false. */
  allowProviderReadTools?: boolean;
  /** Re-asks after an invalid reply: integer 0..5, default 2. */
  maxRepairs?: number;
  /** Deadline of each planner turn in milliseconds. Default: 300 000. */
  timeoutMs?: number;
  /** Ask through `outputSchema` (default true); false parses the turn text strictly instead. */
  structuredOutput?: boolean;
  signal?: AbortSignal;
}

export interface PlannedWorkflow {
  readonly plan: DynamicWorkflowPlan;
  readonly estimate: DynamicPlanEstimate;
  /** Planner turns used: 1 plus the repairs. */
  readonly attempts: number;
}

const REFUSED_AGENT_OPTIONS = ['tools', 'permissions', 'memory', 'pinned', 'instructions', 'providerOptions'] as const;
const CLEAN_CONTEXT: ContextPolicy = Object.freeze({ profile: 'clean', memory: 'off' });
const MAX_GOAL_CHARS = 16_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value as number;
}

function plannerOptions(input: PlanWorkflowOptions): AgentOptions {
  const { agent, instructions } = input;
  if (!agent || typeof agent !== 'object' || typeof agent.model !== 'string') throw new TypeError('agent must be Agent options with a model');
  for (const key of REFUSED_AGENT_OPTIONS) {
    if (Object.hasOwn(agent, key)) throw new TypeError(`A planner never takes ${key}: it runs read-only, without tools or memory`);
  }
  if (agent.transport !== undefined && agent.transport !== 'exec') throw new TypeError('A planner runs on the exec transport only');
  const context = agent.context as ContextPolicy | undefined;
  if (context !== undefined && (!context || typeof context !== 'object'
    || (context.profile ?? 'clean') !== 'clean' || (context.memory ?? 'off') !== 'off'
    || Object.keys(context).some(key => key !== 'profile' && key !== 'memory'))) {
    throw new TypeError("A planner runs with context { profile: 'clean', memory: 'off' } only");
  }
  if (instructions !== undefined && typeof instructions !== 'string') throw new TypeError('instructions must be a string');
  return {
    ...agent,
    instructions: instructions?.trim() ? `${PLANNER_INSTRUCTIONS}\n\nApplication guidance:\n${instructions}` : PLANNER_INSTRUCTIONS,
    permissions: { mode: 'analyze' },
    transport: 'exec',
    context: { ...CLEAN_CONTEXT },
    // `tools: []` is passed as `--tools ""`: no built-in tool. Strict MCP with no config: no MCP server.
    providerOptions: { claude: { tools: [], strictMcpConfig: true } },
    memory: false,
  };
}

/** The reply of one planner turn: the structured output, or the whole text parsed strictly as JSON. */
export function parsePlanReply(turn: Turn, structured: boolean): unknown {
  if (turn.status !== 'completed') throw new Error(`The planner turn ended ${turn.status}`);
  if (structured && turn.output !== undefined) return turn.output;
  try {
    return JSON.parse(typeof turn.text === 'string' ? turn.text.trim() : '');
  } catch {
    throw DynamicPlanError.of('NOT_JSON', '$', 'the reply is not one JSON object (no prose or code fence is accepted)');
  }
}

export async function planWorkflow(input: PlanWorkflowOptions): Promise<PlannedWorkflow> {
  if (!input || typeof input !== 'object') throw new TypeError('planWorkflow needs an options object');
  const { goal, runtime, limits, args, signal } = input;
  if (typeof goal !== 'string' || !goal.trim()) throw new TypeError('goal must be a non-empty string');
  if (goal.length > MAX_GOAL_CHARS) throw new RangeError(`goal must be at most ${MAX_GOAL_CHARS} characters`);
  const options = plannerOptions(input);
  const resolved = planLimits(limits);
  const maxRepairs = boundedInteger(input.maxRepairs, 'maxRepairs', 0, 5, 2);
  const timeoutMs = boundedInteger(input.timeoutMs, 'timeoutMs', 1, MAX_TIMER_MS, 300_000);
  const structured = input.structuredOutput !== false;
  const allowReadTools = input.allowProviderReadTools === true;
  const refuseProvider = (provider: string) => {
    if (provider !== 'claude' && !allowReadTools) {
      throw new TypeError(`A ${provider} planner keeps the CLI's read tools: pass allowProviderReadTools: true to accept that`);
    }
  };
  if (runtime) refuseProvider(runtime.resolveModel(options.model).provider);
  // Loaded here, not at module level: the orchestration entry must not load the whole runtime.
  const { Agent } = await import('../../public/agent.js');

  let previous: { reply: string; issues: readonly DynamicPlanIssue[] } | undefined;
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt += 1) {
    signal?.throwIfAborted();
    const prompt = plannerPrompt({ goal, limits: resolved, ...(args !== undefined ? { args } : {}), ...(previous ? { previous } : {}) });
    const planner = runtime ? new Agent(options, runtime) : new Agent(options);
    let reply: unknown = NO_REPLY;
    let text = '';
    let issues: readonly DynamicPlanIssue[] = [];
    try {
      refuseProvider(planner.model.provider);
      const turn = await planner.send(prompt, {
        timeoutMs,
        ...(signal ? { signal } : {}),
        ...(structured ? { outputSchema: DYNAMIC_PLAN_JSON_SCHEMA as Record<string, unknown> } : {}),
      });
      text = typeof turn.text === 'string' ? turn.text : '';
      reply = parsePlanReply(turn, structured);
    } catch (error) {
      const rejected = rejectedOutput(error);
      if (error instanceof DynamicPlanError) issues = error.issues;
      else if (rejected) ({ reply, issues } = rejected);
      else throw error;
    } finally {
      await planner.close().catch(() => undefined);
    }
    if (reply !== NO_REPLY) {
      try {
        const plan = validatePlan(reply, limits);
        if (args !== undefined) checkPlanArgs(plan, args, limits);
        return { plan, estimate: estimatePlan(plan, args, limits), attempts: attempt };
      } catch (error) {
        if (!(error instanceof DynamicPlanError)) throw error;
        issues = error.issues;
      }
    }
    previous = { reply: reply === NO_REPLY ? text : JSON.stringify(reply, null, 2) ?? '', issues };
  }
  throw new DynamicPlannerError(maxRepairs + 1, previous?.issues ?? []);
}

const NO_REPLY = Symbol('no reply');

/**
 * A structured reply the Agent rejected against `DYNAMIC_PLAN_JSON_SCHEMA` (a STRUCTURED_OUTPUT_ERROR with
 * the validation errors): repairable like any invalid plan. `validatePlan` then names the issues precisely;
 * the schema's own errors are the fallback.
 */
function rejectedOutput(error: unknown): { reply: unknown; issues: DynamicPlanIssue[] } | undefined {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'STRUCTURED_OUTPUT_ERROR') return undefined;
  const diagnostics = (error as { context?: { sanitizedDiagnostics?: unknown } }).context?.sanitizedDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object' || !Object.hasOwn(diagnostics, 'originalResponse')) return undefined;
  const { originalResponse, validationErrors } = diagnostics as { originalResponse: unknown; validationErrors?: unknown };
  const issues = (Array.isArray(validationErrors) ? validationErrors : []).slice(0, 64).map((entry): DynamicPlanIssue => {
    const { instancePath, message } = (entry ?? {}) as { instancePath?: unknown; message?: unknown };
    const path = typeof instancePath === 'string' ? instancePath.split('/').slice(1)
      .map(part => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`)).join('') : '';
    return { code: 'SHAPE', path: `$${path}`, message: typeof message === 'string' ? message : 'does not match the plan schema' };
  });
  return { reply: originalResponse, issues };
}
