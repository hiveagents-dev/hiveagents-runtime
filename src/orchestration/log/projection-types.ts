import type { LogCursor, LogPage, LogQuery, LogSourceDescriptor } from './store-types.js';
import type { LogPosition, RunIdentity } from './types.js';
import type { CapturedAgentMetadata, CapturedOperationMetadata } from './capture-codec.js';
export type ProjectionPurpose = 'trace' | 'audit';
export type ProjectionIssue = 'UNKNOWN_SCHEMA' | 'PRIVATE_PAYLOAD' | 'INVALID_METADATA' | 'UNRESOLVED_CAUSAL_REFERENCE'
  | 'LOG_CORRUPT' | 'SOURCE_UNAVAILABLE' | 'PROJECTION_LIMIT' | 'HISTORY_GAP' | 'RUN_NOT_FOUND' | 'INVOCATION_UNSETTLED' | 'INCOMPLETE_ORIGIN';
export interface ProjectionReader { readonly descriptor: LogSourceDescriptor; readPage(query?: LogQuery): Promise<LogPage> }
export interface LogProjectionOptions { readonly reader: ProjectionReader; readonly identity: RunIdentity; readonly maxPages?: number; readonly maxEntries?: number }
/** Private resumable DATA, not an execution capability or a proof of earlier coverage. */
export interface ProjectionCursor {
  readonly format: 1; readonly purpose: ProjectionPurpose; readonly identityDigest: string;
  readonly source: LogSourceDescriptor; readonly underlying: LogCursor;
}
export interface ProjectionItem {
  readonly id: string; readonly position: LogPosition; readonly causal: readonly Readonly<{ sourceIdDigest: string; sequence: number; digest: string }>[];
  readonly category: 'agent-event' | 'capture-operation' | 'decision' | 'workflow' | 'reconciliation' | 'run' | 'unprojected';
  readonly metadata?: CapturedAgentMetadata | CapturedOperationMetadata | Readonly<Record<string, unknown>>;
  readonly issues: readonly ProjectionIssue[];
}
export interface ProjectionLink { readonly position: LogPosition; readonly previousDigest: string }
export interface LogProjectionPage {
  readonly format: 1; readonly purpose: ProjectionPurpose; readonly identityDigest: string;
  readonly source: LogSourceDescriptor; readonly from: LogPosition; readonly through: LogPosition;
  readonly links: readonly ProjectionLink[]; readonly items: readonly ProjectionItem[];
  readonly issues: readonly ProjectionIssue[]; readonly nextCursor?: ProjectionCursor;
}
/** Describes observed metadata at one source head; never business success, quality or permission. */
export interface LogProjection {
  readonly format: 1; readonly purpose: ProjectionPurpose; readonly identityDigest: string;
  readonly scope: 'captured-metadata'; readonly textReconstruction: 'unavailable'; readonly qualityAssessment: 'not-derived';
  readonly source: LogSourceDescriptor; readonly through: LogPosition; readonly coveredThrough: LogPosition;
  readonly kind: 'observed' | 'awaiting-owner' | 'incomplete' | 'corrupt';
  readonly items: readonly ProjectionItem[]; readonly issues: readonly ProjectionIssue[];
}
