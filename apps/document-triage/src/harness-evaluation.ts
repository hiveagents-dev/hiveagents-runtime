import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Runtime } from 'hiveagents-runtime';
import {
  runEvaluation, compareEvaluations, validateEvaluationReport, openTraceEpisode, readTraceEpisode, WorkflowTraceStore,
  FileWorkflowStore, runObservedTask, decisionHash,
  type JsonValue, type ObservedTaskBudget,
} from 'hiveagents-runtime/orchestration';
import { appAgent, classificationPrompt } from './classify.js';
import { validateClassification, validateDocuments } from './validation.js';
import { DOCUMENT_EVALUATION_SUITE } from './harness-corpus.js';
import { DOCUMENT_SCORERS } from './harness-oracles.js';
import { baselineClassification, candidateClassification } from './harness-classifiers.js';
import { executionIdentity } from './harness-identity.js';
import { harnessIdentity, stateDirectory } from './harness-common.js';

export interface DocumentEvaluationOptions {
  runtime: Runtime;
  cwd: string;
  stateDirectory: string;
  profile: 'baseline' | 'candidate';
  repetitions?: number;
  timeoutMs?: number;
  caseId?: string;
  model?: string;
  maxLaunches?: number;
  signal?: AbortSignal;
}

export async function evaluateDocuments(options: DocumentEvaluationOptions) {
  options = { ...options };
  options.signal?.throwIfAborted();
  const repetitions = options.repetitions ?? 1, timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new TypeError('Invalid repetitions');
  const cases = DOCUMENT_EVALUATION_SUITE.cases.filter(item => options.caseId === undefined || item.id === options.caseId);
  if (cases.length === 0) throw new TypeError('Unknown evaluation case id');
  const requested = cases.length * repetitions;
  if (options.model !== undefined && (!Number.isSafeInteger(options.maxLaunches) || options.maxLaunches! < requested)) {
    throw new TypeError(`Model evaluation requires an explicit --max-launches budget covering ${requested} requested turns`);
  }
  const model = options.model === undefined ? undefined : options.runtime.resolveModel(options.model);
  const directory = await stateDirectory(options.stateDirectory), source = await harnessIdentity();
  const id = `evaluation-${randomUUID()}`, episodeId = id;
  const suite = { ...DOCUMENT_EVALUATION_SUITE, cases };
  const execution = model === undefined ? undefined : await executionIdentity(options.runtime, model, options.cwd);
  const profile = { id: model === undefined ? options.profile : 'provider', version: '1', sourceDigest: source.digest,
    optionsDigest: decisionHash({ timeoutMs, selectedCase: options.caseId ?? null, executionDigest: execution?.digest ?? null }),
    ...(model === undefined ? {} : { provider: model.provider, model: model.id, transport: 'exec' as const }) };
  const trace = await openTraceEpisode(new WorkflowTraceStore(new FileWorkflowStore(join(directory, 'traces'))), {
    episodeId, task: { id: suite.id, version: suite.version, inputDigest: decisionHash(cases.map(item => item.input)) },
    source, profile: { id: profile.id, version: profile.version, digest: decisionHash(profile) },
    ...(model === undefined ? {} : { provider: model.provider, model: model.id, transport: 'exec' as const }),
  });
  let admittedAttempts = 0;
  const budget: ObservedTaskBudget = { acquire(signal) {
    signal.throwIfAborted();
    if (model !== undefined && admittedAttempts >= options.maxLaunches!) throw new Error('LAUNCH_BUDGET_EXCEEDED');
    admittedAttempts++;
    return { release() {} };
  } };
  try {
    const report = await runEvaluation({ id, suite, profile, repetitions, timeoutMs, budget, trace,
      ...(options.signal === undefined ? {} : { signal: options.signal }), scorers: DOCUMENT_SCORERS,
      async execute(input, context) {
        const document = validateDocuments([input])[0]!;
        if (model === undefined) return { output: { ...(options.profile === 'baseline' ? baselineClassification(document) : candidateClassification(document)) } };
        const agent = appAgent(options.runtime, `${model.provider}/${model.id}`, options.cwd);
        const starter = { async *stream(prompt: string, turnOptions: Parameters<typeof agent.stream>[1]) {
          for await (const event of agent.stream(prompt, turnOptions)) { await context.recordEvent(event); yield event; }
        } };
        const turn = await runObservedTask(starter, classificationPrompt(document.text), {
          awaitSettlement: true, signal: context.signal, timeoutMs: Math.max(1, context.deadline - Date.now()),
        });
        if (turn.status !== 'completed') throw new Error('PROVIDER_TURN_INCOMPLETE');
        let output: JsonValue;
        try { output = { ...validateClassification(turn.text) }; } catch { output = turn.text; }
        return { output, ...(turn.usage === undefined ? {} : { usage: turn.usage }) };
      },
    });
    const reports = join(directory, 'reports'); await mkdir(reports, { recursive: true, mode: 0o700 });
    const reportPath = join(reports, `${id}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await trace.finish(options.signal?.aborted ? 'cancelled' : 'completed');
    return { id, pid: process.pid, episodeId, reportPath, caseCount: cases.length, repetitions,
      metrics: report.metrics, usage: report.usage, admittedAttempts,
      modelLaunches: model === undefined ? 0 : null, requestedModelTurns: model === undefined ? 0 : requested,
      ...(execution === undefined ? {} : { executionIdentity: execution }),
      evidence: model === undefined ? 'local-classifier-demo' : 'transport-observation' };
  } catch (error) {
    try { await trace.finish(options.signal?.aborted ? 'cancelled' : 'failed'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Evaluation and trace finalization failed'); }
    throw error;
  } finally { await trace.close(); }
}

export function compareDocumentEvaluations(baseline: unknown, candidate: unknown) {
  const left = validateEvaluationReport(baseline), right = validateEvaluationReport(candidate);
  for (const report of [left, right]) if (report.metrics.total !== report.suite.caseIds.length * report.repetitions) {
    throw new TypeError('Application comparisons require a complete evaluation for every planned attempt');
  }
  return compareEvaluations(left, right);
}

export async function inspectDocumentTrace(directory: string, episodeId: string) {
  const path = await stateDirectory(directory);
  const result = await readTraceEpisode(new WorkflowTraceStore(new FileWorkflowStore(join(path, 'traces'))), episodeId);
  if (result === undefined) throw new Error('Trace episode not found');
  return result;
}
