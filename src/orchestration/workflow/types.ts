/** Values whose meaning survives a JSON checkpoint. undefined and class instances are rejected. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface WorkflowStepContext {
  runId: string;
  stepId: string;
  /** One-based, durably consumed before invoking execute. */
  attempt: number;
  /** Stable across retries and process restarts; pass to an idempotent external API. */
  idempotencyKey: string;
  dependencyOutputs: Readonly<Record<string, JsonValue>>;
  /** Cancellation is cooperative. The runner drains callbacks before releasing ownership. */
  signal: AbortSignal;
}

export interface WorkflowStep {
  id: string;
  dependencies?: readonly string[];
  /** Includes the initial call; defaults to one. Explicit retries can repeat side effects. */
  maxAttempts?: number;
  /** Explicit promise that repeating an ambiguous interrupted call is safe. Defaults to false. */
  replaySafe?: boolean;
  execute(context: WorkflowStepContext): JsonValue | Promise<JsonValue>;
}

export interface WorkflowDefinition {
  id: string;
  /** Caller must change this when callback code, closed-over inputs or semantics change. */
  version: string;
  steps: readonly WorkflowStep[];
}

export interface WorkflowStepState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked';
  attempts: number;
  output?: JsonValue;
  error?: string;
}

export interface WorkflowCheckpoint {
  format: 1;
  runId: string;
  workflow: { id: string; version: string; fingerprint: string };
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'halted';
  steps: Record<string, WorkflowStepState>;
}

/** Holds exclusive ownership for the entire run, including callback drainage. */
export interface WorkflowLease {
  load(): Promise<unknown | undefined>;
  /** Atomic durable replacement. A rejection stops scheduling and aborts active callbacks. */
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  release(): Promise<void>;
}

/** Custom stores must serialize or reject same-run leases across all of their clients. */
export interface WorkflowStore {
  acquire(runId: string): Promise<WorkflowLease>;
}

/** The caller verified that no process still executes this run's work; re-armed side effects may repeat. */
export interface WorkflowRearmAcknowledgement { workStopped: true }

export interface WorkflowRearmOptions {
  runId: string;
  /** `'incomplete'`: every step that is not completed. Explicit ids must name non-completed steps. */
  steps: 'incomplete' | readonly string[];
  acknowledgement: WorkflowRearmAcknowledgement;
}

export interface WorkflowRearmResult {
  /** The persisted checkpoint; `halted` until a `run` resumes it. Unchanged when nothing was re-armed. */
  checkpoint: WorkflowCheckpoint;
  /** What each re-armed step looked like before: the audit trail for the caller's own log. */
  rearmed: Array<{ stepId: string; status: WorkflowStepState['status']; attempts: number }>;
}

export interface WorkflowRunOptions {
  runId: string;
  /** Positive integer; defaults to four. Wave barriers are preserved. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Also requires replaySafe on each interrupted step. Default is to halt. */
  recoverInterrupted?: 'replay-safe';
}
