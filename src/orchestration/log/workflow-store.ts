import { types } from 'node:util';
import { identifier, object, ownObject } from '../../shared/json.js';
import { cloneSteps, identity as workflowIdentity, validateCheckpoint } from '../workflow/checkpoint.js';
import { dependencyWaves } from '../workflow/graph.js';
import type { WorkflowCheckpoint, WorkflowDefinition, WorkflowLease, WorkflowStep, WorkflowStore } from '../workflow/types.js';
import type { RunIdentity } from './types.js';
import { captureIdentity } from './reconstruction.js';
import { executionContext } from './execution-database.js';
import type { ExecutionDatabaseContext, LogExecutionDatabase } from './execution-database.js';
import { captureExecutionValue, runKey } from './execution-validation.js';
import { executionFailure, safeExecutionFailure } from './execution-types.js';
import { acquireOwner, assertOwner, markOwnerActive, markOwnerDrained, releaseOwner } from './leases.js';
import { commitState, hydrateState, prepareState, readState } from './materialized.js';
import { unresolved, visitEffects } from './effects.js';

function captureDefinition(input: WorkflowDefinition): WorkflowDefinition {
  try {
    input = ownObject(input, ['id', 'version', 'steps']); identifier(input.id); identifier(input.version);
    if (types.isProxy(input.steps) || !Array.isArray(input.steps) || input.steps.length > 1024) executionFailure('INVALID_STATE');
    const steps: WorkflowStep[] = [];
    for (let index = 0; index < input.steps.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input.steps, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) executionFailure('INVALID_STATE');
      const step = ownObject(descriptor.value, ['id', 'execute', 'dependencies', 'maxAttempts', 'replaySafe']); object(step); identifier(step.id);
      if (types.isProxy(step.execute) || typeof step.execute !== 'function') executionFailure('INVALID_STATE');
      const dependencies = captureExecutionValue(step.dependencies ?? []); if (!Array.isArray(dependencies)) executionFailure('INVALID_STATE');
      for (const dependency of dependencies) identifier(dependency);
      const maxAttempts = step.maxAttempts ?? 1, replaySafe = step.replaySafe ?? false;
      if (!Number.isSafeInteger(maxAttempts) || Number(maxAttempts) < 1 || typeof replaySafe !== 'boolean') executionFailure('INVALID_STATE');
      steps.push({ id: step.id, execute: step.execute as WorkflowStep['execute'], dependencies: dependencies as string[], maxAttempts: Number(maxAttempts), replaySafe });
    }
    const definition = { id: input.id, version: input.version, steps: cloneSteps(steps) }; workflowIdentity(definition); dependencyWaves(definition.steps); return definition;
  } catch { return executionFailure('INVALID_STATE'); }
}
function guardCheckpoint(context: ExecutionDatabaseContext, identity: RunIdentity, next: WorkflowCheckpoint, previous?: WorkflowCheckpoint): void {
  const key = runKey(context.source.sourceId, identity);
  visitEffects(context, (_id, effect) => {
    if (!unresolved(effect.metadata) || runKey(context.source.sourceId, effect.association.identity) !== key) return;
    const step = next.steps[effect.association.stepId], before = previous?.steps[effect.association.stepId];
    if (!step || ['pending', 'completed'].includes(step.status)
      || step.status === 'running' && (before?.status !== 'running' || before.attempts !== step.attempts)) executionFailure('OUTCOME_UNKNOWN');
  });
}
/** Log and materialized checkpoint share one transaction; app callbacks remain WorkflowRunner-owned. */
export class LogWorkflowStore implements WorkflowStore {
  readonly #database!: LogExecutionDatabase; readonly #identity!: RunIdentity; readonly #definition!: WorkflowDefinition;
  constructor(options: { database: LogExecutionDatabase; identity: RunIdentity; definition: WorkflowDefinition }) {
    try {
      options = ownObject(options, ['database', 'identity', 'definition']); const context = executionContext(options.database);
      this.#identity = captureIdentity(options.identity); if (this.#identity.systemId !== context.source.systemId) executionFailure('INVALID_STATE');
      this.#database = options.database; this.#definition = captureDefinition(options.definition);
    } catch { return executionFailure('INVALID_STATE'); }
  }
  async acquire(runId: string): Promise<WorkflowLease> {
    if (runId !== this.#identity.runId) executionFailure('INVALID_STATE');
    const context = executionContext(this.#database), identity = this.#identity, key = runKey(context.source.sourceId, identity), definition = this.#definition;
    const acquired = context.transaction(() => ({ owner: acquireOwner(context, 'workflow', identity), revision: readState(context, 'workflow', key, identity)?.revision ?? 0 }), true);
    const owner = acquired.owner; markOwnerActive(context, owner); let revision = acquired.revision, poisoned = false, released = false, busy = false;
    const assert = () => { if (released || poisoned) executionFailure('OUTCOME_UNKNOWN'); assertOwner(context, owner); };
    const captureSnapshot = () => context.transaction(() => { assert(); return readState(context, 'workflow', key, identity); });
    const checkSnapshot = (snapshot: ReturnType<typeof readState>) => context.transaction(() => {
      assert(); const current = readState(context, 'workflow', key, identity);
      if ((current?.revision ?? 0) !== revision || current?.recordDigest !== snapshot?.recordDigest || current?.recordJson !== snapshot?.recordJson) executionFailure('OUTCOME_UNKNOWN');
    });
    return {
      async load() {
        if (busy) executionFailure('CODEC_BUSY'); busy = true;
        try { return await context.codec.operation(async () => {
          const snapshot = captureSnapshot(); if (!snapshot) return undefined;
          const record = await hydrateState(context, 'workflow', snapshot, () => checkSnapshot(snapshot)); checkSnapshot(snapshot);
          const checkpoint = validateCheckpoint(record, definition, runId);
          context.transaction(() => { assert(); guardCheckpoint(context, identity, checkpoint, checkpoint); }); return checkpoint;
        }); } catch (error) { poisoned = true; return safeExecutionFailure(error); } finally { busy = false; }
      },
      async save(input) {
        if (busy) executionFailure('CODEC_BUSY'); busy = true;
        try {
          await context.codec.operation(async () => {
            const snapshot = captureSnapshot(), check = () => checkSnapshot(snapshot);
            const captured = await context.codec.capture(input, check); check(); const next = validateCheckpoint(captured, definition, runId);
            const original = snapshot ? await hydrateState(context, 'workflow', snapshot, check) : undefined; check();
            const previous = original ? validateCheckpoint(original, definition, runId) : undefined;
            const prepared = await prepareState(context, 'workflow', key, identity, next as unknown as import('./types.js').LogJsonValue, revision, `workflow.${next.status}`, check); check();
            const result = context.transaction(() => { assert(); guardCheckpoint(context, identity, next, previous); return commitState(context, 'workflow', key, identity, prepared); }, true);
            revision = result.revision;
          });
        } catch (error) { poisoned = true; safeExecutionFailure(error); } finally { busy = false; }
      },
      async release() {
        if (released) return;
        if (busy) executionFailure('OUTCOME_UNKNOWN');
        try { if (poisoned) executionFailure('OUTCOME_UNKNOWN'); context.transaction(() => releaseOwner(context, owner), true); released = true; }
        finally { markOwnerDrained(context, owner); }
      },
    };
  }
}
