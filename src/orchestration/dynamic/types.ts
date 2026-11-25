/**
 * Dynamic workflows: the public contract.
 *
 * A dynamic workflow is an orchestration the model (or the application) writes for one task at run time:
 * which agents run, in what order, over which items, with what structured output. It then runs
 * deterministically under limits the application sets, every agent call is journaled, and an interrupted
 * run resumes from its journal without re-running the agents that already finished.
 *
 * Two authoring forms run on one engine:
 * - a `DynamicWorkflowPlan`: JSON data a model can write safely (never code), validated before it runs;
 * - a `DynamicWorkflowScript`: an application-written async function over `DynamicWorkflowContext`
 *   (`agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`).
 *
 * Every agent call is a real `Agent` turn: a CLI process the SDK launches. Nothing here only records
 * intent; a call either ran (and its turn is in the journal) or it did not.
 */
import type { JsonValue } from '../workflow/types.js';
import type { Usage } from '../../public/types.js';

export type { JsonValue };

/** JSON Schema (draft-07, strict ajv: the same dialect as `TurnOptions.outputSchema`) for an agent's structured output. */
export type DynamicJsonSchema = Record<string, unknown>;

/** The most an agent of the run may do; a plan or script can only narrow it, never widen it. */
export type DynamicPermissionMode = 'analyze' | 'edit';

/** Options of one agent call, shared by plans and scripts. */
export interface DynamicAgentOptions {
  /** Short, unique within the run when given; shown in events and the journal. */
  readonly label?: string;
  /** Phase title (must be one of the declared phases when the workflow declares them). */
  readonly phase?: string;
  /** Structured output: the result is the parsed, schema-valid object; otherwise the turn text. */
  readonly schema?: DynamicJsonSchema;
  /** A model id the application allows (`DynamicLimits.models`); default: the application's default. */
  readonly model?: string;
  readonly effort?: string;
  /** At most the run's ceiling; default 'analyze'. */
  readonly permissions?: DynamicPermissionMode;
  /** 'worktree' runs the agent in its own git worktree (requires `DynamicRunOptions.isolation`). */
  readonly isolation?: 'none' | 'worktree';
  /** Per-call timeout; at most `DynamicLimits.agentTimeoutMs`. */
  readonly timeoutMs?: number;
}

/** A finished agent call as the journal keeps it and the caller receives it. */
export interface DynamicAgentResult {
  readonly key: string;
  readonly label?: string;
  readonly status: 'completed' | 'failed' | 'skipped';
  /** Parsed object when a schema was given, else the turn text; `null` when failed or skipped. */
  readonly output: JsonValue;
  readonly usage?: Usage;
  readonly durationMs: number;
  /** Where an isolated agent worked; the application merges or discards it. */
  readonly worktree?: { readonly path: string; readonly branch: string; readonly changed: boolean };
  /** Bounded, never provider text. */
  readonly error?: { readonly code: string; readonly message: string };
  /** True when replayed from the journal on resume. */
  readonly cached: boolean;
}

/** The context a script receives. */
export interface DynamicWorkflowContext {
  readonly runId: string;
  /** Read-only, JSON. */
  readonly args: JsonValue;
  /** Runs one agent; resolves to its output, or `null` when it failed (never rejects for agent failures). */
  agent(prompt: string, options?: DynamicAgentOptions): Promise<JsonValue>;
  /** Like `agent` but returns the full result record. */
  agentResult(prompt: string, options?: DynamicAgentOptions): Promise<DynamicAgentResult>;
  /** Runs thunks concurrently (bounded by the run's concurrency); a rejected thunk becomes `null`. */
  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>>;
  /** Passes each item through every stage in order, items flowing independently (no barrier between stages). */
  pipeline<T>(items: readonly T[], ...stages: ReadonlyArray<(value: any, item: T, index: number) => Promise<unknown>>): Promise<JsonValue[]>;
  /** Marks the current phase (must be declared when phases are declared). */
  phase(title: string): void;
  /** A progress line for events; never sent to an agent. */
  log(message: string): void;
  readonly budget: { readonly total?: number; spent(): number; remaining(): number | undefined };
  readonly signal: AbortSignal;
}

export type DynamicWorkflowScript = (context: DynamicWorkflowContext) => Promise<JsonValue>;

/** Declared up front, read without running anything (plans and scripts alike). */
export interface DynamicWorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly phases?: ReadonlyArray<{ readonly title: string; readonly detail?: string }>;
}

// ---------------------------------------------------------------------------------------------------
// Plans: JSON data, never code.
// ---------------------------------------------------------------------------------------------------

/**
 * A template string. `{{args.<path>}}`, `{{steps.<id>}}` (a previous step's output, whole) and, inside
 * a `map` step, `{{item}}` / `{{index}}` are the only substitutions. Substituted values are rendered as
 * indented, labelled reference data, never spliced into the instruction text.
 */
export type DynamicTemplate = string;

export interface DynamicAgentStep extends Omit<DynamicAgentOptions, 'label'> {
  readonly kind: 'agent';
  readonly id: string;
  readonly prompt: DynamicTemplate;
}

/** Fans one agent out over an array (a previous step's array output or an array in `args`). */
export interface DynamicMapStep extends Omit<DynamicAgentOptions, 'label'> {
  readonly kind: 'map';
  readonly id: string;
  /** `args.<path>` or `steps.<id>` (or `steps.<id>.<path>`) resolving to an array. */
  readonly over: string;
  readonly prompt: DynamicTemplate;
  /** Items beyond this are refused before anything runs (never silently truncated). */
  readonly maxItems?: number;
}

export type DynamicPlanStep = DynamicAgentStep | DynamicMapStep;

export interface DynamicWorkflowPlan {
  readonly format: 1;
  readonly meta: DynamicWorkflowMeta;
  /** Steps run when every step they reference has finished; independent steps run concurrently. */
  readonly steps: readonly DynamicPlanStep[];
  /** The step whose output is the workflow's result; default: the last step. */
  readonly result?: string;
}

// ---------------------------------------------------------------------------------------------------
// Limits, journal, isolation, events, run options.
// ---------------------------------------------------------------------------------------------------

/** Hard limits the application sets; a plan or script can never exceed them. */
export interface DynamicLimits {
  /**
   * Agent calls per run: each `agent()` call counts once (cached replays included), however many attempts
   * it takes; default 50, at most 1000. Attempts are bounded per call by `schemaRetries` and
   * `rateLimitRetries`, and their cost by `tokens`.
   */
  readonly maxAgents?: number;
  /**
   * Ceiling of concurrent agent calls; default 8, at most 16. The run adapts its window between 1 and this
   * ceiling: it starts at `initialConcurrency`, is cut to floor(0.75 x window) (at least 1) when the provider
   * rate-limits a call (RATE_LIMITED), and grows by 1 for each answered call while it is full
   * (`concurrency.changed` events).
   */
  readonly concurrency?: number;
  /** Where the adaptive window starts; default min(4, `concurrency`), at most `concurrency`. */
  readonly initialConcurrency?: number;
  /** Items in one `map`/`pipeline`/`parallel`; default 256, at most 4096. */
  readonly maxItems?: number;
  /** Total tokens (input + output, as reported) the run may spend; once spent, further calls fail with BUDGET. */
  readonly tokens?: number;
  /** Per-attempt timeout ceiling (first turn, each schema and rate-limit retry); default 15 minutes, at most 24 hours. */
  readonly agentTimeoutMs?: number;
  /** Most an agent may do; default 'analyze'. */
  readonly permissions?: DynamicPermissionMode;
  /** Models an agent may name; absent means only the default model. */
  readonly models?: readonly string[];
  /** Retries of a schema-invalid structured output; default 2, at most 5. */
  readonly schemaRetries?: number;
  /**
   * Retries of a call the provider rate-limited (RATE_LIMITED), each after an exponential backoff with
   * jitter (at least until the provider's reset when the SDK reports one) during which the call holds no
   * concurrency slot; default 3, at most 10. A reset further away than the call's timeout fails the call
   * at once. Once spent, the call fails with RATE_LIMITED.
   */
  readonly rateLimitRetries?: number;
}

/** Durable record of finished agent calls, keyed by call key; resume replays them. */
export interface DynamicJournal {
  /** Called once before the run's first call: take ownership, load the index. */
  open?(runId: string): Promise<void>;
  get(runId: string, key: string): Promise<DynamicAgentResult | undefined>;
  put(runId: string, result: DynamicAgentResult): Promise<void>;
  /** Called once when the run ends: release ownership. */
  close?(runId: string): Promise<void>;
}

/** Creates and reports per-agent git worktrees; the application owns merging and cleanup. */
export interface DynamicIsolation {
  create(request: { runId: string; key: string; label?: string; signal: AbortSignal }): Promise<{ path: string; branch: string }>;
  /** Whether the agent changed anything there; called after the agent finished. */
  inspect(worktree: { path: string; branch: string }): Promise<{ changed: boolean }>;
}

/** What the engine needs to run one agent call: the application builds the Agent (its runtime, cwd, auth). */
export interface DynamicAgentRequest {
  readonly runId: string;
  readonly key: string;
  readonly prompt: string;
  readonly options: DynamicAgentOptions & { readonly permissions: DynamicPermissionMode };
  /** Set when the call is isolated. */
  readonly cwd?: string;
  readonly signal: AbortSignal;
}

export interface DynamicAgentRunner {
  /**
   * Runs one turn and returns its text, structured output (when a schema was asked) and usage. Must
   * settle promptly once `request.signal` aborts: the engine relies on it for timeouts, abort and slots.
   */
  run(request: DynamicAgentRequest): Promise<{ text: string; output?: JsonValue; usage?: Usage }>;
}

export type DynamicWorkflowEvent =
  | { type: 'run.started'; runId: string; meta: DynamicWorkflowMeta; at: string }
  | { type: 'phase.started'; runId: string; title: string; at: string }
  | { type: 'agent.started'; runId: string; key: string; label?: string; phase?: string; at: string }
  | { type: 'agent.finished'; runId: string; result: Omit<DynamicAgentResult, 'output'>; at: string }
  | { type: 'log'; runId: string; message: string; at: string }
  | { type: 'budget'; runId: string; spent: number; total?: number; at: string }
  /** The adaptive concurrency window changed: cut on a rate limit, or grown after an answered call while full. */
  | {
    type: 'concurrency.changed'; runId: string; previous: number; window: number; ceiling: number;
    reason: 'rate-limited' | 'recovered'; at: string;
  }
  | { type: 'run.finished'; runId: string; status: DynamicRunStatus; agents: number; spent: number; at: string };

export type DynamicRunStatus = 'completed' | 'failed' | 'aborted' | 'budget-exhausted';

export interface DynamicRunOptions {
  /** Identifies the run; reusing it resumes from the journal. */
  readonly runId: string;
  readonly runner: DynamicAgentRunner;
  readonly journal?: DynamicJournal;
  readonly isolation?: DynamicIsolation;
  readonly limits?: DynamicLimits;
  readonly args?: JsonValue;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: DynamicWorkflowEvent) => void;
}

/** The engine entry (engine.ts). */
export type RunWorkflowScript = (
  meta: DynamicWorkflowMeta, script: DynamicWorkflowScript, options: DynamicRunOptions,
) => Promise<DynamicRunReport>;

/** A validated plan compiled to the script the engine runs (plan-compile.ts). */
export type CompilePlan = (plan: DynamicWorkflowPlan, limits?: DynamicLimits) => {
  readonly meta: DynamicWorkflowMeta;
  readonly script: DynamicWorkflowScript;
};

export interface DynamicRunReport {
  readonly runId: string;
  readonly status: DynamicRunStatus;
  readonly result: JsonValue;
  readonly agents: readonly Omit<DynamicAgentResult, 'output'>[];
  readonly spent: number;
  /** Bounded, never provider text. */
  readonly error?: { readonly code: string; readonly message: string };
}
