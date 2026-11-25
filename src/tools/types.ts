import type { ProviderId, TransportKind } from '../public/types.js';

/** Application-owned authority. A tool declaration never grants permissions. */
export interface ApplicationToolScope {
  readonly provider: ProviderId;
  readonly transport: TransportKind;
  readonly cwd: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly callId?: string;
  readonly authorityEpoch: string;
}

export interface ApplicationToolContext {
  readonly signal: AbortSignal;
  /** Effective tool/turn deadline, as epoch milliseconds. */
  readonly deadline: number;
  readonly scope: Readonly<ApplicationToolScope>;
}

export interface ApplicationTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputBytes: number;
  authorize(input: unknown, context: ApplicationToolContext): boolean | Promise<boolean>;
  execute(input: unknown, context: ApplicationToolContext): unknown | Promise<unknown>;
}
