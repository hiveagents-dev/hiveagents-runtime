import { randomUUID } from 'node:crypto';
import type { Runtime } from 'hiveagents-runtime';
import { learningDigest } from 'hiveagents-runtime/routing/learning';
import { learningProductionCase, learningCases } from './learning-corpus.js';
import { captureLearningDefinition, configuredArmCount, openLearningSession, requireLearningBudget, requireLearningTotalBudget, LearningLaunchBudget,
  assertLearningLineage, type LearningAppOptions } from './learning-session.js';
import { nextLearningRound, performLearningCycle, taskFor } from './learning-matrix.js';
import { verifyLearningOutput } from './learning-corpus.js';

export async function inspectLearning(options: LearningAppOptions) {
  const session = await openLearningSession({ ...options });
  try {
    return { pid: process.pid, domain: session.domain, pointer: await session.router.inspect(),
      observations: await session.store.observations(session.domain, { limit: 100 }), pending: await session.store.pending(session.domain), routingApiCalls: 0 };
  } finally { session.store.close(); }
}

export async function runLearningCycle(options: LearningAppOptions & { runtime: Runtime; suite?: 'mixed'|'document'; operation?: 'promote'|'rollback' }) {
  options = { ...options, definition: captureLearningDefinition(options.definition) };
  const suite = options.suite ?? 'mixed', operation = options.operation ?? 'promote';
  const configured = configuredArmCount(options.definition as ReturnType<typeof captureLearningDefinition>);
  const planned = (operation === 'promote' ? learningCases('train', suite).length : 0)
    + learningCases('fixed', suite).length + learningCases('fresh', suite).length;
  requireLearningBudget(planned * configured, options.maxLaunches);
  requireLearningTotalBudget(planned * configured, options.totalLaunches);
  const session = await openLearningSession(options);
  const budget = new LearningLaunchBudget(session.directory, session.domain, options.maxLaunches!, options.totalLaunches);
  try { return await performLearningCycle(session, options.runtime, budget, { suite, operation,
    ...(options.signal === undefined ? {} : { signal: options.signal }) }); }
  finally { budget.close(); session.store.close(); }
}

export async function runLearningInput(options: LearningAppOptions & { runtime: Runtime; input: unknown; autoImprove?: boolean; suite?: 'mixed'|'document' }) {
  learningDigest(options.input);
  options = { ...options, definition: captureLearningDefinition(options.definition), input: structuredClone(options.input) };
  const item = learningProductionCase(options.input), suite = options.suite ?? 'mixed';
  const models = configuredArmCount(options.definition as ReturnType<typeof captureLearningDefinition>);
  const maintenanceTurns = options.autoImprove ? models * (learningCases('train', suite).length
    + learningCases('fixed', suite).length + learningCases('fresh', suite).length) : 0;
  requireLearningBudget(1 + maintenanceTurns, options.maxLaunches);
  requireLearningTotalBudget(1 + maintenanceTurns, options.totalLaunches);
  const session = await openLearningSession(options);
  const budget = new LearningLaunchBudget(session.directory, session.domain, options.maxLaunches!, options.totalLaunches);
  let maintenance: unknown;
  try {
    if (options.autoImprove) await assertLearningLineage(session, { runtime: options.runtime, task: taskFor(item), timeoutMs: session.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
    const result = await session.router.run(session.definition, { runtime: options.runtime, task: taskFor(item), input: item.prompt,
      id: `decision-${randomUUID()}`, timeoutMs: session.timeoutMs, budget,
      verify: turn => verifyLearningOutput(turn.text, item.expected),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.autoImprove ? { maintenanceTimeoutMs: 20 * 60000, maintenance: async ({ signal }) => {
        // Validate availability of a genuinely unused fresh corpus before spending calibration turns.
        learningCases('fresh', suite, await nextLearningRound(session));
        maintenance = await performLearningCycle(session, options.runtime, budget, { suite, operation: 'promote',
          signal });
      } } : {}) });
    return { pid: process.pid, receipt: result.receipt, observation: result.observation,
      shadowDigest: result.shadow.digest, pointer: await session.router.inspect(), maintenance: result.maintenance,
      ...(maintenance === undefined ? {} : { improvement: maintenance }), requestedModelTurns: budget.admitted,
      modelLaunches: null, routingApiCalls: 0 };
  } finally { budget.close(); session.store.close(); }
}
