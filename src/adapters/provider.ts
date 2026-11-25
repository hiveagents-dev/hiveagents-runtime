import type {
  AgentEvent,
  AuthStatus,
  ModelInfo,
  ProviderId,
  ProviderInstallation,
  Usage,
} from '../public/types.js';
import type { CliCompatibilityAssessment } from '../compatibility/manifest.js';
import type { ProcessOutcome, ProcessRequest } from '../process/run-process.js';
import type { FailureClassification } from '../public/errors.js';

export type ProtocolFailureKind =
  | 'not-authenticated'
  | 'unknown-model'
  | 'model-unavailable'
  | 'usage-limit'
  | 'untrusted-workspace'
  | 'session-not-found'
  | 'provider-unavailable'
  | 'protocol';

export interface ProtocolFailure {
  kind: ProtocolFailureKind;
  message: string;
  rawCode?: string;
  reason?: FailureClassification['reason'];
  /** Epoch milliseconds, only from an explicit structured usage rejection. */
  retryAt?: number;
}

export interface ProtocolResult {
  completed: boolean;
  failed: boolean;
  refused: boolean;
  sessionId?: string;
  turnId?: string;
  text: string;
  output?: unknown;
  usage?: Usage;
  events: AgentEvent[];
  failure?: ProtocolFailure;
  terminalEvent?: unknown;
  nativeEvents: unknown[];
}

export type ExecOperation = 'open' | 'resume' | 'fork' | 'one-shot';

export interface ExecTurnRequest {
  mode: ExecOperation;
  modelId: string;
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  contextArgs: string[];
  permissionArgs: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** Propagate actual-work settlement through exec wrappers. */
  awaitSettlement?: boolean;
  /** This turn must bill the CLI login: adapters pin whatever their CLI lets a config redirect. */
  requireSubscription?: boolean;
  sessionId?: string;
  instructions?: string;
  effort?: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessOutcome>;

export type AdapterStreamItem =
  | { kind: 'session'; sessionId: string }
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'result'; result: ProtocolResult };

/** Optional cooperative cancellation for readiness/status probes. Legacy adapters may ignore it. */
export interface ExecProbeContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
  remainingMs(): number;
}

/** What a turn will run with, so a credential probe answers for that turn and not for the host process. */
export interface ExecProbeTurn {
  cwd: string;
  contextArgs: readonly string[];
  providerOptions?: Record<string, unknown>;
}

export interface ExecAdapter {
  readonly id: ProviderId;
  detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext): Promise<ProviderInstallation>;
  auth(env: NodeJS.ProcessEnv, context?: ExecProbeContext, turn?: ExecProbeTurn): Promise<AuthStatus>;
  models(): Promise<ModelInfo[]>;
  compatibility?(env: NodeJS.ProcessEnv, version: string, context?: ExecProbeContext): Promise<CliCompatibilityAssessment | undefined>;
  execute(request: ExecTurnRequest): Promise<ProtocolResult>;
  stream?(request: ExecTurnRequest): AsyncIterable<AdapterStreamItem>;
}

/**
 * Native session ids are opaque, but they become a CLI argument: never a flag, and never
 * a selector that `--resume` would follow instead (a `.jsonl` transcript path or a URL).
 */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^(?!.*\.jsonl$)[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/i.test(id);
}

export function parseObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A caller can preserve malformed/non-JSON output as diagnostics.
  }
  return undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
