import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkflowLease, ObservedTaskBudget } from 'hiveagents-runtime/orchestration';
import { learningDigest } from 'hiveagents-runtime/routing/learning';
import type { LearningRunContext } from 'hiveagents-runtime/routing/learning';
import { assertStudyProductionTask, captureCurriculum, curriculumIdentity, studyTask, verifyStudyOutput } from './learning-curriculum.js';
import type { StudyTask, CurriculumIdentity } from './learning-curriculum.js';
import { captureLearningDefinition } from './learning-session.js';
import { assertCurrentStudyBinding, expectedStudyBinding } from './learning-study-binding.js';
import { StudyJournalFile } from './learning-study-journal.js';
import { cellObservation, cycleReport, publishEpisode, snapshot, trainingHistory } from './learning-study-evidence.js';
import { assertEnvironmentBinding, registerEnvironment } from './learning-study-registration.js';
import { episodeFor, learningTask, planCycle, remainingCells, stableId } from './learning-study-plan.js';
import type { StudyCell, StudyCycle, StudyEnvironment, StudyJournal, StudyRunOptions, StudyRunResult, StudyStatus, StudyTaskResult } from './learning-study-types.js';
export type * from './learning-study-types.js';
interface InvocationCounter { attempts: number; admittedAttempts?: number; aggregate?: InvocationCounter }
const positive = (value: number, max = 10000) => { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Expected explicit integer budget/count in 1..${max}`); };
async function release(lease: WorkflowLease|undefined, failure: {error:unknown}|undefined, onFailure?: () => void) {
  try { await lease?.release(); }
  catch (error) { onFailure?.(); if (failure) throw new AggregateError([failure.error,error],'Study operation and lease release failed'); throw error; }
}
export class LearningStudyRunner {
  readonly #environment: StudyEnvironment; readonly #identity: CurriculumIdentity;
  constructor(environment: StudyEnvironment) {
    const corpus = captureCurriculum(environment.corpus), definition = captureLearningDefinition(environment.definition);
    positive(environment.timeoutMs,2147483647);
    this.#environment = { ...environment,directory:resolve(environment.directory),corpus,definition,
      budget:{ acquire:environment.budget.acquire.bind(environment.budget) } };
    this.#identity = curriculumIdentity(corpus);
  }
  // Lease identity is shared; failure attribution belongs to one invocation only.
  #newJournal(): StudyJournalFile { return new StudyJournalFile(this.#environment.directory,this.#environment.corpus.id); }
  async #result(state: StudyJournal|undefined, status: StudyStatus['status'], attempts: number, reports: StudyStatus['cycles'], reason?: string): Promise<StudyStatus> {
    const active = state?.cycles.find(c => !c.completed);
    const pending = await this.#environment.evidence.pending(this.#environment.domain);
    return { status,domain:this.#environment.domain,studyId:this.#environment.corpus.id,baseDigest:this.#identity.baseDigest,
      registeredBatches:(state?.identity.batches ?? []).map(({id,digest}) => ({id,digest})),invocationAttempts:attempts,
      admittedAttempts:state?.admittedAttempts ?? 0,maxLaunches:this.#environment.corpus.study.maxLaunches,
      cycles:reports,pointer:await this.#environment.router.inspect(),...(active ? {activeBatchId:active.batchId} : {}),
      ...(pending.length ? {pendingAttemptIds:pending.map(p => p.id)} : {}),...(reason ? {reason} : {}) };
  }
  async inspect(): Promise<StudyStatus> {
    const journal = this.#newJournal();
    const owner = await journal.store.inspectOwnership(journal.runId);
    if (owner) return { ...await this.#result(undefined,'blocked',0,[],'Study is owned; journal was not read without its lease'),owner };
    let lease: WorkflowLease|undefined, failure: {error:unknown}|undefined;
    try {
      lease = await journal.acquire();
      const state = await journal.load(lease);
      if (!state) return this.#result(undefined,'deferred',0,[],'Study has not been registered');
      assertEnvironmentBinding(this.#environment,state,this.#identity);
      const reports = [];
      for (const cycle of state.cycles) if (cycle.completed || await this.#environment.evidence.get('gate-commit',cycle.gateId)) reports.push(await cycleReport(this.#environment,state,cycle));
      const pending = await this.#environment.evidence.pending(state.domain);
      const active = state.cycles.find(c => !c.completed);
      let unknown = false;
      for (const cell of [...state.calibration,...(active?.cells ?? [])]) {
        const row = await cellObservation(this.#environment,state,cell);
        if (row && (row.outcome !== 'completed' || row.quality.state !== 'verified')) unknown = true;
      }
      const exhausted = state.admittedAttempts + await remainingCells(state,this.#environment) > state.limits.maxLaunches;
      const status = pending.length || unknown ? 'blocked' : exhausted ? 'exhausted' : active ? 'paused' : state.cycles.length >= state.limits.maxCycles || state.admittedAttempts >= state.limits.maxLaunches ? 'exhausted' : 'completed';
      const reason = pending.length ? 'Pending attempts require explicit stopped-work inspection' : unknown ? 'Unknown terminal cells block dependent work' : exhausted ? 'Consumed admissions leave insufficient lifetime study budget' : undefined;
      return this.#result(state,status,0,reports,reason);
    } catch (error) { failure = {error}; throw error; }
    finally { await release(lease,failure,() => journal.recordFailure()); }
  }
  #budget(state: StudyJournal, lease: WorkflowLease, counter: InvocationCounter, maximum: number, task: StudyTask, journal: StudyJournalFile): ObservedTaskBudget {
    return { acquire:async signal => {
      signal.throwIfAborted();
      await assertCurrentStudyBinding(this.#environment,state,task,signal);
      if (counter.attempts >= maximum) throw new Error('Study invocation budget exhausted');
      if (state.admittedAttempts >= state.limits.maxLaunches || state.admittedAttempts + await remainingCells(state,this.#environment) > state.limits.maxLaunches) {
        throw new Error('Study lifetime admission budget exhausted');
      }
      state.admittedAttempts++;
      // Persist every acquisition slot before entering external admission, even when acquisition throws.
      await journal.save(lease,state); counter.attempts++; counter.admittedAttempts = state.admittedAttempts;
      if (counter.aggregate) { counter.aggregate.attempts++; counter.aggregate.admittedAttempts = state.admittedAttempts; }
      return this.#environment.budget.acquire(signal);
    } };
  }
  async #collect(state: StudyJournal, cycle: StudyCycle, cells: StudyCell[], lease: WorkflowLease,
    counter: InvocationCounter, maximum: number, journal: StudyJournalFile, signal?: AbortSignal): Promise<'ready'|'paused'|'blocked'> {
    const environment = this.#environment;
    const tasks = [...environment.corpus.train,...environment.corpus.fixed,...environment.corpus.freshBatches.find(b => b.id === cycle.batchId)!.tasks];
    for (const cell of cells) {
      signal?.throwIfAborted();
      const old = await cellObservation(environment,state,cell);
      if (old) { if (old.outcome !== 'completed' || old.quality.state !== 'verified') return 'blocked'; continue; }
      if (await environment.evidence.get('attempt',cell.attemptId)) return 'blocked';
      if (counter.attempts >= maximum) return 'paused';
      const item = tasks.find(t => t.id === cell.taskId)!;
      await environment.router.run(environment.definition,{ runtime:environment.runtime,task:learningTask(item,cell.taskDigest),input:item.text,
        id:`study-decision-${randomUUID()}`,attemptId:cell.attemptId,observationId:cell.observationId,evaluationArmId:cell.armId,split:cell.split,
        timeoutMs:environment.timeoutMs,budget:this.#budget(state,lease,counter,maximum,item,journal),expectedBinding:expectedStudyBinding(state,item.text),verify:turn => verifyStudyOutput(turn.text,item.expected),
        ...(signal === undefined ? {} : {signal}),...(cell.episodeId === undefined ? {} : {episodeId:cell.episodeId,repetition:cell.repetition!}) });
    }
    return 'ready';
  }
  async run(input: StudyRunOptions): Promise<StudyRunResult> { return this.#runCycles(input); }
  async #runCycles(input: StudyRunOptions, aggregate?: InvocationCounter, journal = this.#newJournal()): Promise<StudyRunResult> {
    const options = {...input}, maximum = options.maxLaunches, cycles = options.cycles ?? 1, operation = options.operation ?? 'promote', mode = options.mode ?? 'explicit';
    positive(maximum); positive(cycles,64);
    if (!['promote','rollback'].includes(operation) || !['explicit','maintenance'].includes(mode)) throw new TypeError('Invalid study operation/mode');
    if (options.batchId !== undefined && (typeof options.batchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.batchId))) throw new TypeError('Invalid study batch ID');
    const counter: InvocationCounter = {attempts:0,...(aggregate ? {aggregate} : {})}, reports: StudyStatus['cycles'] = [];
    let lease: WorkflowLease|undefined, failure: {error:unknown}|undefined;
    try {
      options.signal?.throwIfAborted(); lease = await journal.acquire();
      const state = await registerEnvironment(this.#environment,this.#identity,await journal.load(lease),options.signal);
      await journal.save(lease,state);
      if (options.batchId) {
        if (!state.identity.batches.some(b => b.id === options.batchId)) throw new Error('Unknown study batch ID');
        const historical = state.cycles.find(c => c.batchId === options.batchId && c.completed);
        if (historical) return this.#result(state,'completed',0,[await cycleReport(this.#environment,state,historical)]);
      }
      while (reports.length < cycles) {
        options.signal?.throwIfAborted();
        let cycle = state.cycles.find(c => !c.completed);
        if (cycle && options.batchId && cycle.batchId !== options.batchId) throw new Error('Oldest unfinished study cycle must resume before another batch');
        // Repair a committed cycle before applying restrictions on scheduling additional work.
        if (cycle && await this.#environment.evidence.get('gate-commit',cycle.gateId)) {
          const report = await cycleReport(this.#environment,state,cycle); cycle.completed = true;
          await journal.save(lease,state); reports.push(report);
          if (options.batchId) return this.#result(state,'completed',counter.attempts,reports);
          continue;
        }
        const pending = await this.#environment.evidence.pending(state.domain);
        if (pending.length) return this.#result(state,'blocked',counter.attempts,reports,'Pending attempts require inspection; no implicit retries');
        if (state.admittedAttempts + await remainingCells(state,this.#environment) > state.limits.maxLaunches) return this.#result(state,mode === 'maintenance' ? 'deferred' : 'exhausted',counter.attempts,reports,'Consumed admissions leave insufficient lifetime budget for the remaining study plan');
        if (cycle && cycle.operation !== operation) throw new Error('Unfinished cycle operation is immutable');
        if (!cycle) {
          const batch = options.batchId ? state.identity.batches.find(b => b.id === options.batchId) : state.identity.batches.find(b => !state.cycles.some(c => c.batchId === b.id));
          let reason: string|undefined;
          if (!batch) reason = 'No available new batch';
          else if (state.cycles.length >= state.limits.maxCycles) reason = 'Study gate ceiling exhausted';
          else if (state.admittedAttempts >= state.limits.maxLaunches) reason = 'Study lifetime admission budget exhausted';
          if (reason) return this.#result(state,mode === 'maintenance' ? 'deferred' : reports.length ? 'completed' : 'exhausted',counter.attempts,reports,reason);
          if (mode === 'maintenance' && state.cycles.length) {
            const history = await trainingHistory(this.#environment), seen = new Set(state.cycles.at(-1)!.seenTrain);
            if (history.hashes.filter(hash => !seen.has(hash)).length < state.limits.minNewTasks) return this.#result(state,'deferred',counter.attempts,reports,'Fewer than minNewTasks distinct newly verified training prompts');
          }
          const before = await this.#environment.router.inspect();
          if (operation === 'rollback' && before.generation < 1) throw new Error('No previous policy to roll back');
          cycle = planCycle(state,batch!.id,operation,before); state.cycles.push(cycle); await journal.save(lease,state);
        }
        const current = await this.#environment.router.inspect();
        if (learningDigest(current) !== learningDigest(cycle.before)) throw new Error('Study cycle pointer is stale; refusing a different comparison');
        const calibrated = await this.#collect(state,cycle,state.calibration,lease,counter,maximum,journal,options.signal);
        if (calibrated !== 'ready') return this.#result(state,calibrated,counter.attempts,reports,calibrated === 'blocked' ? 'Unknown or pending calibration terminal blocks dependent work' : 'Invocation chunk settled');
        if (cycle.challenger === undefined) {
          const challenger = operation === 'rollback' ? await snapshot(this.#environment,cycle.before.previous)
            : await this.#environment.router.shadow(this.#environment.definition,{runtime:this.#environment.runtime,task:learningTask(this.#environment.corpus.train[0]!,this.#identity.train[0]!.inputDigest),timeoutMs:this.#environment.timeoutMs,...(options.signal === undefined ? {} : {signal:options.signal})});
          cycle.challenger = challenger?.digest ?? null;
          const history = await trainingHistory(this.#environment,operation === 'promote' ? challenger!.through : await this.#environment.evidence.highWater(state.domain)); cycle.seenTrain = history.hashes; cycle.seenThrough = history.through;
          await journal.save(lease,state);
        }
        const challenger = await snapshot(this.#environment,cycle.challenger);
        if (challenger && (!challenger.binding || challenger.binding.definitionDigest !== state.binding.definitionDigest
          || learningDigest(challenger.binding.actions) !== learningDigest(state.binding.actions) || learningDigest(challenger.config) !== learningDigest(state.config))) throw new Error('Frozen challenger binding mismatch');
        for (const kind of ['fixed','fresh'] as const) {
          if (!cycle[kind]) { cycle[kind] = await episodeFor(this.#environment,state,cycle,kind,challenger); await journal.save(lease,state); }
          await publishEpisode(this.#environment,cycle[kind]!);
          const collected = await this.#collect(state,cycle,cycle.cells.filter(c => c.split === kind),lease,counter,maximum,journal,options.signal);
          if (collected !== 'ready') return this.#result(state,collected,counter.attempts,reports,collected === 'blocked' ? 'Unknown or pending matrix terminal blocks dependent work' : 'Invocation chunk settled');
        }
        options.signal?.throwIfAborted();
        await this.#environment.router.improve({id:cycle.gateId,freshEpisodeId:cycle.fresh!.id});
        const report = await cycleReport(this.#environment,state,cycle); cycle.completed = true;
        await journal.save(lease,state); reports.push(report);
        if (options.batchId) break;
      }
      return this.#result(state,'completed',counter.attempts,reports);
    } catch (error) { failure = {error}; throw error; }
    finally { await release(lease,failure,() => journal.recordFailure()); }
  }
  async runTask(input: {task:StudyTask;maxLaunches:number;autoImprove?:boolean;cycles?:number;signal?:AbortSignal}): Promise<StudyTaskResult> {
    const options = {...input,task:studyTask(input.task)}; positive(options.maxLaunches); if (options.cycles !== undefined) positive(options.cycles,64);
    if (options.autoImprove !== undefined && typeof options.autoImprove !== 'boolean') throw new TypeError('Invalid autoImprove option');
    assertStudyProductionTask(this.#environment.corpus,options.task);
    return this.#runProduction(options);
  }
  async #runProduction(options: {task:StudyTask;maxLaunches:number;autoImprove?:boolean;cycles?:number;signal?:AbortSignal}): Promise<StudyTaskResult> {
    const environment = this.#environment, journal = this.#newJournal(), counter: InvocationCounter = {attempts:0}; let lease: WorkflowLease|undefined, failure: {error:unknown}|undefined;
    try {
      options.signal?.throwIfAborted(); lease = await journal.acquire();
      const state = await registerEnvironment(environment,this.#identity,await journal.load(lease),options.signal);
      const inputDigest = createHash('sha256').update(options.task.text).digest('hex');
      const expectedDigest = learningDigest(options.task.expected);
      let intent = state.production.find(p => p.id === options.task.id);
      if (intent && (intent.inputDigest !== inputDigest || intent.expectedDigest !== expectedDigest)
        || state.production.some(p => p.inputDigest === inputDigest && p.expectedDigest !== expectedDigest)) throw new Error('Production input/expected identity changed');
      const resultBase = async () => ({domain:state.domain,studyId:state.studyId,pointer:await environment.router.inspect(),invocationAttempts:counter.attempts,admittedAttempts:state.admittedAttempts});
      const pending = await environment.evidence.pending(state.domain);
      if (pending.length && (!intent || !await environment.evidence.get('observation',intent.observationId))) {
        await journal.save(lease,state);
        return {status:'blocked',pendingAttemptIds:pending.map(row => row.id),...await resultBase()};
      }
      if (!intent && state.admittedAttempts + await remainingCells(state,environment) + 1 > state.limits.maxLaunches) throw new Error('Production plus remaining study plan exceeds immutable lifetime budget');
      if (!intent) { intent = {id:options.task.id,inputDigest,expectedDigest,attemptId:stableId('production-attempt',{study:state.studyId,id:options.task.id}),observationId:stableId('production-observation',{study:state.studyId,id:options.task.id})}; state.production.push(intent); }
      await journal.save(lease,state);
      const old = await environment.evidence.get('observation',intent.observationId);
      if (old) {
        if (old.domain !== state.domain || old.taskDigest !== inputDigest || old.attemptId !== intent.attemptId || old.split !== 'train'
          || intent.terminalDigest && old.digest !== intent.terminalDigest) throw new Error('Production terminal binding mismatch');
        const action = state.binding.actions.find(a => a.key === old.action.key);
        if (!action) throw new Error('Production terminal action is outside the study binding');
        await cellObservation(environment,state,{taskId:intent.id,taskDigest:inputDigest,actionKey:action.key,armId:action.id,split:'train',attemptId:intent.attemptId,observationId:intent.observationId});
        const receipt = await environment.evidence.get('decision',old.decisionId);
        if (!receipt || receipt.digest !== old.decisionDigest || receipt.definitionDigest !== state.binding.definitionDigest) throw new Error('Production receipt binding mismatch');
        intent.terminalDigest = old.digest; await journal.save(lease,state);
        return {status:'replayed',receipt,observation:old,...await resultBase()};
      }
      if (await environment.evidence.get('attempt',intent.attemptId)) return {status:'blocked',pendingAttemptIds:[intent.attemptId],...await resultBase()};
      if (state.admittedAttempts + await remainingCells(state,environment) > state.limits.maxLaunches) throw new Error('Production plus remaining study plan exceeds immutable lifetime budget');
      let maintenance: StudyTaskResult['maintenance'], fatal: {error:unknown}|undefined;
      const context: LearningRunContext = {runtime:environment.runtime,task:learningTask(options.task,inputDigest),input:options.task.text,id:`study-production-decision-${randomUUID()}`,
        attemptId:intent.attemptId,observationId:intent.observationId,split:'train',timeoutMs:environment.timeoutMs,budget:this.#budget(state,lease,counter,options.maxLaunches,options.task,journal),expectedBinding:expectedStudyBinding(state,options.task.text),
        verify:turn => verifyStudyOutput(turn.text,options.task.expected),...(options.signal === undefined ? {} : {signal:options.signal})};
      if (options.autoImprove) {
        context.maintenanceTimeoutMs = 20 * 60 * 1000;
        context.maintenance = async ({signal}) => {
          try {
            const terminal = await environment.evidence.get('observation',intent!.observationId);
            if (!terminal) throw new Error('Production terminal missing before maintenance');
            intent!.terminalDigest = terminal.digest; await journal.save(lease!,state);
            const owned = lease; lease = undefined; await owned!.release();
          } catch (error) { fatal = {error}; throw error; }
          if (counter.attempts >= options.maxLaunches) { maintenance = {status:'deferred',reason:'No remaining invocation launch budget'}; return; }
          const maintenanceJournal = this.#newJournal();
          try { maintenance = await this.#runCycles({maxLaunches:options.maxLaunches-counter.attempts,mode:'maintenance',...(options.cycles === undefined ? {} : {cycles:options.cycles}),signal},counter,maintenanceJournal); }
          catch (error) { if (maintenanceJournal.failureCount > 0) fatal = {error}; maintenance = {status:'failed',reason:'Maintenance failed'}; throw error; }
        };
      }
      const result = await environment.router.run(environment.definition,context);
      if (fatal) throw fatal.error;
      if (lease) { intent.terminalDigest = result.observation.digest; await journal.save(lease,state); }
      const admittedAttempts = counter.admittedAttempts ?? state.admittedAttempts;
      return {status:'completed',turn:result.turn,receipt:result.receipt,observation:result.observation,...await resultBase(),admittedAttempts,
        invocationAttempts:counter.attempts,...(maintenance === undefined ? {} : {maintenance})};
    } catch (error) { failure = {error}; throw error; }
    finally { await release(lease,failure,() => journal.recordFailure()); }
  }
}
