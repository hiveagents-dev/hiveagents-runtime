import { LogDecisionStore, LogExecutionDatabase, inspectManagedEffect } from 'hiveagents-runtime/orchestration/log';
import { openLoggedState } from './logged-storage.js';
import type { LoggedOptions } from './logged-storage.js';
import { reportResult, verifyReport } from './logged-report.js';
export async function reconcileLoggedDocuments(options:LoggedOptions) {
 const state=openLoggedState(options,false,true),database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:state.manifest.identity.systemId});
 try {const original=inspectManagedEffect(database,state.manifest.association)?.record;if(!original?.intentId)throw Error('Original intent is required');
  const store=new LogDecisionStore({database,association:state.manifest.association});
  const result=await store.reconcile({id:state.manifest.decisionId,intentId:original.intentId,binding:state.manifest.binding,
   verifyApplied(context){const evidence=verifyReport(state.manifest,context.record.intentId);return {verified:evidence.kind==='applied',result:reportResult(state.manifest),evidence:evidence.digest?[`owned-file:${evidence.digest}`]:[]};}});
  const sourceHead=(await database.readPage({limit:1})).through,reportEvidence=verifyReport(state.manifest,result.intentId);
  return {format:1,runId:options.runId,status:result.status==='verified'&&reportEvidence.kind!=='applied'?'needs-owner':result.status,historicalStatus:result.status,decisionId:result.id,intentId:result.intentId,reportPath:state.manifest.reportPath,
   reportEvidence,sourceHead,modelLaunches:0};
 }finally{database.close();}
}
