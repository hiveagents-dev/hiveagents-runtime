/** Optional durable execution log. Storage and projections never confer Host execution authority. */
export { SqliteRunLogStore } from './sqlite-store.js';
export { SqliteLogBinding } from './sqlite-binding.js';
export { LogStoreError, isLogStoreError } from './store-types.js';
export type { LogJsonValue, LogPosition, RunIdentity, PayloadReference, LogDraft, LogCommit, LogReceipt } from './types.js';
export type { LogSourceDescriptor, LogEntry, LogPayloadVerifier, LogStoreOptions, LogCursor, LogQuery, LogPage,
  ReconstructionIssue, RunReconstruction, PreparedLogCommit, LogStoreErrorCode } from './store-types.js';
export { createLogArtifactStore } from './artifacts.js';
export type { LogArtifactOptions, LogArtifactReadOptions, LogArtifactWriteOptions, LogArtifactVerification, LogArtifactBinding } from './artifacts.js';
export { LogExecutionDatabase } from './execution-database.js';
export { createRunHistory } from './run-history.js';
export type { RunHistory, RunHistoryOptions, RunHistoryHandle, RunHistoryRecord, RunHistoryBegin, RunHistoryStart,
  RunHistoryComplete, RunHistoryInterrupt, RunHistoryList, RunInterruptionReason } from './run-history-types.js';
export { LogDecisionStore } from './decision-store.js';
export type { DecisionReconciliationOptions } from './decision-reconciliation-types.js';
export { LogWorkflowStore } from './workflow-store.js';
export { inspectManagedEffect } from './effects.js';
export type { ManagedEffectView } from './effects.js';
export { LogExecutionError } from './execution-types.js';
export type { ExecutionArtifactStore, LogExecutionDatabaseOptions, ManagedEffectAssociation, CapturedEffectAssociation,
  ExecutionOwnership, StandaloneStoppedAcknowledgement, LogExecutionFailure } from './execution-types.js';
export { createRequiredLogCapture } from './capture.js';
export type { RequiredLogCaptureOptions, RequiredLogCapture } from './capture.js';
export type { RuntimeCaptureOptions } from './capture-runtime.js';
export { createLogTraceProjector } from './trace-projector.js';
export { createLogAuditProjector } from './audit-projector.js';
export { mergeLogProjectionPages } from './projection.js';
export type { ProjectionPurpose, ProjectionIssue, ProjectionReader, LogProjectionOptions, ProjectionCursor,
  ProjectionItem, ProjectionLink, LogProjectionPage, LogProjection } from './projection-types.js';
