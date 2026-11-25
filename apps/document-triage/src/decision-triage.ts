import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  bindDecision, decisionHash, DecisionRunner, FileWorkflowStore, WorkflowDecisionStore,
  type DecisionAuthorization, type DecisionRecord, type DecisionStore, type JsonValue,
} from 'hiveagents-runtime/orchestration';
import { runDocumentTriage, type TriageOptions } from './triage.js';
import { validateDocuments } from './validation.js';

export interface TriageAuthority extends DecisionAuthorization {
  id: string;
  version: string;
}
export interface DecisionTriageOptions extends TriageOptions {
  /** Trusted local application policy, never an approval inferred from model text. */
  authority(): TriageAuthority;
  decisionStore?: DecisionStore;
}

/** Validate an operator-owned JSON file before constructing the trusted policy callback. */
export function validateTriageAuthority(value: unknown): TriageAuthority {
  const fail = (): never => { throw new TypeError('Invalid triage authority'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['id', 'version', 'decision', 'reason', 'expiresAt', 'nextAt'].includes(key))) return fail();
  for (const key of ['id', 'version', 'reason']) {
    const text = item[key];
    if (typeof text !== 'string' || !text.trim() || text.length > (key === 'reason' ? 2000 : 200)) return fail();
  }
  if (!['allow', 'wait', 'deny'].includes(String(item.decision)) || !Number.isSafeInteger(item.expiresAt) || Number(item.expiresAt) < 0
    || (item.nextAt !== undefined && (!Number.isSafeInteger(item.nextAt) || Number(item.nextAt) < 0))) return fail();
  return { id: item.id as string, version: item.version as string, decision: item.decision as TriageAuthority['decision'],
    reason: item.reason as string, expiresAt: item.expiresAt as number,
    ...(item.nextAt === undefined ? {} : { nextAt: item.nextAt as number }) };
}

/** A small decision-gated variant: the existing document workflow and its JSON checkpoints stay intact. */
export async function runDecisionGatedTriage(options: DecisionTriageOptions): Promise<DecisionRecord> {
  if (!isAbsolute(options.stateDirectory) || !isAbsolute(options.cwd)) throw new TypeError('stateDirectory and cwd must be absolute');
  const documents = validateDocuments(options.documents);
  const cwd = await realpath(options.cwd);
  const resolved = options.model === undefined ? undefined : options.runtime.resolveModel(options.model);
  const model = resolved === undefined ? null : `${resolved.provider}/${resolved.id}`;
  const input = { documents: documents.map(document => ({ ...document })), cwd, model };
  const authority = validateTriageAuthority(options.authority());
  const binding = bindDecision({ input, authority: { id: authority.id }, inputVersion: 'document-triage:1', authorityVersion: authority.version });
  const frozenInput = binding.input as typeof input;
  const id = `triage-review-${binding.inputHash}`;
  const store = options.decisionStore ?? new WorkflowDecisionStore(new FileWorkflowStore(join(options.stateDirectory, 'decisions')));
  const current = (): TriageAuthority => {
    const value = validateTriageAuthority(options.authority());
    if (value.id !== authority.id || value.version !== authority.version) return { ...value, decision: 'deny', reason: 'Authority changed' };
    return value;
  };
  return new DecisionRunner(store).run({
    id, binding, ...(options.signal === undefined ? {} : { signal: options.signal }),
    authorize: () => {
      const value = current();
      return { decision: value.decision, reason: value.reason, expiresAt: value.expiresAt,
        ...(value.nextAt === undefined ? {} : { nextAt: value.nextAt }) };
    },
    isCurrent: () => {
      const value = current();
      return value.id === authority.id && value.version === authority.version && value.decision === 'allow' && value.expiresAt > Date.now();
    },
    async execute({ signal }) {
      // All inputs are the snapshot the owner approved, even if the caller mutates its objects later.
      return await runDocumentTriage({ ...options, documents: frozenInput.documents,
        cwd, ...(model === null ? {} : { model }), signal }) as unknown as JsonValue;
    },
    async verify(result) {
      if (result === null || typeof result !== 'object' || Array.isArray(result) || result.status !== 'completed' || typeof result.runId !== 'string') {
        return { verified: false, evidence: [] };
      }
      const lease = await new FileWorkflowStore(join(options.stateDirectory, 'workflows')).acquire(result.runId);
      try {
        const value = await lease.load() as { status?: string; steps?: { report?: { output?: JsonValue } } } | undefined;
        const verified = value?.status === 'completed' && value.steps?.report?.output !== undefined
          && decisionHash(value.steps.report.output) === decisionHash(result.report ?? null);
        return { verified, evidence: verified ? [`workflow:${result.runId}:report:${decisionHash(result.report ?? null)}`] : [] };
      } finally { await lease.release(); }
    },
  });
}
