import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { AgentRuntimeError, type Runtime } from 'hiveagents-runtime';
import {
  FileWorkflowStore, SharedLaunchBudget, WorkflowRunner, rankMemories,
  type JsonValue, type WorkflowDefinition,
} from 'hiveagents-runtime/orchestration';
import { appAgent, appPolicyReport, classificationPrompt } from './classify.js';
import { validateClassification, validateDocuments, type DocumentRecord } from './validation.js';

export interface TriageOptions {
  runtime: Runtime;
  stateDirectory: string;
  documents: unknown;
  cwd: string;
  model?: string;
  stopAfterIntake?: boolean;
  signal?: AbortSignal;
}

export interface TriageResult {
  runId: string;
  status: string;
  executedSteps: string[];
  admittedLaunches: number;
  report: JsonValue;
}

export async function runDocumentTriage(options: TriageOptions): Promise<TriageResult> {
  if (!isAbsolute(options.stateDirectory) || !isAbsolute(options.cwd)) throw new TypeError('stateDirectory and cwd must be absolute');
  const documents = validateDocuments(options.documents);
  const model = options.model === undefined ? undefined : options.runtime.resolveModel(options.model);
  const canonicalCwd = await realpath(options.cwd);
  const canonicalModel = model === undefined ? null : `${model.provider}/${model.id}`;
  const providerKey = model === undefined ? 'local:document-triage' : `${model.provider}:local-auth`;
  const digest = createHash('sha256').update(JSON.stringify({ documents, model: canonicalModel, cwd: canonicalCwd })).digest('hex');
  const runId = `triage-${digest}`;
  const budgetDatabasePath = join(options.stateDirectory, 'admission.sqlite');
  await mkdir(options.stateDirectory, { recursive: true });
  await mkdir(dirname(budgetDatabasePath), { recursive: true });
  const budget = new SharedLaunchBudget({
    databasePath: budgetDatabasePath,
    providers: { [providerKey]: { maxConcurrent: 2, maxLaunchesPerHour: 12, maxLaunchesPerDay: 24, quotaCooldownMs: 60_000 } },
  });
  const executedSteps: string[] = [];
  const stop = new AbortController();
  const signal = options.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, options.signal]);
  const analyse = async (stepId: string, query: string, source: JsonValue, branchSignal: AbortSignal): Promise<JsonValue> => {
    const matches = rankMemories(query, source as unknown as DocumentRecord[], { limit: 1 });
    const admission = budget.reserve(providerKey, `${runId}:${stepId}`);
    if (!admission.allowed) throw new Error(`Admission denied: ${admission.reason}`);
    try {
      const text = matches.map(({ record }) => record.text).join('\n') || 'No matching source.';
      if (canonicalModel === null) return {
        sources: matches.map(({ record }) => record.id),
        classification: { category: stepId === 'backups' ? 'backups' : 'network', summary: text },
        auth: { authenticated: false, source: 'unknown' },
      };
      const agent = appAgent(options.runtime, canonicalModel, canonicalCwd);
      const readiness = await agent.ready();
      const turn = await agent.run(classificationPrompt(text, query), { signal: branchSignal });
      if (turn.status !== 'completed') throw new Error(`Provider ended with status ${turn.status}`);
      const classification = validateClassification(turn.text);
      return { sources: matches.map(({ record }) => record.id),
        classification: { ...classification }, auth: { ...readiness.auth }, ...appPolicyReport(readiness) } as unknown as JsonValue;
    } catch (error) {
      if (error instanceof AgentRuntimeError && error.code === 'USAGE_LIMIT') {
        const paused = budget.recordQuotaError(providerKey);
        if (!paused.ok) throw new AggregateError([error, new Error(paused.reason)], 'Could not persist quota cooldown');
      }
      throw error;
    } finally {
      const released = budget.release(admission.reservation.token);
      if (!released.ok) throw new Error(`Reservation release failed: ${released.reason}`);
    }
  };
  const definition: WorkflowDefinition = {
    id: 'document-triage', version: `1:${digest}`,
    steps: [
      { id: 'intake', execute() {
        executedSteps.push('intake');
        if (options.stopAfterIntake) stop.abort();
        return documents.map(document => ({ ...document }));
      } },
      { id: 'network', dependencies: ['intake'], execute({ dependencyOutputs, signal: branchSignal }) {
        executedSteps.push('network');
        return analyse('network', 'VPN acceso remoto', dependencyOutputs.intake!, branchSignal);
      } },
      { id: 'backups', dependencies: ['intake'], execute({ dependencyOutputs, signal: branchSignal }) {
        executedSteps.push('backups');
        return analyse('backups', 'backup restauración', dependencyOutputs.intake!, branchSignal);
      } },
      { id: 'report', dependencies: ['network', 'backups'], execute({ dependencyOutputs }) {
        executedSteps.push('report');
        return { network: dependencyOutputs.network!, backups: dependencyOutputs.backups! };
      } },
    ],
  };
  try {
    const checkpoint = await new WorkflowRunner(new FileWorkflowStore(join(options.stateDirectory, 'workflows')))
      .run(definition, { runId, concurrency: 2, signal });
    const usage = budget.status(providerKey);
    if (!usage.ok) throw new Error(`Budget status unavailable: ${usage.reason}`);
    return { runId, status: checkpoint.status, executedSteps, admittedLaunches: usage.status.launchesLastDay,
      report: checkpoint.steps.report?.output ?? null };
  } finally { budget.close(); }
}
