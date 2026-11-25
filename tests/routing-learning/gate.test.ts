import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { AgentReadiness, Turn } from '../../src/public/types.js';
import { digest } from '../../src/routing/json.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
import { selectPolicy } from '../../src/routing/learning/estimator.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import { sealLearningRecord } from '../../src/routing/learning/validation.js';
import type { LearningEpisode, LearningFeatures, LearningPreflight, LearningSnapshot, PolicyRef } from '../../src/routing/learning/types.js';
const runtime = new Runtime();
const domain = { id: 'gates', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
const definition = { model: { mode: 'auto' as const, allowUnverifiedModels: true, candidates: [{ id: 'a', model: 'codex/gpt-5.4' }, { id: 'b', model: 'claude/sonnet' }] } };
const features = (family: string): LearningFeatures => ({ schema: 'fixture-context-v1', values: family === 'x' ? [1, 0] : [0, 1] });
const task = (text: string, family = 'y') => ({ id: text, version: '1', text, inputDigest: inputDigest(text), features: features(family) });
const budget = { acquire() { return { release() {} }; } };
const directories: string[] = [], stores: SqliteLearningStore[] = [];
let drift = false;
function setupProvider() {
  drift = false;
  vi.spyOn(Agent.prototype, 'ready').mockImplementation(async function(this: Agent) {
    return { ready: true, model: this.model, provider: this.model.provider, auth: { authenticated: true, source: 'subscription' }, installation: { installed: true },
      capabilities: { unsupported: [], transport: 'exec' }, plan: { transport: 'exec', fingerprint: { adapterVersion: '1', cliVersion: '1', executableRealpath: '/fixture/provider' }, capabilities: {}, envelope: { authorityEpoch: crypto.randomUUID() }, warnings: [] },
    } as unknown as AgentReadiness;
  });
  vi.spyOn(Agent.prototype, 'close').mockResolvedValue();
  vi.spyOn(Agent.prototype, 'stream').mockImplementation(async function* (this: Agent, input) {
    const family = String(input).startsWith('x-') ? 'x' : 'y';
    const winner = drift ? 'codex' : family === 'x' ? 'codex' : 'claude';
    const result: Turn = { status: 'completed', session: { provider: this.model.provider, model: this.model.id } as Turn['session'], text: this.model.provider === winner ? '1' : '0.2', events: [], warnings: [], providerMetadata: {} };
    yield { type: 'turn.completed', turn: result };
  });
}
const verify = (turn: Turn) => ({ value: Number(turn.text), passed: true });
async function harness() {
  setupProvider(); const dir = await mkdtemp(join(tmpdir(), 'oar-learning-gate-')); directories.push(dir);
  const path = join(dir, 'private', 'learning.sqlite'), store = new SqliteLearningStore(path); stores.push(store);
  const router = new LearningRouter({ store, domain, policy: { minDistinctTasks: 1, qualityFloor: 0, minSimilarity: .9 } });
  const preflight = await router.preflight(definition, { runtime, task: task('preflight') });
  for (const family of ['x', 'y']) for (let i = 0; i < 2; i++) for (const arm of definition.model.candidates) {
    const value = task(`${family}-training-${i}`, family);
    await router.run(definition, { runtime, task: value, input: value.text, evaluationArmId: arm.id, budget, verify });
  }
  const snapshot = await router.shadow(definition, { runtime, task: task('shadow') });
  return { store, router, preflight, snapshot, path };
}
async function episode(h: Awaited<ReturnType<typeof harness>>, id: string, kind: 'fixed'|'fresh', count: number, from: PolicyRef, to: PolicyRef, generation = 0, operation: 'promote'|'rollback' = 'promote', fixedEpisodeId = 'fixed', protocolDigest = domain.protocolDigest) {
  const tasks = Array.from({ length: count }, (_, i) => task(`y-${id}-${i}`));
  const cells = tasks.flatMap((t, i) => h.preflight.actions.map((a, j) => ({ taskDigest: t.inputDigest, actionKey: a.key, repetition: 0, attemptId: `${id}-attempt-${i}-${j}`, observationId: `${id}-observation-${i}-${j}` })));
  const manifest = sealLearningRecord('episode', { format: 1, id, domain: h.preflight.domain, kind, createdAt: Date.now(), definitionDigest: h.preflight.definitionDigest, protocolDigest,
    afterSequence: await h.store.highWater(h.preflight.domain), arms: h.preflight.actions, tasks: tasks.map(t => ({ taskDigest: t.inputDigest, features: t.features })), repetitions: 1, cells,
    ...(kind === 'fresh' ? { comparison: { expectedGeneration: generation, from, to, operation, fixedEpisodeId, config: h.snapshot.config, configDigest: digest(h.snapshot.config) } } : {}) });
  await h.store.put('episode', id, manifest);
  return { manifest, tasks };
}
async function collect(h: Awaited<ReturnType<typeof harness>>, suite: Awaited<ReturnType<typeof episode>>) {
  for (const value of suite.tasks) for (const action of h.preflight.actions) {
    const cell = suite.manifest.cells.find(c => c.taskDigest === value.inputDigest && c.actionKey === action.key)!;
    await h.router.run(definition, { runtime, task: value, input: value.text, budget, verify, evaluationArmId: action.id, split: suite.manifest.kind,
      episodeId: suite.manifest.id, repetition: cell.repetition, attemptId: cell.attemptId, observationId: cell.observationId });
  }
}
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('learns different context choices, activates only from complete paired heldouts, and survives restart', async () => {
  const h = await harness();
  const before = await h.router.createAgent(definition, { runtime, task: task('y-production-before') }); expect(before.receipt.selected?.id).toBe('a');
  const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h, fixed);
  const fresh = await episode(h, 'fresh', 'fresh', 6, null, h.snapshot.digest); await collect(h, fresh);
  const commit = await h.router.improve({ id: 'gate', freshEpisodeId: 'fresh' }); expect(commit.status).toBe('promoted');
  expect(commit.after).toEqual({ generation: 1, active: h.snapshot.digest, previous: null });
  for (const [family, selected] of [['x', 'a'], ['y', 'b']]) {
    const choice = await h.router.createAgent(definition, { runtime, task: task(`${family}-production-after`, family) }); expect(choice.receipt.selected?.id).toBe(selected);
  }
  h.store.close(); stores.splice(stores.indexOf(h.store), 1);
  const reopened = new SqliteLearningStore(h.path); stores.push(reopened); const router = new LearningRouter({ store: reopened, domain, policy: h.snapshot.config });
  expect(await router.inspect()).toEqual(commit.after);
  expect((await router.createAgent(definition, { runtime, task: task('y-after-restart') })).receipt.selected?.id).toBe('b');
  expect(await router.improve({ id: 'gate', freshEpisodeId: 'fresh' })).toEqual(commit);
  await expect(router.improve({ id: 'another-gate', freshEpisodeId: 'fresh' })).rejects.toThrow(/consumed/i);
});
it('keeps an incomplete prospective matrix and consumes its fresh episode', async () => {
  const h = await harness(); const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h, fixed);
  await episode(h, 'fresh', 'fresh', 6, null, h.snapshot.digest);
  const commit = await h.router.improve({ id: 'incomplete', freshEpisodeId: 'fresh' }); expect(commit.status).toBe('kept');
  const gate = await h.store.get('gate', 'incomplete'); expect(gate?.reason).toBe('INCOMPLETE');
  await expect(h.router.improve({ id: 'retry-new-gate', freshEpisodeId: 'fresh' })).rejects.toThrow(/consumed/i);
});
it('keeps active choices frozen as new feedback changes shadow, then permits measured rollback to null incumbent', async () => {
  const h = await harness(); const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h, fixed);
  const fresh = await episode(h, 'fresh', 'fresh', 6, null, h.snapshot.digest); await collect(h, fresh);
  await h.router.improve({ id: 'promote', freshEpisodeId: 'fresh' }); drift = true;
  for (let i = 0; i < 5; i++) for (const arm of definition.model.candidates) { const value = task(`y-new-feedback-${i}`); await h.router.run(definition, { runtime, task: value, input: value.text, budget, verify, evaluationArmId: arm.id }); }
  const updatedShadow = await h.router.shadow(definition, { runtime, task: task('y-updated-shadow') });
  expect(selectPolicy(updatedShadow, h.preflight.actions, features('y'), Date.now())?.id).toBe('a');
  expect((await h.router.createAgent(definition, { runtime, task: task('y-still-frozen') })).receipt.selected?.id).toBe('b');
  // A new fixed suite measures current drift; old outcomes cannot support a rollback claim.
  const fixedDrift = await episode(h, 'fixed-drift', 'fixed', 2, h.snapshot.digest, null, 1, 'rollback'); await collect(h, fixedDrift);
  const freshDrift = await episode(h, 'fresh-drift', 'fresh', 6, h.snapshot.digest, null, 1, 'rollback', 'fixed-drift'); await collect(h, freshDrift);
  const commit = await h.router.improve({ id: 'rollback', freshEpisodeId: 'fresh-drift' }); expect(commit.status).toBe('rolled-back');
  expect(commit.after.active).toBeNull(); expect(commit.after.previous).toBe(h.snapshot.digest);
  expect((await h.router.createAgent(definition, { runtime, task: task('y-restored-incumbent') })).receipt.selected?.id).toBe('a');
});
it('refuses changed definition and execution configurations to borrow prior learned support', async () => {
  const h = await harness(); const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h, fixed);
  const fresh = await episode(h, 'fresh', 'fresh', 6, null, h.snapshot.digest); await collect(h, fresh); await h.router.improve({ id: 'promote', freshEpisodeId: 'fresh' });
  const changed = await h.router.createAgent({ ...definition, effort: 'high' }, { runtime, task: task('y-new-effort') });
  expect(changed.receipt.selected?.id).toBe('a'); expect(changed.receipt.predictions.every(p => p.reason === 'cold-start')).toBe(true);
});
it('requires fresh evidence and rejects a stale prospective generation without changing active state', async () => {
  const h = await harness(); const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h, fixed);
  const first = await episode(h, 'fresh-one', 'fresh', 6, null, h.snapshot.digest); await collect(h, first);
  const second = await episode(h, 'fresh-two', 'fresh', 6, null, h.snapshot.digest); await collect(h, second);
  const promoted = await h.router.improve({ id: 'first-gate', freshEpisodeId: 'fresh-one' }); expect(promoted.status).toBe('promoted');
  const stale = await h.router.improve({ id: 'stale-gate', freshEpisodeId: 'fresh-two' }); expect(stale.status).toBe('stale'); expect(stale.after).toEqual(promoted.after);
  await expect(h.router.improve({ id: 'new-stale-gate', freshEpisodeId: 'fresh-two' })).rejects.toThrow(/consumed/i);
});
it('keeps a challenger with a measured fixed-suite regression despite positive fresh outcomes', async () => {
  const h = await harness(); drift = true;
  const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h, fixed); drift = false;
  const fresh = await episode(h, 'fresh', 'fresh', 6, null, h.snapshot.digest); await collect(h, fresh);
  const commit = await h.router.improve({ id: 'regression', freshEpisodeId: 'fresh' }); expect(commit.status).toBe('kept');
  expect((await h.store.get('gate', 'regression'))?.reason).toBe('REGRESSION'); expect((await h.router.inspect()).active).toBeNull();
});
it('rejects objective/config drift on restart and gate evaluation', async () => {
  const h = await harness(); const fixed = await episode(h, 'fixed', 'fixed', 2, null, h.snapshot.digest); await collect(h,fixed);
  const fresh = await episode(h, 'fresh', 'fresh', 6, null, h.snapshot.digest); await collect(h,fresh);
  const changed = new LearningRouter({store:h.store,domain,policy:{...h.snapshot.config,objective:'cost'}});
  await expect(changed.improve({id:'wrong-config',freshEpisodeId:'fresh'})).rejects.toThrow(/config/i);
  await h.router.improve({id:'promote',freshEpisodeId:'fresh'});
  await expect(changed.createAgent(definition,{runtime,task:task('y-config-drift')})).rejects.toThrow(/config/i);
});
it('does not apply an approved AB policy to an expanded ABC definition', async () => {
  const h = await harness(); const fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);
  const fresh=await episode(h,'fresh','fresh',6,null,h.snapshot.digest);await collect(h,fresh);await h.router.improve({id:'promote',freshEpisodeId:'fresh'});
  const expanded={model:{...definition.model,candidates:[...definition.model.candidates,{id:'c',model:'claude/sonnet',effort:'high'}]}};
  const result=await h.router.createAgent(expanded,{runtime,task:task('y-expanded')});
  expect(result.receipt.selected?.id).toBe('a');expect(result.receipt.policy).toBeNull();expect(result.receipt.reason).toBe('INCUMBENT');
});
it('replays an immutable incomplete commit after additional matrix rows without recomputing', async () => {
  const h=await harness(), fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);
  const fresh=await episode(h,'fresh','fresh',6,null,h.snapshot.digest);
  const kept=await h.router.improve({id:'incomplete-replay',freshEpisodeId:'fresh'});await collect(h,fresh);
  expect(await h.router.improve({id:'incomplete-replay',freshEpisodeId:'fresh'})).toEqual(kept);
});
it('derives omitted heldout cell IDs and rejects an explicit wrong terminal ID before admission', async () => {
  const h=await harness(), fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest), value=fixed.tasks[0]!, arm=h.preflight.actions[0]!;
  const cell=fixed.manifest.cells.find(c=>c.taskDigest===value.inputDigest&&c.actionKey===arm.key)!;
  const acquire=vi.fn(()=>({release(){}}));
  const context={runtime,task:value,input:value.text,budget:{acquire},verify,evaluationArmId:arm.id,split:'fixed' as const,episodeId:'fixed',repetition:0,attemptId:cell.attemptId};
  await expect(h.router.run(definition,{...context,observationId:'wrong-id'})).rejects.toThrow(/reserved|cell|observation/i);expect(acquire).not.toHaveBeenCalled();
  const result=await h.router.run(definition,context);expect(result.observation.id).toBe(cell.observationId);
});
it('rejects a stale matrix generation before admission or native dispatch', async () => {
  const h=await harness(), fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);
  const a=await episode(h,'fresh-a','fresh',6,null,h.snapshot.digest);await collect(h,a);
  const b=await episode(h,'fresh-b','fresh',6,null,h.snapshot.digest);await h.router.improve({id:'activate',freshEpisodeId:'fresh-a'});
  const value=b.tasks[0]!, arm=h.preflight.actions[0]!, acquire=vi.fn(()=>({release(){}}));
  await expect(h.router.run(definition,{runtime,task:value,input:value.text,budget:{acquire},verify,evaluationArmId:arm.id,split:'fresh',episodeId:'fresh-b',repetition:0})).rejects.toThrow(/stale/i);
  expect(acquire).not.toHaveBeenCalled();
});
it('rejects manifests whose protocol is unrelated to the constructor even when internally consistent',async()=>{
  const h=await harness(), protocol='f'.repeat(64);
  await episode(h,'wrong-fixed','fixed',2,null,h.snapshot.digest,0,'promote','wrong-fixed',protocol);
  await episode(h,'wrong-fresh','fresh',6,null,h.snapshot.digest,0,'promote','wrong-fixed',protocol);
  await expect(h.router.improve({id:'wrong-protocol',freshEpisodeId:'wrong-fresh'})).rejects.toThrow(/protocol/i);
});
it('checks actual full matrix universe before a durable start or native dispatch',async()=>{
  const h=await harness();
  const expanded={model:{...definition.model,candidates:[...definition.model.candidates,{id:'c',model:'claude/sonnet',effort:'high'}]}};
  const full=await h.router.preflight(expanded,{runtime,task:task('matrix-full-preflight')});
  // A malicious producer copied the full digest but omitted C from its matrix.
  const forged={...h,preflight:{...h.preflight,definitionDigest:full.definitionDigest}};
  const fixed=await episode(forged,'omitted-action','fixed',2,null,h.snapshot.digest),value=fixed.tasks[0]!, arm=h.preflight.actions[0]!;
  const calls=vi.mocked(Agent.prototype.stream).mock.calls.length, admitted=vi.fn(()=>({release(){}}));
  await expect(h.router.run(expanded,{runtime,task:value,input:value.text,budget:{acquire:admitted},verify,evaluationArmId:arm.id,split:'fixed',episodeId:'omitted-action',repetition:0})).rejects.toThrow(/full prepared action universe/i);
  expect(admitted).toHaveBeenCalledOnce();expect(vi.mocked(Agent.prototype.stream).mock.calls).toHaveLength(calls);expect(await h.store.pending(h.preflight.domain)).toHaveLength(0);
});
it('retrieves only the bounded union of prospective fixed and fresh observation IDs',async()=>{
  const h=await harness(),fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);
  const fresh=await episode(h,'fresh','fresh',6,null,h.snapshot.digest),query=vi.spyOn(h.store,'observations');
  const router=new LearningRouter({store:h.store,domain,policy:h.snapshot.config});await router.improve({id:'bounded-incomplete',freshEpisodeId:'fresh'});
  expect(query).toHaveBeenCalledOnce();expect(query.mock.calls[0]![1]).toEqual({observationIds:[...new Set([...fixed.manifest.cells,...fresh.manifest.cells].map(c=>c.observationId))]});
});
it('rechecks the matrix generation after the last readiness probe before native dispatch',async()=>{
  const h=await harness(),fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);
  const a=await episode(h,'fresh-a','fresh',6,null,h.snapshot.digest);await collect(h,a);const b=await episode(h,'fresh-b','fresh',6,null,h.snapshot.digest);
  const implementation=vi.mocked(Agent.prototype.ready).getMockImplementation()!;let calls=0;
  vi.mocked(Agent.prototype.ready).mockImplementation(async function(this:Agent,options){if(++calls===3)await h.router.improve({id:'late-activate',freshEpisodeId:'fresh-a'});return implementation.call(this,options);});
  const value=b.tasks[0]!,arm=h.preflight.actions[0]!,before=vi.mocked(Agent.prototype.stream).mock.calls.length;
  await expect(h.router.run(definition,{runtime,task:value,input:value.text,budget,verify,evaluationArmId:arm.id,split:'fresh',episodeId:'fresh-b',repetition:0})).rejects.toThrow(/stale/i);
  expect(vi.mocked(Agent.prototype.stream).mock.calls).toHaveLength(before);expect(await h.store.pending(h.preflight.domain)).toHaveLength(0);
});
it('reserves the planned terminal ID while training is pending so a prospective manifest cannot steal it',async()=>{
  const h=await harness(), value=task('y-training-pending'), implementation=vi.mocked(Agent.prototype.stream).getMockImplementation()!;
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
  vi.mocked(Agent.prototype.stream).mockImplementation(async function*(this:Agent,input,options){entered();await pending;yield* implementation.call(this,input,options);});
  const run=h.router.run(definition,{runtime,task:value,input:value.text,budget,verify,observationId:'reserved-training-terminal'});
  await started;
  try {
    expect((await h.store.pending(h.preflight.domain))[0]?.observationId).toBe('reserved-training-terminal');
    const heldout=task('y-prospective-conflict'),manifest=sealLearningRecord('episode',{format:1,id:'cannot-steal-training-terminal',domain:h.preflight.domain,kind:'fixed',createdAt:Date.now(),definitionDigest:h.preflight.definitionDigest,protocolDigest:domain.protocolDigest,afterSequence:await h.store.highWater(h.preflight.domain),arms:h.preflight.actions,tasks:[{taskDigest:heldout.inputDigest,features:heldout.features}],repetitions:1,cells:h.preflight.actions.map((a,i)=>({taskDigest:heldout.inputDigest,actionKey:a.key,repetition:0,attemptId:`conflict-attempt-${i}`,observationId:i===0?'reserved-training-terminal':`conflict-terminal-${i}`}))});
    await expect(h.store.put('episode',manifest.id,manifest)).rejects.toThrow(/reserved|used/i);
  } finally {release();}
  expect((await run).observation.id).toBe('reserved-training-terminal');
});
it('does not dispatch a training start whose planned terminal ID belongs to a heldout manifest',async()=>{
  const h=await harness(),fixed=await episode(h,'reserved-fixed','fixed',1,null,h.snapshot.digest),observationId=fixed.manifest.cells[0]!.observationId;
  const value=task('y-training-conflict'),before=vi.mocked(Agent.prototype.stream).mock.calls.length;
  await expect(h.router.run(definition,{runtime,task:value,input:value.text,budget,verify,observationId})).rejects.toThrow(/reserved|used|terminal|observation/i);
  expect(vi.mocked(Agent.prototype.stream).mock.calls).toHaveLength(before);expect(await h.store.pending(h.preflight.domain)).toHaveLength(0);
});
it('returns the first immutable commit when concurrent same-ID gates see incomplete versus complete evidence',async()=>{
  const h=await harness(),fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);const fresh=await episode(h,'fresh','fresh',6,null,h.snapshot.digest);
  const originalCommit=h.store.commitGate.bind(h.store),originalRows=h.store.observations.bind(h.store);let queries=0,committed!:()=>void;
  const firstCommitted=new Promise<void>(r=>{committed=r;});
  h.store.observations=async(d,options)=>{if(++queries===2){await firstCommitted;await collect(h,fresh);}return originalRows(d,options);};
  h.store.commitGate=async gate=>{const result=await originalCommit(gate);committed();return result;};
  const router=new LearningRouter({store:h.store,domain,policy:h.snapshot.config});
  const results=await Promise.all([router.improve({id:'concurrent-id',freshEpisodeId:'fresh'}),router.improve({id:'concurrent-id',freshEpisodeId:'fresh'})]);
  expect(results[0].status).toBe('kept');expect(results[1]).toEqual(results[0]);expect((await h.store.get('gate','concurrent-id'))?.reason).toBe('INCOMPLETE');
});
it('propagates raw gate commit IO even when an immutable same-ID commit already exists',async()=>{
  const h=await harness(),fixed=await episode(h,'fixed','fixed',2,null,h.snapshot.digest);await collect(h,fixed);await episode(h,'fresh','fresh',6,null,h.snapshot.digest);
  await h.router.improve({id:'existing-gate',freshEpisodeId:'fresh'});const get=h.store.get.bind(h.store);let initial=true;
  h.store.get=async(kind,id)=>{if(kind==='gate'&&id==='existing-gate'&&initial){initial=false;return undefined;}return get(kind,id);};
  const error=new Error('raw commit IO');h.store.commitGate=async()=>{throw error;};const router=new LearningRouter({store:h.store,domain,policy:h.snapshot.config});
  await expect(router.improve({id:'existing-gate',freshEpisodeId:'fresh'})).rejects.toBe(error);
});
it('reports incumbent when supported cost predictions have incomparable meanings and the shared selector retains priority',async()=>{
  const h=await harness(),costDomain={...domain,id:'cost-receipt'},policy={...h.snapshot.config,objective:'cost' as const};
  vi.mocked(Agent.prototype.stream).mockImplementation(async function*(this:Agent){const value:Turn={status:'completed',session:{provider:this.model.provider,model:this.model.id} as Turn['session'],text:'1',events:[],warnings:[],providerMetadata:{},usage:{costMeaning:this.model.provider==='codex'?'provider-reported':'estimate',reportedCostUsd:this.model.provider==='codex'?2:1}};yield {type:'turn.completed',turn:value};});
  const trainer=new LearningRouter({store:h.store,domain:costDomain,policy});
  for(let i=0;i<4;i++)for(const arm of definition.model.candidates){const value=task(`y-cost-training-${i}`);await trainer.run(definition,{runtime,task:value,input:value.text,budget,verify,evaluationArmId:arm.id});}
  const snapshot=await trainer.shadow(definition,{runtime,task:task('y-cost-shadow')}),scope=await trainer.preflight(definition,{runtime,task:task('y-cost-production')});
  expect(selectPolicy(snapshot,scope.actions,features('y'),Date.now())?.id).toBe('a');
  const original=h.store.pointer.bind(h.store);vi.spyOn(h.store,'pointer').mockImplementation(async d=>d===snapshot.domain?{generation:1,active:snapshot.digest,previous:null}:original(d));
  const router=new LearningRouter({store:h.store,domain:costDomain,policy}),result=await router.createAgent(definition,{runtime,task:task('y-cost-production')});
  expect(result.receipt.predictions.every(p=>p.reason==='supported')).toBe(true);expect(result.receipt.selected?.id).toBe('a');expect(result.receipt.reason).toBe('INCUMBENT');
});
