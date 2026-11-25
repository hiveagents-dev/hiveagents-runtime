import { ExecutionHaltedError } from 'hiveagents-runtime';
import { DecisionRunner, WorkflowRunner } from 'hiveagents-runtime/orchestration';
import type { DecisionRecord, DecisionStore, WorkflowDefinition, JsonValue } from 'hiveagents-runtime/orchestration';
import { LogDecisionStore, LogExecutionDatabase, LogWorkflowStore, inspectManagedEffect } from 'hiveagents-runtime/orchestration/log';
import type { LoggedOptions, LoggedState } from './logged-storage.js';
import { openLoggedState } from './logged-storage.js';
import { reportResult, verifyReport, writeReport, observedReportCount } from './logged-report.js';
/** Trusted in-process test/instrumentation ports. CLI never supplies these callbacks. */
export interface LoggedHooks { beforeReportWrite?():void; afterReportWrite?():void; afterDecisionSave?(record:DecisionRecord):void }
export function loggedDecisionOptions(state:LoggedState,hooks:LoggedHooks={},dispatch=true) {
 const manifest=state.manifest;
 return {id:manifest.decisionId,binding:manifest.binding,authorize:()=>({decision:'allow' as const,reason:'Owned local report policy',expiresAt:Date.now()+60000}),isCurrent:()=>true,
  execute:({intentId}:{intentId:string}):JsonValue=>{if(!dispatch)throw Error('Recovery cannot dispatch');hooks.beforeReportWrite?.();writeReport(manifest,intentId);hooks.afterReportWrite?.();return reportResult(manifest);},
  verify:(_result:JsonValue,context:{intentId:string})=>{const evidence=verifyReport(manifest,context.intentId);return {verified:evidence.kind==='applied',evidence:evidence.digest?[`owned-file:${evidence.digest}`]:[]};}};
}
function observedStore(store:LogDecisionStore,hooks:LoggedHooks):DecisionStore {return {async acquire(id){const lease=await store.acquire(id);return {load:()=>lease.load(),release:()=>lease.release(),async save(record){await lease.save(record);hooks.afterDecisionSave?.(record);}};}};}
export function loggedDefinition(state:LoggedState,store:DecisionStore,hooks:LoggedHooks={}):WorkflowDefinition {
 return {id:'document-triage-log',version:state.manifest.identity.harness.digest,steps:[
  {id:'intake',execute:()=>({documents:state.manifest.documents.length,inputDigest:state.manifest.inputDigest})},
  {id:'classify',dependencies:['intake'],execute:()=>state.manifest.payload},
  {id:'report',dependencies:['classify'],maxAttempts:3,replaySafe:true,async execute(){const record=await new DecisionRunner(store).run(loggedDecisionOptions(state,hooks));if(record.status!=='verified' || verifyReport(state.manifest,record.intentId).kind!=='applied')throw new ExecutionHaltedError();return reportResult(state.manifest);}},
 ]};
}
export async function runLoggedDocuments(options:LoggedOptions & {hooks?:LoggedHooks}) {
 const state=openLoggedState(options,true,true),database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:state.manifest.identity.systemId});
 try {
  const store=new LogDecisionStore({database,association:state.manifest.association}),hooks=options.hooks??{};
  const previous=inspectManagedEffect(database,state.manifest.association);
  if(previous?.metadata && ['intent','dispatched','needs-owner','verified'].includes(previous.metadata.status)) {
   const recovered=await new DecisionRunner(store).run(loggedDecisionOptions(state,{},false));
   if(recovered.status!=='verified')throw Error('Original report outcome requires owner verification');
  }
  const definition=loggedDefinition(state,observedStore(store,hooks),hooks),workflow=new LogWorkflowStore({database,identity:state.manifest.identity,definition});
  const checkpoint=await new WorkflowRunner(workflow).run(definition,{runId:options.runId,concurrency:1,recoverInterrupted:'replay-safe'});
  const head=(await database.readPage({limit:1})).through,record=inspectManagedEffect(database,state.manifest.association)?.record,evidence=verifyReport(state.manifest,record?.intentId);
  return {format:1,runId:options.runId,status:checkpoint.status==='completed'&&evidence.kind!=='applied'?'needs-owner':checkpoint.status,historicalStatus:checkpoint.status,reportEvidence:evidence,reportPath:state.manifest.reportPath,effectCount:observedReportCount(state.manifest),modelLaunches:0,decisionId:state.manifest.decisionId,...(record?.intentId?{intentId:record.intentId}:{}),sourceHead:head};
 } finally {database.close();}
}
