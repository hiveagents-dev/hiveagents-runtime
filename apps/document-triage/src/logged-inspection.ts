import { LogExecutionDatabase, inspectManagedEffect, createLogTraceProjector, createLogAuditProjector } from 'hiveagents-runtime/orchestration/log';
import { openLoggedState } from './logged-storage.js';
import type { LoggedOptions } from './logged-storage.js';
import { verifyReport, observedReportCount } from './logged-report.js';
export async function inspectLoggedDocuments(options:LoggedOptions) {
 const state=openLoggedState(options),database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:state.manifest.identity.systemId});
 try {const sourceHead=(await database.readPage({limit:1})).through,effect=inspectManagedEffect(database,state.manifest.association),historicalStatus=effect?.metadata?.status??'not-started',evidence=verifyReport(state.manifest,effect?.record?.intentId),status=historicalStatus==='verified'&&evidence.kind!=='applied'?'needs-owner':historicalStatus;
  return {format:1,runId:options.runId,status,historicalStatus,sourceId:database.sourceId,sourceHead,
   decisionId:state.manifest.decisionId,...(effect?.record?.intentId?{intentId:effect.record.intentId}:{}),
   unresolvedEffects:['intent','dispatched','needs-owner'].includes(status)?[state.manifest.decisionId]:[],
   reportPath:state.manifest.reportPath,effectCount:observedReportCount(state.manifest),reportEvidence:evidence,modelLaunches:0};
 }finally{database.close();}
}
export async function rebuildLoggedDocuments(options:LoggedOptions) {
 const state=openLoggedState(options),database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:state.manifest.identity.systemId});
 try {const config={reader:database,identity:state.manifest.identity,maxPages:128,maxEntries:8192};
  const trace=await createLogTraceProjector(config).rebuild({limit:64}),audit=await createLogAuditProjector(config).rebuild({limit:64});
  if(JSON.stringify(trace.through)!==JSON.stringify(audit.through))throw Error('Log changed during reconstruction');
  return {format:1,runId:options.runId,trace,audit,modelLaunches:0};
 }finally{database.close();}
}
