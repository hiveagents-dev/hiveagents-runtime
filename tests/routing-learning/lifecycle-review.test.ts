import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { TimeoutError } from '../../src/public/errors.js';
import type { AgentReadiness, Turn } from '../../src/public/types.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import type { EvidenceMap, LearningObservation, LearningStore, PutKind, SequencedObservation } from '../../src/routing/learning/types.js';
const runtime = new Runtime();
const domain = { id: 'review', sourceDigest: 'a'.repeat(64), scorerDigest: 'b'.repeat(64), protocolDigest: 'c'.repeat(64) };
const input = 'immutable result test';
function turn(): Turn { return { status: 'completed', session: { provider: 'codex', model: 'gpt-5.4', transport: 'exec', cwd: process.cwd(), cliVersion: '1' } as Turn['session'], text: 'verified', events: [], warnings: [], providerMetadata: {} }; }
function harness() {
  const records = new Map<string, unknown>(), observations: SequencedObservation[] = [];
  const store = { async put<K extends PutKind>(kind: K, id: string, row: EvidenceMap[K]) { if(records.has(`${kind}:${id}`)) throw new Error('duplicate'); records.set(`${kind}:${id}`,row); },
    async get(kind: string,id: string) { return records.get(`${kind}:${id}`); }, async pointer() { return {generation:0,active:null,previous:null}; }, async highWater() { return observations.length; }, async observations() { return observations; },
    async appendObservation(observation: LearningObservation) { const row = {sequence:observations.length+1,observation}; observations.push(row); return row; }, async pending() { return []; }, async commitGate() { throw new Error('unused'); }, close() {},
  } as LearningStore;
  const budget = { acquire: vi.fn(() => ({release:vi.fn()})) }, verify = vi.fn((value:Turn) => ({value:value.text==='verified'?1:0,passed:true}));
  const context = {runtime,input,task:{id:'task',version:'1',inputDigest:inputDigest(input),text:input},budget,verify};
  const router = new LearningRouter({store,domain});
  vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent) { return {ready:true,model:this.model,provider:this.model.provider,installation:{installed:true},auth:{authenticated:true,source:'subscription'},capabilities:{unsupported:[]},plan:{transport:'exec',fingerprint:{adapterVersion:'1',cliVersion:'1',executableRealpath:'/fixture/provider'},capabilities:{},envelope:{authorityEpoch:crypto.randomUUID(),filesystem:{readonlyRoots:[process.cwd()],writableRoots:[]}},warnings:[]}} as unknown as AgentReadiness; });
  vi.spyOn(Agent.prototype,'close').mockResolvedValue();
  const stream = vi.spyOn(Agent.prototype,'stream').mockImplementation(async function*() { yield {type:'turn.completed',turn:turn()}; });
  return {records,observations,store,budget,verify,context,router,stream};
}
afterEach(() => vi.restoreAllMocks());
it('freezes every verifier-visible turn field before any post-ready await and returns that exact copy', async () => {
  const h=harness(), result=turn(); let calls=0;
  h.stream.mockImplementation(async function*(){yield {type:'turn.completed',turn:result};});
  const original=Agent.prototype.ready;
  vi.mocked(Agent.prototype.ready).mockImplementation(async function(this:Agent){ const ready = {ready:true,model:this.model,provider:this.model.provider,installation:{installed:true},auth:{authenticated:true,source:'subscription'},capabilities:{unsupported:[]},plan:{transport:'exec',fingerprint:{adapterVersion:'1',cliVersion:'1',executableRealpath:'/fixture/provider'},capabilities:{},envelope:{authorityEpoch:'x',filesystem:{readonlyRoots:[process.cwd()],writableRoots:[]}},warnings:[]}} as unknown as AgentReadiness; if(++calls===3){ result.text='tampered';result.events.push({type:'message.delta',text:'tampered'}); } return ready; });
  const value=await h.router.run({model:'codex/gpt-5.4'},h.context);
  expect(value.turn.text).toBe('verified');expect(value.turn).toBe(h.verify.mock.calls[0]![0]);expect(Object.isFrozen(value.turn)).toBe(true);expect(Object.isFrozen(value.turn.events)).toBe(true);
});
it.each([.5,Number.MAX_SAFE_INTEGER+1])('records malformed token usage %s as terminal unknown without invalid usage',async tokens=>{
  const h=harness();h.stream.mockImplementation(async function*(){yield {type:'turn.completed',turn:{...turn(),usage:{costMeaning:'provider-reported',inputTokens:tokens}}};});
  await expect(h.router.run({model:'codex/gpt-5.4'},h.context)).rejects.toThrow();
  expect(h.observations).toHaveLength(1);expect(h.observations[0]!.observation.quality.state).toBe('unknown');expect(h.observations[0]!.observation.usage).toBeUndefined();
});
it('classifies a provider timeout before the overall deadline as right-censored native latency',async()=>{
  const h=harness(), error=new TimeoutError({retryable:true},'native deadline');h.stream.mockImplementation(async function*(){throw error;});
  await expect(h.router.run({model:'codex/gpt-5.4'},h.context)).rejects.toBe(error);
  expect(h.observations[0]!.observation.outcome).toBe('timeout');expect(h.observations[0]!.observation.latency.state).toBe('right-censored');
});
it('retains observed native latency when a later verifier aborts',async()=>{
  const h=harness(), controller=new AbortController();
  await expect(h.router.run({model:'codex/gpt-5.4'},{...h.context,signal:controller.signal,verify(){controller.abort();return {value:1,passed:true};}})).rejects.toThrow();
  expect(h.observations[0]!.observation.quality.state).toBe('unknown');expect(h.observations[0]!.observation.latency.state).toBe('observed');
});
it.each([{cliVersion:'2'},{transport:'control'},{cwd:'/another/directory'}])('excludes observed session identity drift %j even with matching sampled probes',async changed=>{
  const h=harness();h.stream.mockImplementation(async function*(){const value=turn();value.session={...value.session,...changed} as Turn['session'];yield {type:'turn.completed',turn:value};});
  await expect(h.router.run({model:'codex/gpt-5.4'},h.context)).rejects.toThrow(/identity/i);expect(h.verify).not.toHaveBeenCalled();expect(h.observations[0]!.observation.outcome).toBe('identity-drift');
});
it('rejects a known training observation or attempt ID conflict before reserving',async()=>{
  const h=harness();h.records.set('observation:existing',{});h.records.set('attempt:started',{});
  await expect(h.router.run({model:'codex/gpt-5.4'},{...h.context,observationId:'existing'})).rejects.toThrow();
  await expect(h.router.run({model:'codex/gpt-5.4'},{...h.context,attemptId:'started'})).rejects.toThrow();
  expect(h.budget.acquire).not.toHaveBeenCalled();expect(h.stream).not.toHaveBeenCalled();
});
it('attributes delegated usage only to an explicitly requested-system action and isolates its model-scoped identity',async()=>{
  const h=harness();h.stream.mockImplementation(async function*(){yield {type:'turn.completed',turn:{...turn(),usage:{costMeaning:'provider-reported',perModel:{delegate:{inputTokens:1}}}}};});
  const system={model:{mode:'auto' as const,allowUnverifiedModels:true,candidates:[{id:'a',model:'codex/gpt-5.4',evidenceScope:'requested-system' as const}]}};
  const model={model:{...system.model,candidates:[{id:'a',model:'codex/gpt-5.4',evidenceScope:'model' as const}]}};
  const expected=await h.router.preflight(model,{runtime,task:h.context.task});
  const result=await h.router.run(system,h.context);
  expect(result.observation.quality.state).toBe('verified');expect(result.observation.observedModels).toEqual(['delegate']);
  expect(result.receipt.selected?.key).not.toBe(expected.actions[0]!.key);expect(result.receipt.selected?.optionsDigest).not.toBe(expected.actions[0]!.optionsDigest);
});
it('still excludes a mismatched primary session in requested-system scope',async()=>{
  const h=harness();h.stream.mockImplementation(async function*(){const value=turn();value.session.model='other-primary';yield {type:'turn.completed',turn:value};});
  await expect(h.router.run({model:{mode:'auto',allowUnverifiedModels:true,candidates:[{id:'a',model:'codex/gpt-5.4',evidenceScope:'requested-system'}]}},h.context)).rejects.toThrow(/identity/i);
  expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('omits malformed oversized per-model usage while terminalizing the attempt',async()=>{
  const h=harness(),perModel=Object.fromEntries(Array.from({length:65},(_,i)=>[`delegate-${i}`,{inputTokens:1}]));
  h.stream.mockImplementation(async function*(){yield {type:'turn.completed',turn:{...turn(),usage:{costMeaning:'provider-reported',perModel}}};});
  await expect(h.router.run({model:'codex/gpt-5.4'},h.context)).rejects.toThrow();expect(h.observations).toHaveLength(1);expect(h.observations[0]!.observation.usage).toBeUndefined();expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('preserves the original provider error when its observed usage is malformed',async()=>{
  const h=harness(),error=Object.assign(new Error('provider failed'),{observedUsage:{costMeaning:'provider-reported',inputTokens:.5}});
  h.stream.mockImplementation(async function*(){throw error;});await expect(h.router.run({model:'codex/gpt-5.4'},h.context)).rejects.toBe(error);
  expect(h.observations[0]!.observation.usage).toBeUndefined();expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('freezes the turn at the terminal event before the provider resumes and mutates its retained reference',async()=>{
  const h=harness(),value=turn();value.text='wrong';
  h.stream.mockImplementation(async function*(){yield {type:'turn.completed',turn:value};value.text='verified';value.events.push({type:'message.delta',text:'tampered after terminal'});});
  const result=await h.router.run({model:'codex/gpt-5.4'},h.context);
  expect(result.turn.text).toBe('wrong');expect(result.turn.events).toEqual([]);expect(result.observation.quality).toEqual({state:'verified',value:0,passed:true});
  expect(result.turn).toBe(h.verify.mock.calls[0]![0]);expect(Object.isFrozen(result.turn)).toBe(true);
});
it('still drains provider cleanup and preserves its original failure after capturing a terminal event',async()=>{
  const h=harness(),value=turn(),error=new Error('original stream cleanup failure');let settled=false;
  h.stream.mockImplementation(async function*(){try{yield {type:'turn.completed',turn:value};value.text='tampered';await Promise.resolve();throw error;}finally{settled=true;}});
  await expect(h.router.run({model:'codex/gpt-5.4'},h.context)).rejects.toBe(error);expect(settled).toBe(true);expect(h.verify).not.toHaveBeenCalled();expect(h.observations[0]!.observation.quality.state).toBe('unknown');
});
it('allows bounded maintenance to outlive the completed production deadline while preserving its verified result',async()=>{
  vi.useFakeTimers({now:Date.now(),toFake:['setTimeout','clearTimeout','Date','performance']});
  try{
    const h=harness();let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
    const running=h.router.run({model:'codex/gpt-5.4'},{...h.context,timeoutMs:10,maintenance:async()=>{entered();await new Promise<void>(r=>setTimeout(r,25));}});
    const observed=running.then(result=>({result}),error=>({error}));await started;await vi.advanceTimersByTimeAsync(25);const outcome=await observed;if('error' in outcome)throw outcome.error;const result=outcome.result;
    expect(result.observation.quality).toEqual({state:'verified',value:1,passed:true});expect(result.maintenance).toEqual({status:'completed'});
  }finally{vi.useRealTimers();}
});
it('times out maintenance with its own signal, awaits cleanup and retains the completed model result',async()=>{
  vi.useFakeTimers({now:Date.now(),toFake:['setTimeout','clearTimeout','Date','performance']});
  try{
    const h=harness();let entered!:()=>void,cleaned=false;const started=new Promise<void>(r=>{entered=r;});
    const running=h.router.run({model:'codex/gpt-5.4'},{...h.context,timeoutMs:10,maintenanceTimeoutMs:30,maintenance:async({signal}:{signal:AbortSignal})=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{setTimeout(()=>{cleaned=true;resolve();},5);},{once:true}));}});
    await started;await vi.advanceTimersByTimeAsync(30);expect(cleaned).toBe(false);await vi.advanceTimersByTimeAsync(5);const result=await running;
    expect(cleaned).toBe(true);expect(result.maintenance).toEqual({status:'failed',code:'MAINTENANCE_TIMEOUT'});expect(result.observation.quality.state).toBe('verified');
  }finally{vi.useRealTimers();}
});
it('rejects explicit caller abort only after the maintenance hook and its cleanup settle',async()=>{
  const h=harness(),controller=new AbortController();let entered!:()=>void,release!:()=>void,cleanup=false;
  const started=new Promise<void>(r=>{entered=r;}),pending=new Promise<void>(r=>{release=r;});
  const running=h.router.run({model:'codex/gpt-5.4'},{...h.context,signal:controller.signal,maintenanceTimeoutMs:1000,maintenance:async({signal}:{signal:AbortSignal})=>{entered();await pending;expect(signal.aborted).toBe(true);cleanup=true;}});
  const rejected=expect(running).rejects.toMatchObject({code:'ABORTED'});await started;controller.abort();await Promise.resolve();expect(cleanup).toBe(false);release();await rejected;expect(cleanup).toBe(true);
});
it('rejects an invalid maintenance timeout before admission or execution',async()=>{
  const h=harness();await expect(h.router.run({model:'codex/gpt-5.4'},{...h.context,maintenanceTimeoutMs:0})).rejects.toThrow();
  expect(h.budget.acquire).not.toHaveBeenCalled();expect(h.stream).not.toHaveBeenCalled();
});
