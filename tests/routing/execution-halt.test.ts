import {afterEach,describe,expect,it,vi} from 'vitest';
import {Agent} from '../../src/public/agent.js';
import {Runtime} from '../../src/core/runtime.js';
import type {AgentReadiness,Turn} from '../../src/public/types.js';
import {ExecutionHaltedError,isExecutionHalted} from '../../src/public/execution-halt.js';
import {createAgent} from '../../src/routing/index.js';
import {LearningRouter} from '../../src/routing/learning/router.js';
import {inputDigest} from '../../src/routing/learning/features.js';
import type {LearningStore} from '../../src/routing/learning/types.js';

const runtime=new Runtime();
const ready=(a:Agent)=>({ready:true,model:a.model,provider:a.model.provider,auth:{authenticated:true,source:'subscription'},installation:{installed:true},capabilities:{unsupported:[],transport:'exec'},plan:{transport:'exec',fingerprint:{adapterVersion:'1',cliVersion:'1',executableRealpath:'/synthetic/provider'},capabilities:{},envelope:{},warnings:[]}} as unknown as AgentReadiness);
const definition={model:{mode:'auto' as const,candidates:['claude/sonnet','codex/gpt-5.4'],fallback:'codex/gpt-5.4',allowUnverifiedModels:true}};
const learningDefinition={model:{mode:'auto' as const,candidates:[{id:'primary',model:'claude/sonnet'},{id:'fallback',model:'codex/gpt-5.4'}],fallback:'fallback',allowUnverifiedModels:true}};
const task={id:'task',version:'1',text:'ordinary task',inputDigest:inputDigest('ordinary task')};
const domain={id:'halt-fixture',sourceDigest:'a'.repeat(64),scorerDigest:'b'.repeat(64),protocolDigest:'c'.repeat(64)};
function store(){return {put:vi.fn(async()=>{}),get:vi.fn(async()=>undefined),pointer:vi.fn(async()=>({generation:0,active:null,previous:null})),highWater:vi.fn(async()=>0),observations:vi.fn(async()=>[]),appendObservation:vi.fn(async()=>{throw Error('unused')}),commitGate:vi.fn(async()=>{throw Error('unused')}),pending:vi.fn(async()=>[]),close:vi.fn()} as unknown as LearningStore;}
afterEach(()=>vi.restoreAllMocks());
describe('routing preserves infrastructure halts',()=>{
 it.each(['direct','aggregate','cause','simultaneous-abort'] as const)('stable selector stops without fallback on %s',async mode=>{
  const halt=new ExecutionHaltedError();const failure=mode==='aggregate'?new AggregateError([Error('primary'),halt]):mode==='cause'?new Error('wrapper',{cause:halt}):halt;
  const controller=new AbortController();const providers:string[]=[];
  vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent){providers.push(this.model.provider);if(this.model.provider==='claude'){if(mode==='simultaneous-abort')controller.abort();throw failure}return ready(this)});
  const receipts={save:vi.fn(async()=>{}),load:vi.fn(async()=>undefined)};
  await expect(createAgent(definition,{runtime,receipts,signal:controller.signal})).rejects.toBe(failure);
  expect(providers).toEqual(['claude']);expect(receipts.save).not.toHaveBeenCalled();
 });
 for(const method of ['preflight','createAgent','shadow'] as const){
  it.each([false,true])(`learning ${method} stops before another candidate, even with abort=%s`,async abort=>{
   const failure=new AggregateError([Error('primary'),new ExecutionHaltedError()]);const controller=new AbortController();const providers:string[]=[];
   vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent){providers.push(this.model.provider);if(this.model.provider==='claude'){if(abort)controller.abort();throw failure}return ready(this)});
   const evidence=store(),router=new LearningRouter({store:evidence,domain});
   await expect(router[method](learningDefinition,{runtime,task,signal:controller.signal})).rejects.toBe(failure);
   expect(providers).toEqual(['claude']);expect(evidence.put).not.toHaveBeenCalled();
  });
 }
 it('ordinary readiness failures retain existing fallback behavior',async()=>{
  const providers:string[]=[];
  vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent){providers.push(this.model.provider);if(this.model.provider==='claude')throw Error('ordinary provider refusal');return ready(this)});
  const receipts={save:vi.fn(async()=>{}),load:vi.fn(async()=>undefined)};
  expect((await createAgent(definition,{runtime,receipts})).agent.model.provider).toBe('codex');expect(providers).toEqual(['claude','codex']);
 });
});

it('learning run preserves a readiness halt plus a logical-release halt without training or maintenance',async()=>{
 const primary=new ExecutionHaltedError(),releaseFailure=new ExecutionHaltedError();const evidence=store();
 const release=vi.fn(async()=>{throw releaseFailure}),verify=vi.fn(()=>({value:1,passed:true})),maintenance=vi.fn(async()=>{});
 const probes=vi.spyOn(Agent.prototype,'ready').mockRejectedValue(primary),stream=vi.spyOn(Agent.prototype,'stream');
 const router=new LearningRouter({store:evidence,domain});let thrown:unknown;
 try{await router.run(learningDefinition,{runtime,task,input:task.text,budget:{acquire:async()=>({release})},verify,maintenance})}catch(error){thrown=error}
 expect(thrown).toBeInstanceOf(AggregateError);expect((thrown as AggregateError).errors).toEqual([primary,releaseFailure]);expect(isExecutionHalted(thrown)).toBe(true);
 expect(probes).toHaveBeenCalledOnce();expect(stream).not.toHaveBeenCalled();expect(evidence.appendObservation).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();expect(maintenance).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
});
it.each(['stream','cleanup'] as const)('learning %s infrastructure halt produces unknown quality and latency',async phase=>{
 const halt=new ExecutionHaltedError(),evidence=store(),observations:unknown[]=[];
 evidence.appendObservation=vi.fn(async observation=>{observations.push(observation);return{sequence:1,observation}});
 vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent){return ready(this)});
 vi.spyOn(Agent.prototype,'close').mockImplementation(async()=>{if(phase==='cleanup')throw halt});
 vi.spyOn(Agent.prototype,'stream').mockImplementation(async function*(){
  if(phase==='stream')throw halt;
  yield{type:'turn.completed' as const,turn:{status:'completed' as const,session:{provider:'codex',model:'gpt-5.4'} as Turn['session'],text:'synthetic',events:[],warnings:[],providerMetadata:{}}};
 });
 const maintenance=vi.fn(async()=>{}),router=new LearningRouter({store:evidence,domain});
 await expect(router.run({model:'codex/gpt-5.4'},{runtime,task,input:task.text,budget:{acquire:async()=>({release:async()=>{}})},verify:()=>({value:1,passed:true}),maintenance})).rejects.toBe(halt);
 expect(observations).toHaveLength(1);expect(observations[0]).toMatchObject({quality:{state:'unknown',reason:'EXECUTION_HALTED'},latency:{state:'unknown'}});expect(maintenance).not.toHaveBeenCalled();
});

it.each([false,true])('learning waits for logical release before publishing terminal evidence (aggregate=%s)',async aggregate=>{
 const halt=new ExecutionHaltedError(),failure=aggregate?new AggregateError([Error('release primary'),halt]):halt;
 const evidence=store(),observations:unknown[]=[],order:string[]=[];
 evidence.appendObservation=vi.fn(async observation=>{order.push('observation');observations.push(observation);return{sequence:1,observation}});
 vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent){return ready(this)});
 vi.spyOn(Agent.prototype,'close').mockResolvedValue(undefined);
 vi.spyOn(Agent.prototype,'stream').mockImplementation(async function*(){yield{type:'turn.completed' as const,turn:{status:'completed' as const,
  session:{provider:'codex',model:'gpt-5.4'} as Turn['session'],text:'synthetic',events:[],warnings:[],providerMetadata:{}}};});
 const release=vi.fn(async()=>{order.push('release');throw failure}),maintenance=vi.fn(async()=>{});
 const router=new LearningRouter({store:evidence,domain});
 await expect(router.run({model:'codex/gpt-5.4'},{runtime,task,input:task.text,budget:{acquire:async()=>({release})},
  verify:()=>({value:0,passed:false}),maintenance})).rejects.toBe(failure);
 expect(order).toEqual(['release','observation']);expect(release).toHaveBeenCalledOnce();
 expect(observations).toHaveLength(1);expect(observations[0]).toMatchObject({quality:{state:'unknown',reason:'EXECUTION_HALTED'},latency:{state:'unknown'}});
 expect(evidence.put).not.toHaveBeenCalledWith('snapshot',expect.anything(),expect.anything());expect(maintenance).not.toHaveBeenCalled();
});
