import { ExecutionHaltedError } from 'hiveagents-runtime';
import { createTaskHandoff, runHandoff, decisionHash } from 'hiveagents-runtime/orchestration';
import { LogDecisionStore, LogExecutionDatabase, inspectManagedEffect } from 'hiveagents-runtime/orchestration/log';
import { openLoggedState, sha } from './logged-storage.js';
import { verifyReport } from './logged-report.js';
import type { LoggedOptions } from './logged-storage.js';
export async function handoffLoggedDocuments(options:LoggedOptions) {
 const state=openLoggedState(options,false,true),manifest=state.manifest,database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:manifest.identity.systemId});
 try {const original=inspectManagedEffect(database,manifest.association);if(!original?.record)throw Error('Original report is required');
  if(original.record.status==='verified' && verifyReport(manifest,original.record.intentId).kind!=='applied')throw Error('Original report evidence is unavailable');
  const originalApplied=()=>original.record!.status==='verified'&&verifyReport(manifest,original.record!.intentId).kind==='applied';
  const sourceDigest=original.record.receipt?decisionHash({...original.record.receipt,approval:{...original.record.receipt.approval}}):manifest.payloadDigest;
  const handoffId=`handoff-${sha(options.runId)}`,decisionId=`handoff-decision-${sha(options.runId)}`,target={id:'local-reviewer',version:'1'};
  const bundle=createTaskHandoff({id:handoffId,goal:'Review classified document report',requirements:['Use original report receipt'],context:{reportPathDigest:sha(manifest.reportPath),originalIntentDigest:sha(original.record.intentId??'none')},
   source:{id:'document-triage',version:'1',digest:sourceDigest},destination:target,evidence:[],artifacts:[],pending:[],unresolvedEffects:[]});
  const decisionStore=new LogDecisionStore({database,association:{identity:manifest.identity,stepId:'handoff',effectKey:'review-handoff',operation:{id:'acknowledge-handoff',version:'1',targetDigest:sha(target.id),contentDigest:bundle.digest}}});
  const result=await runHandoff({id:decisionId,handoffId,store:{async save(){throw Error('Immutable in-process bundle');},async load(id){return id===handoffId?bundle:undefined;}},decisionStore,target,sourceDigest,authority:{id:'local-review-owner',version:'1'},
   authorize:()=>({decision:'allow',reason:'Owned local review',expiresAt:Date.now()+60000}),isCurrent:originalApplied,
   execute:()=>{if(!originalApplied())throw new ExecutionHaltedError();return {acceptedDigest:bundle.digest};},verify:result=>({verified:originalApplied()&&typeof result==='object'&&result!==null&&!Array.isArray(result)&&result.acceptedDigest===bundle.digest,evidence:[`bundle:${bundle.digest}`]})});
  return {runId:options.runId,status:result.status==='verified'&&!originalApplied()?'needs-owner':result.status,historicalStatus:result.status,decisionId,handoffId,modelLaunches:0};
 }finally{database.close();}
}
