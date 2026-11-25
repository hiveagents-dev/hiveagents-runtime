import { afterEach, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { OperationScope } from '../../src/control/operation-scope.js';
import type { AgentReadiness } from '../../src/public/types.js';
import { LearningRouter } from '../../src/routing/learning/router.js';
import * as estimator from '../../src/routing/learning/estimator.js';
import { inputDigest } from '../../src/routing/learning/features.js';
import type { EvidenceMap, LearningStore, PutKind } from '../../src/routing/learning/types.js';
const runtime=new Runtime(), domain={id:'router-review',sourceDigest:'a'.repeat(64),scorerDigest:'b'.repeat(64),protocolDigest:'c'.repeat(64)};
const definition={model:{mode:'auto' as const,allowUnverifiedModels:true,candidates:[{id:'a',model:'codex/gpt-5.4'}]}};
const context={runtime,task:{id:'task',version:'1',text:'task',inputDigest:inputDigest('task')}};
function harness(){
  const records=new Map<string,unknown>();
  const store={async put<K extends PutKind>(kind:K,id:string,row:EvidenceMap[K]){if(records.has(`${kind}:${id}`))throw Object.assign(new Error('duplicate'),{code:'LEARNING_RECORD_EXISTS'});records.set(`${kind}:${id}`,row);},async get(kind:string,id:string){return records.get(`${kind}:${id}`);},async pointer(){return {generation:0,active:null,previous:null};},async highWater(){return 0;},async observations(){return [];},async appendObservation(){throw new Error('unused');},async pending(){return [];},async commitGate(){throw new Error('unused');},close(){}} as LearningStore;
  vi.spyOn(Agent.prototype,'ready').mockImplementation(async function(this:Agent){return {ready:true,model:this.model,provider:this.model.provider,installation:{installed:true},auth:{authenticated:true,source:'subscription'},capabilities:{unsupported:[]},plan:{transport:'exec',fingerprint:{adapterVersion:'1',cliVersion:'1',executableRealpath:'/fixture'},capabilities:{},envelope:{authorityEpoch:crypto.randomUUID()},warnings:[]}} as unknown as AgentReadiness;});
  return {records,store,router:new LearningRouter({store,domain})};
}
afterEach(()=>vi.restoreAllMocks());
it('captures one replay time for selection, predictions and the immutable receipt',async()=>{
  const h=harness(), scope=await h.router.preflight(definition,context), snapshot=estimator.buildSnapshot(scope.domain,estimator.DEFAULT_LEARNING_POLICY,0,[],Date.now(),{definitionDigest:scope.definitionDigest,actions:scope.actions,features:{schema:'oar-hash-ngrams-v1',dimensions:128}});
  h.records.set(`snapshot:${snapshot.digest}`,snapshot);h.store.pointer=async()=>({generation:1,active:snapshot.digest,previous:null});const router=new LearningRouter({store:h.store,domain});
  const select=vi.spyOn(estimator,'selectPolicyDecision'),predict=vi.spyOn(estimator,'predict');let tick=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>++tick);
  const result=await router.createAgent(definition,context);
  expect(select.mock.calls[0]![3]).toBe(result.receipt.createdAt);expect(predict.mock.calls.at(-1)![3]).toBe(result.receipt.createdAt);expect(result.receipt.reason).toBe('INCUMBENT');
});
it('blocks an agent return when cancellation arrives during final settlement',async()=>{
  const h=harness(),controller=new AbortController();vi.spyOn(OperationScope.prototype,'drain').mockImplementation(async()=>{queueMicrotask(()=>controller.abort());});
  await expect(h.router.createAgent(definition,{...context,signal:controller.signal})).rejects.toThrow();
});
it('returns an exact immutable snapshot after a concurrent duplicate insert',async()=>{
  const h=harness();vi.spyOn(Date,'now').mockReturnValue(Date.now());
  const values=await Promise.all([h.router.shadow(definition,context),h.router.shadow(definition,context)]);
  expect(values[0]).toEqual(values[1]);expect(Object.isFrozen(values[0])).toBe(true);
});
it('uses bounded schema/dimension/action training queries before the SQL limit',async()=>{
  const h=harness(),query=vi.spyOn(h.store,'observations');const router=new LearningRouter({store:h.store,domain,policy:{maxRows:7}});
  const snapshot=await router.shadow(definition,context);
  expect(query.mock.calls[0]![1]).toEqual({through:0,split:'train',verifiedOnly:true,schema:'oar-hash-ngrams-v1',dimensions:128,actionKeys:snapshot.binding!.actions.map(a=>a.key),limit:7});
});
it('does not swallow an unrelated snapshot write IO failure',async()=>{
  const h=harness(),error=new Error('raw IO');h.store.put=async()=>{throw error;};const router=new LearningRouter({store:h.store,domain});
  await expect(router.shadow(definition,context)).rejects.toBe(error);
});
it('uses incumbent/null-policy for a standalone unbound active snapshot',async()=>{
  const h=harness(),scope=await h.router.preflight(definition,context),snapshot=estimator.buildSnapshot(scope.domain,estimator.DEFAULT_LEARNING_POLICY,0,[],Date.now());
  h.records.set(`snapshot:${snapshot.digest}`,snapshot);h.store.pointer=async()=>({generation:1,active:snapshot.digest,previous:null});const router=new LearningRouter({store:h.store,domain});
  const result=await router.createAgent(definition,context);expect(result.receipt.policy).toBeNull();expect(result.receipt.reason).toBe('INCUMBENT');
});
