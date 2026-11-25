import type { LogExecutionDatabase } from './execution-database.js';
import type { LogPosition, RunIdentity } from './types.js';

declare const run: unique symbol;
/** Original in-process begin acknowledgement. Not a Host execution or settlement capability. */
export interface RunHistoryHandle { readonly [run]: true }
export type RunInterruptionReason = 'aborted' | 'failed' | 'stopped' | 'halted';
/** Producer observations only. An open run is unknown, never permission to replay. */
export interface RunHistoryRecord {
  readonly schemaVersion: 1; readonly sourceId: string; readonly identity: RunIdentity; readonly inputDigest: string;
  readonly status: 'unknown' | 'completed' | 'interrupted'; readonly started: LogPosition;
  readonly terminal?: LogPosition; readonly outputDigest?: string; readonly reason?: RunInterruptionReason;
}
export interface RunHistoryOptions { readonly database: LogExecutionDatabase; readonly maxEntries?: number }
export interface RunHistoryBegin { readonly identity: RunIdentity; readonly requestId: string; readonly inputDigest: string }
export type RunHistoryStart = Readonly<{ kind: 'started'; run: RunHistoryHandle; record: RunHistoryRecord }>
  | Readonly<{ kind: 'existing'; record: RunHistoryRecord }>;
export interface RunHistoryComplete { readonly requestId: string; readonly outputDigest?: string }
export interface RunHistoryInterrupt { readonly requestId: string; readonly reason: RunInterruptionReason }
export interface RunHistoryList { readonly generation?: number; readonly limit?: number }
export interface RunHistory {
  begin(options: RunHistoryBegin): Promise<RunHistoryStart>;
  complete(handle: RunHistoryHandle, options: RunHistoryComplete): Promise<RunHistoryRecord>;
  interrupt(handle: RunHistoryHandle, options: RunHistoryInterrupt): Promise<RunHistoryRecord>;
  recover(identity: RunIdentity): Promise<RunHistoryRecord | undefined>;
  /** Latest starts first. Bounded whole-source validation precedes filtering and limiting. */
  list(options?: RunHistoryList): Promise<readonly RunHistoryRecord[]>;
}
