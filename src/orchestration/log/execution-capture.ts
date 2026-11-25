import { capture } from './encoding.js';
import { AGENT_METADATA_SCHEMA, CAPTURE_OPERATION_SCHEMA, decodeCaptureMetadata } from './capture-codec.js';
import { executionFailure, safeExecutionFailure } from './execution-types.js';
import type { ExecutionDatabaseContext } from './execution-database.js';
import type { LogCommit, LogReceipt } from './types.js';

/** Bounded metadata DATA port for Runtime.capture. Reserved lifecycle/effect records cannot be injected. */
export function executionCaptureStore(context: ExecutionDatabaseContext): Readonly<{ append(commit: LogCommit): Promise<LogReceipt> }> {
  let pending = 0;
  return Object.freeze({ async append(input: LogCommit): Promise<LogReceipt> {
    context.assert(); if (pending >= 2) executionFailure('CODEC_BUSY');
    let commit: LogCommit;
    try {
      commit = capture(input, context.source);
      for (const record of commit.records) {
        if (record.schema.version !== 1 || ![AGENT_METADATA_SCHEMA, CAPTURE_OPERATION_SCHEMA].includes(record.schema.id) || !('inline' in record.payload)) executionFailure('INVALID_STATE');
        decodeCaptureMetadata(record.schema.id, record.type, record.payload.inline);
      }
    } catch { return executionFailure('INVALID_STATE'); }
    pending++;
    try {
      const prepared = await context.binding.prepare(commit);
      return context.transaction(() => context.binding.appendInTransaction(prepared), true);
    } catch (error) { return safeExecutionFailure(error); } finally { pending--; }
  } });
}
