import { freeze, hash, object } from '../../shared/json.js';
import { digest } from './encoding.js';
import { validateDecisionRecord } from '../decisions/runner.js';
import type { DecisionRecord } from '../decisions/types.js';
import type { WorkflowCheckpoint } from '../workflow/types.js';
import type { LogJsonValue } from './types.js';
import { executionFailure } from './execution-types.js';
import { captureExecutionValue } from './execution-validation.js';
export interface DecisionLogMetadata {
  readonly kind: 'decision'; readonly decisionIdDigest: string; readonly status: DecisionRecord['status']; readonly attempts: number;
  readonly intentIdDigest?: string; readonly inputHash: string; readonly authorityHash: string;
  readonly inputVersionDigest: string; readonly authorityVersionDigest: string; readonly resultHash?: string;
}
export interface WorkflowLogMetadata {
  readonly kind: 'workflow'; readonly workflowIdDigest: string; readonly workflowVersionDigest: string;
  readonly fingerprint: string; readonly status: WorkflowCheckpoint['status'];
  readonly steps: readonly Readonly<{ stepIdDigest: string; status: WorkflowCheckpoint['steps'][string]['status']; attempts: number }>[];
}
/** Closed DATA descriptor for v2 bodies; never constructs a DecisionRecord from metadata. */
export function captureExecutionMetadata(kind: 'decision' | 'workflow', input: unknown): DecisionLogMetadata | WorkflowLogMetadata {
  try {
    const next = captureExecutionValue(input);
    if (kind === 'decision') {
      object(next, ['kind', 'decisionIdDigest', 'status', 'attempts', 'intentIdDigest', 'inputHash', 'authorityHash', 'inputVersionDigest', 'authorityVersionDigest', 'resultHash']);
      if (next.kind !== kind || !['waiting', 'denied', 'intent', 'dispatched', 'verified', 'needs-owner'].includes(next.status as string)
        || !Number.isSafeInteger(next.attempts) || Number(next.attempts) < 0) executionFailure('INTEGRITY');
      for (const key of ['decisionIdDigest', 'inputHash', 'authorityHash', 'inputVersionDigest', 'authorityVersionDigest']) hash(next[key]);
      for (const key of ['intentIdDigest', 'resultHash']) if (next[key] !== undefined) hash(next[key]);
      if (['intent', 'dispatched', 'verified'].includes(next.status as string) && (!next.intentIdDigest || Number(next.attempts) < 1)
        || next.status === 'verified' && !next.resultHash) executionFailure('INTEGRITY');
    } else {
      object(next, ['kind', 'workflowIdDigest', 'workflowVersionDigest', 'fingerprint', 'status', 'steps']);
      if (next.kind !== kind || Object.keys(next).length !== 6 || !['running', 'completed', 'failed', 'cancelled', 'halted'].includes(next.status as string)
        || !Array.isArray(next.steps) || next.steps.length > 1024) executionFailure('INTEGRITY');
      for (const key of ['workflowIdDigest', 'workflowVersionDigest', 'fingerprint']) hash(next[key]);
      const ids = new Set<string>();
      for (const step of next.steps) {
        object(step, ['stepIdDigest', 'status', 'attempts']); hash(step.stepIdDigest);
        if (Object.keys(step).length !== 3 || ids.has(step.stepIdDigest) || !['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked'].includes(step.status as string)
          || !Number.isSafeInteger(step.attempts) || Number(step.attempts) < 0) executionFailure('INTEGRITY'); ids.add(step.stepIdDigest);
      }
    }
    return next as unknown as DecisionLogMetadata | WorkflowLogMetadata;
  } catch { return executionFailure('INTEGRITY'); }
}
/** Projection allowlist. Never parse recordJson in a public trace/audit projector. Metadata is DATA only. */
export function executionMetadata(kind: 'decision' | 'workflow', input: LogJsonValue): DecisionLogMetadata | WorkflowLogMetadata {
  if (kind === 'decision') {
    const raw = input as unknown as DecisionRecord, record = validateDecisionRecord(input, raw.id);
    return freeze({ kind, decisionIdDigest: digest(record.id), status: record.status, attempts: record.attempts,
      ...(record.intentId ? { intentIdDigest: digest(record.intentId) } : {}), inputHash: record.binding.inputHash, authorityHash: record.binding.authorityHash,
      inputVersionDigest: digest(record.binding.inputVersion), authorityVersionDigest: digest(record.binding.authorityVersion),
      ...(record.receipt ? { resultHash: record.receipt.resultHash } : {}) });
  }
  const record = input as unknown as WorkflowCheckpoint;
  if (!record || !record.workflow || !record.steps) executionFailure('INTEGRITY');
  return freeze({ kind, workflowIdDigest: digest(record.workflow.id), workflowVersionDigest: digest(record.workflow.version), fingerprint: record.workflow.fingerprint,
    status: record.status, steps: Object.entries(record.steps).map(([stepId, step]) => ({ stepIdDigest: digest(stepId), status: step.status, attempts: step.attempts })) });
}
