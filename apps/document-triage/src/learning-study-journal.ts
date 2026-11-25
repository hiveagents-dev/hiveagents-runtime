import { join, resolve } from 'node:path';
import { FileWorkflowStore, type WorkflowLease, type JsonValue } from 'hiveagents-runtime/orchestration';
import { learningDigest, validateLearningRecord, validatePolicyConfig } from 'hiveagents-runtime/routing/learning';
import type { StudyJournal } from './learning-study-types.js';
import { cellsFor, planCycle, assertPlanBounds, stableId } from './learning-study-plan.js';
const fail = (): never => { throw new Error('Corrupt study journal'); };
const hash = (v: unknown) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(); };
const id = (v: unknown) => { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) fail(); };
const armId = (v: unknown) => { if (typeof v !== 'string' || !v.trim() || v.length > 128) fail(); };
const integer = (v: unknown, min = 0, max = 10000) => { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail(); };
function object(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k))
    || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail();
}
function list(v: unknown, max: number): asserts v is any[] { if (!Array.isArray(v) || v.length > max) fail(); }
function pointer(v: unknown): void { object(v, ['generation', 'active', 'previous']); integer(v.generation,0,Number.MAX_SAFE_INTEGER); for (const ref of [v.active, v.previous]) if (ref !== null) hash(ref); }
function identityTask(v: unknown): void { object(v, ['id', 'inputDigest', 'expectedDigest']); id(v.id); hash(v.inputDigest); hash(v.expectedDigest); }
/** Checkpoint values are JSON parsed by FileWorkflowStore; validate bounded private state, not corpus-size limits. */
export function validateStudyJournal(value: unknown): StudyJournal {
  object(value, ['format','studyId','domain','baseDigest','protocolDigest','definitionDigest','timeoutMs','binding','config','limits','evaluation','identity','admittedAttempts','calibration','cycles','production']);
  if (value.format !== 1) fail(); id(value.studyId);
  for (const key of ['domain','baseDigest','protocolDigest','definitionDigest']) hash(value[key]); integer(value.timeoutMs, 1, 2147483647);
  object(value.limits, ['maxCycles','maxLaunches','minNewTasks']); integer(value.limits.maxCycles, 1, 64); integer(value.limits.maxLaunches, 1); integer(value.limits.minNewTasks, 1, 128);
  object(value.evaluation, ['repetitions']); integer(value.evaluation.repetitions, 1, 8); integer(value.admittedAttempts, 0, value.limits.maxLaunches);
  validatePolicyConfig(value.config); if (value.config.alpha !== .05 / value.limits.maxCycles || value.config.minSimilarity !== .5) fail();
  object(value.binding, ['domain','definitionDigest','actions','candidates'], ['fallbackId']);
  hash(value.binding.domain); hash(value.binding.definitionDigest); list(value.binding.actions, 64); list(value.binding.candidates, 64);
  if (!value.binding.actions.length) fail();
  for (const a of value.binding.actions) {
    object(a, ['id','model','provider','modelId','evidenceScope','optionsDigest','executionDigest','key']); armId(a.id);
    for (const k of ['key','optionsDigest','executionDigest']) hash(a[k]);
    for (const k of ['model','provider','modelId']) if (typeof a[k] !== 'string' || !a[k].trim()) fail();
    if (!['model','requested-system'].includes(a.evidenceScope)) fail();
    const {id:_id,key,...identity} = a; if (key !== learningDigest(identity)) fail();
  }
  if (new Set(value.binding.actions.map((a:any) => a.key)).size !== value.binding.actions.length) fail();
  for (const c of value.binding.candidates) {
    object(c,['id','model','provider','modelId','status','code'],['action']); armId(c.id);
    if (c.status !== 'eligible' || c.code !== 'READY' || !c.action || learningDigest(c.action) !== learningDigest(value.binding.actions.find((a:any) => a.id === c.id))) fail();
  }
  if (learningDigest(value.binding.actions) !== learningDigest(value.binding.candidates.map((c:any) => c.action))) fail();
  object(value.identity, ['baseDigest','train','fixed','batches']); hash(value.identity.baseDigest);
  for (const [key, max] of [['train',128],['fixed',64]] as const) { list(value.identity[key], max); value.identity[key].forEach(identityTask); }
  list(value.identity.batches, value.limits.maxCycles);
  for (const b of value.identity.batches) { object(b,['id','digest','tasks']); id(b.id); hash(b.digest); list(b.tasks,128); b.tasks.forEach(identityTask); }
  list(value.calibration, 8192); list(value.cycles, value.limits.maxCycles); list(value.production,10000);
  const state = value as unknown as StudyJournal;
  if (learningDigest(state.calibration) !== learningDigest(cellsFor(state.studyId, state.identity.train, state.binding.actions, 'train', 1))) fail();
  let unfinished = false;
  for (const c of state.cycles) {
    object(c,['id','batchId','batchDigest','gateId','operation','before','cells','completed'],['challenger','fixed','fresh','seenTrain','seenThrough']);
    if (unfinished || !['promote','rollback'].includes(c.operation) || typeof c.completed !== 'boolean') fail();
    unfinished = !c.completed; pointer(c.before); if (!state.identity.batches.some(b => b.id === c.batchId)) fail();
    const plan = planCycle(state,c.batchId,c.operation,c.before);
    for (const k of ['id','batchId','batchDigest','gateId','cells'] as const) if (learningDigest(c[k]) !== learningDigest(plan[k])) fail();
    if ('challenger' in c && c.challenger !== null) hash(c.challenger);
    for (const kind of ['fixed','fresh'] as const) if (c[kind]) {
      const e = validateLearningRecord('episode',c[kind]);
      if (e.kind !== kind || e.domain !== state.domain || e.id !== c.cells.find(cell => cell.split === kind)?.episodeId
        || e.definitionDigest !== state.binding.definitionDigest || e.protocolDigest !== state.protocolDigest
        || e.repetitions !== state.evaluation.repetitions || learningDigest(e.arms) !== learningDigest(state.binding.actions)
        || learningDigest(e.cells) !== learningDigest(c.cells.filter(cell => cell.split === kind).map(cell => ({taskDigest:cell.taskDigest,actionKey:cell.actionKey,repetition:cell.repetition,attemptId:cell.attemptId,observationId:cell.observationId})))) fail();
    }
    if (c.seenTrain) { list(c.seenTrain,10000); c.seenTrain.forEach(hash); integer(c.seenThrough,0,Number.MAX_SAFE_INTEGER); }
    if (c.completed && (!c.fixed || !c.fresh || c.challenger === undefined || !c.seenTrain)) fail();
  }
  if (new Set(state.cycles.map(c => c.batchId)).size !== state.cycles.length) fail();
  for (const p of state.production) { object(p,['id','inputDigest','expectedDigest','attemptId','observationId'],['terminalDigest']); id(p.id); hash(p.inputDigest); hash(p.expectedDigest); id(p.attemptId); id(p.observationId); if (p.terminalDigest) hash(p.terminalDigest);
    if (p.attemptId !== stableId('production-attempt',{study:state.studyId,id:p.id}) || p.observationId !== stableId('production-observation',{study:state.studyId,id:p.id})) fail(); }
  if (new Set(state.production.map(p => p.id)).size !== state.production.length) fail();
  assertPlanBounds(state); return state;
}
export class StudyJournalFile {
  readonly store: FileWorkflowStore; readonly runId: string;
  failureCount = 0;
  recordFailure() { this.failureCount++; }
  constructor(directory: string, studyId: string) { this.store = new FileWorkflowStore(join(resolve(directory), 'learning-study')); this.runId = `learning-study:${studyId}`; }
  async acquire(): Promise<WorkflowLease> {
    try { return await this.store.acquire(this.runId); } catch (error) { this.recordFailure(); throw error; }
  }
  async load(lease: WorkflowLease): Promise<StudyJournal|undefined> {
    try { return await this.#load(lease); } catch (error) { this.recordFailure(); throw error; }
  }
  async #load(lease: WorkflowLease): Promise<StudyJournal|undefined> {
    const checkpoint = await lease.load(); if (checkpoint === undefined) return undefined;
    object(checkpoint,['format','runId','workflow','status','steps']);
    object(checkpoint.workflow,['id','version','fingerprint']); object(checkpoint.steps,['study']);
    object(checkpoint.steps.study,['status','attempts','output']);
    if (checkpoint.format !== 1 || checkpoint.runId !== this.runId || checkpoint.status !== 'completed'
      || checkpoint.workflow.id !== 'learning-study-journal' || checkpoint.workflow.version !== '1'
      || checkpoint.steps.study.status !== 'completed' || checkpoint.steps.study.attempts !== 1) fail();
    const state = validateStudyJournal(checkpoint.steps.study.output);
    if (checkpoint.workflow.fingerprint !== learningDigest(state)) fail(); return state;
  }
  async save(lease: WorkflowLease, state: StudyJournal): Promise<void> {
    try { await this.#save(lease,state); } catch (error) { this.recordFailure(); throw error; }
  }
  async #save(lease: WorkflowLease, state: StudyJournal): Promise<void> {
    validateStudyJournal(state);
    await lease.save({ format: 1, runId: this.runId, workflow: { id: 'learning-study-journal', version:'1',fingerprint:learningDigest(state) }, status:'completed',
      steps:{study:{status:'completed',attempts:1,output:state as unknown as JsonValue}} });
  }
}
