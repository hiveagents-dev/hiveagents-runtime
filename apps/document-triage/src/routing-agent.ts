import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Runtime } from 'hiveagents-runtime';
import { FileWorkflowStore, decisionHash, runObservedTask, type JsonValue } from 'hiveagents-runtime/orchestration';
import { createAgent, readRoutingReceipt, WorkflowRoutingReceiptStore,
  type RoutingAgentDefinition, type RoutingTask } from 'hiveagents-runtime/routing';
import { classificationPrompt } from './classify.js';
import { harnessIdentity, stateDirectory } from './harness-common.js';
import { validateClassification, validateDocuments } from './validation.js';
import { routingDeadline } from './routing-deadline.js';

export interface RouteOptions {
  runtime: Runtime;
  definition: unknown;
  stateDirectory: string;
  cwd?: string;
  id?: string;
  tags?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The same caller-owned deadline covers selection, receipt I/O and the one native turn. */
async function withRoute<T>(options: RouteOptions, taskInput: unknown,
  execute: (selected: Awaited<ReturnType<typeof createAgent>>, signal: AbortSignal, remaining: () => number) => Promise<T>) {
  // Capture caller-owned metadata before any asynchronous work; keep live runtime/signal identities.
  const { runtime, definition: inputDefinition, stateDirectory: requestedDirectory, cwd: requestedCwd,
    id: requestedId, tags: inputTags, timeoutMs: requestedTimeout, signal: parentSignal } = options;
  const timeoutMs = requestedTimeout === undefined ? 30000 : requestedTimeout;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Invalid routing timeout');
  const deadline = routingDeadline(timeoutMs, parentSignal), { signal, remaining } = deadline;
  try {
    remaining();
    if (inputTags !== undefined) decisionHash(inputTags as JsonValue);
    const tags = inputTags === undefined ? undefined : structuredClone(inputTags);
    if (inputDefinition === null || typeof inputDefinition !== 'object' || Array.isArray(inputDefinition)) {
      throw new TypeError('Agent config must be an object');
    }
    decisionHash(inputDefinition as JsonValue); // This application accepts JSON configs, without callback tools.
    // CLI configs are parsed JSON. The framework validates every field before preparing providers.
    const config = structuredClone(inputDefinition) as Record<string, unknown>;
    if (Object.hasOwn(config, 'environment')) throw new TypeError('The application controls provider environments; omit environment from JSON config');
    if (Object.hasOwn(config, 'providerOptions')) {
      const providerOptions = config.providerOptions;
      if (providerOptions === null || typeof providerOptions !== 'object' || Array.isArray(providerOptions)
        || Object.entries(providerOptions).some(([key, value]) => !['experimentalControl', 'experimentalApi'].includes(key) || typeof value !== 'boolean')) {
        throw new TypeError('The application controls native provider settings; providerOptions accepts only experimentalControl and experimentalApi booleans');
      }
    }
    const cwd = await realpath(resolve(requestedCwd ?? (typeof config.cwd === 'string' ? config.cwd : process.cwd())));
    if (config.cwd !== undefined && typeof config.cwd !== 'string') throw new TypeError('Invalid agent cwd');
    const definition = { ...config, cwd } as RoutingAgentDefinition;
    const source = await harnessIdentity(), directory = await stateDirectory(requestedDirectory);
    const id = requestedId ?? randomUUID();
    const task: RoutingTask = { id: 'document-route', version: '1', inputDigest: decisionHash(taskInput as JsonValue),
      ...(tags === undefined ? {} : { tags }) };
    const selected = await createAgent(definition, { runtime,
      receipts: new WorkflowRoutingReceiptStore(new FileWorkflowStore(join(directory, 'routing'))),
      id, task, sourceDigest: source.digest, signal, timeoutMs: remaining() });
    remaining();
    const result = await execute(selected, signal, remaining);
    remaining();
    return result;
  } finally { deadline.dispose(); }
}

export async function selectDocumentAgent(options: RouteOptions) {
  return withRoute(options, null, async ({ receipt }) => ({ pid: process.pid, receipt,
    requestedModelTurns: 0, modelLaunches: 0, routingApiCalls: 0 }));
}

export async function classifyWithSelectedAgent(options: RouteOptions & { documents: unknown; maxLaunches: number }) {
  const documents = validateDocuments(options.documents);
  if (documents.length !== 1) throw new TypeError('route-classify requires exactly one document');
  if (options.maxLaunches !== 1) throw new TypeError('route-classify requires --max-launches 1');
  return withRoute(options, documents, async ({ agent, receipt }, signal, remaining) => {
    // awaitSettlement is an exec contract: reject before opening any control session.
    if (receipt.selected?.transport !== 'exec') throw new TypeError('route-classify requires an exec selection');
    const turn = await runObservedTask(agent, classificationPrompt(documents[0]!.text), {
      signal, timeoutMs: remaining(), awaitSettlement: true,
    });
    remaining();
    if (turn.status !== 'completed') throw new Error(`Selected provider ended with status ${turn.status}`);
    return { pid: process.pid, receipt, classification: validateClassification(turn.text), session: turn.session,
      requestedModelTurns: 1, modelLaunches: null, routingApiCalls: 0 };
  });
}

export async function inspectDocumentRouting(directory: string, id: string) {
  const canonical = await stateDirectory(directory);
  const receipt = await readRoutingReceipt(new WorkflowRoutingReceiptStore(new FileWorkflowStore(join(canonical, 'routing'))), id);
  if (receipt === undefined) throw new Error('Routing receipt not found');
  return { pid: process.pid, receipt };
}
