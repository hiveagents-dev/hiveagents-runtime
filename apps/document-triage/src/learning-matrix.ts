import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Runtime } from 'hiveagents-runtime';
import { hashTaskFeatures, sealLearningRecord, learningDigest, selectPolicy,
  type LearningEpisode, type LearningSnapshot, type PolicyRef, type LearningObservation, type LearningGateCommit } from 'hiveagents-runtime/routing/learning';
import { learningInputDigest, learningCases, verifyLearningOutput, type AppLearningCase } from './learning-corpus.js';
import { openLearningSession, LearningLaunchBudget, assertLearningLineage } from './learning-session.js';

export type LearningSession = Awaited<ReturnType<typeof openLearningSession>>;
export const taskFor = (item: AppLearningCase) => ({ id: item.id, version: '1', inputDigest: learningInputDigest(item.prompt), text: item.prompt });
const epoch = (domain: string, round: number, split: string) => `learn-${split}-${domain.slice(0, 24)}-${round}`;

export async function nextLearningRound(session: LearningSession) {
  let round = 0;
  while (await session.store.get('episode', epoch(session.domain, round, 'fixed'))
    || await session.store.get('episode', epoch(session.domain, round, 'fresh'))) round++;
  return round;
}

async function collect(session: LearningSession, runtime: Runtime, budget: LearningLaunchBudget,
  cases: readonly AppLearningCase[], split: 'train'|'fixed'|'fresh', signal?: AbortSignal, episode?: LearningEpisode) {
  const preflight = await session.router.preflight(session.definition, { runtime, task: taskFor(cases[0]!), timeoutMs: session.timeoutMs,
    ...(signal === undefined ? {} : { signal }) });
  if (preflight.actions.length === 0) throw new Error('No eligible models for learning matrix');
  const rows: LearningObservation[] = [];
  for (const item of cases) for (const action of preflight.actions) {
    signal?.throwIfAborted();
    const taskDigest = learningInputDigest(item.prompt);
    const cell = episode?.cells.find(cell => cell.taskDigest === taskDigest && cell.actionKey === action.key && cell.repetition === 0);
    if (episode && !cell) throw new Error('Matrix action identity changed after prospective reservation');
    const attemptId = cell?.attemptId ?? `attempt-${randomUUID()}`, observationId = cell?.observationId ?? `observation-${randomUUID()}`;
    const existing = await session.store.get('observation', observationId);
    if (existing) { rows.push(existing); continue; }
    if (await session.store.get('attempt', attemptId)) throw new Error('Pending attempt requires inspection; it cannot be retried');
    const result = await session.router.run(session.definition, { runtime, task: taskFor(item), input: item.prompt,
        id: `decision-${randomUUID()}`, attemptId, observationId, evaluationArmId: action.id, split,
        timeoutMs: session.timeoutMs, budget, verify: turn => verifyLearningOutput(turn.text, item.expected),
        ...(signal === undefined ? {} : { signal }), ...(episode === undefined ? {} : { episodeId: episode.id, repetition: 0 }) });
    rows.push(result.observation);
  }
  return rows;
}

async function reserveEpisode(session: LearningSession, runtime: Runtime, round: number, kind: 'fixed'|'fresh',
  cases: readonly AppLearningCase[], signal?: AbortSignal, comparison?: NonNullable<LearningEpisode['comparison']>) {
  const preflight = await session.router.preflight(session.definition, { runtime, task: taskFor(cases[0]!), timeoutMs: session.timeoutMs,
    ...(signal === undefined ? {} : { signal }) });
  const id = epoch(session.domain, round, kind);
  const tasks = cases.map(item => ({ taskDigest: learningInputDigest(item.prompt), features: hashTaskFeatures(item.prompt) }));
  const cells = tasks.flatMap(task => preflight.actions.map(action => {
    const key = learningDigest({ id, task: task.taskDigest, action: action.key, repetition: 0 });
    return { taskDigest: task.taskDigest, actionKey: action.key, repetition: 0, attemptId: `attempt-${key}`, observationId: `observation-${key}` };
  }));
  const episode = sealLearningRecord('episode', { format: 1, id, domain: session.domain, kind, createdAt: Date.now(),
    definitionDigest: preflight.definitionDigest, protocolDigest: session.protocolDigest,
    afterSequence: await session.store.highWater(session.domain), arms: preflight.actions,
    ...(preflight.fallbackId === undefined ? {} : { fallbackId: preflight.fallbackId }), tasks, repetitions: 1, cells,
    ...(comparison === undefined ? {} : { comparison }) });
  await session.store.put('episode', id, episode);
  return episode;
}

async function snapshot(session: LearningSession, ref: PolicyRef): Promise<LearningSnapshot | undefined> {
  if (ref === null) return undefined;
  const result = await session.store.get('snapshot', ref);
  if (!result) throw new Error('Missing policy snapshot'); return result;
}

function comparisonMetrics(episode: LearningEpisode, rows: readonly LearningObservation[], from: LearningSnapshot | undefined, to: LearningSnapshot | undefined) {
  const rate = (policy: LearningSnapshot | undefined) => {
    let passed = 0, known = 0;
    for (const task of episode.tasks) {
      const action = selectPolicy(policy, episode.arms, task.features, episode.createdAt, episode.fallbackId);
      const outcome = rows.find(row => row.taskDigest === task.taskDigest && row.action.key === action?.key);
      if (outcome?.quality.state === 'verified') { known++; passed += Number(outcome.quality.passed); }
    }
    return { known, passed, rate: known === episode.tasks.length ? passed / known : null };
  };
  const fixed = episode.arms.map(action => {
    const outcomes = rows.filter(row => row.action.key === action.key);
    return outcomes.length === episode.tasks.length && outcomes.every(row => row.quality.state === 'verified')
      ? outcomes.reduce((sum, row) => sum + Number(row.quality.state === 'verified' && row.quality.passed), 0) / outcomes.length : null;
  });
  const known = fixed.filter((v): v is number => v !== null);
  return { incumbentPassRate: rate(from).rate, learnedPassRate: rate(to).rate,
    bestFixedPassRate: known.length === episode.arms.length ? Math.max(...known) : null, candidateCoverage: known.length / episode.arms.length };
}

/** This is the opt-in maintenance cycle; all extra turns use the caller's same budget. */
export async function performLearningCycle(session: LearningSession, runtime: Runtime, budget: LearningLaunchBudget,
  options: { suite: 'mixed'|'document'; operation: 'promote'|'rollback'; signal?: AbortSignal; train?: boolean }) {
  options = { ...options };
  const round = await nextLearningRound(session);
  const freshCases = learningCases('fresh', options.suite, round), fixedCases = learningCases('fixed', options.suite);
  const context = { runtime, task: taskFor(freshCases[0]!), timeoutMs: session.timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const before = await session.router.inspect();
  if (options.operation === 'rollback' && before.generation === 0) throw new Error('No previous policy to roll back');
  await assertLearningLineage(session, context, before, options.operation === 'rollback');
  if (options.operation === 'promote' && options.train !== false) {
    await collect(session, runtime, budget, learningCases('train', options.suite), 'train', options.signal);
  }
  const challenger = options.operation === 'promote' ? await session.router.shadow(session.definition, context)
    : await snapshot(session, before.previous);
  const incumbent = await snapshot(session, before.active);
  const config = challenger?.config ?? incumbent?.config;
  if (!config) throw new Error('No measured policy for comparison');
  const fixedEpisode = await reserveEpisode(session, runtime, round, 'fixed', fixedCases, options.signal);
  const fixedRows = await collect(session, runtime, budget, fixedCases, 'fixed', options.signal, fixedEpisode);
  const freshEpisode = await reserveEpisode(session, runtime, round, 'fresh', freshCases, options.signal, {
    expectedGeneration: before.generation, from: before.active, to: challenger?.digest ?? null, operation: options.operation,
    fixedEpisodeId: fixedEpisode.id, config, configDigest: learningDigest(config),
  });
  const freshRows = await collect(session, runtime, budget, freshCases, 'fresh', options.signal, freshEpisode);
  options.signal?.throwIfAborted();
  const gate: LearningGateCommit = await session.router.improve({ id: `gate-${randomUUID()}`, freshEpisodeId: freshEpisode.id });
  const pointer = await session.router.inspect();
  const report = { pid: process.pid, round, gate, pointer, shadowDigest: challenger?.digest ?? null,
    fixedEpisodeId: fixedEpisode.id, freshEpisodeId: freshEpisode.id,
    comparison: comparisonMetrics(freshEpisode, freshRows, incumbent, challenger),
    verifiedRows: [...fixedRows, ...freshRows].filter(row => row.quality.state === 'verified').length,
    requestedModelTurns: budget.admitted, modelLaunches: null, routingApiCalls: 0 };
  const reportPath = join(session.directory, 'learning', `cycle-${session.domain}-${round}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...report, reportPath };
}
