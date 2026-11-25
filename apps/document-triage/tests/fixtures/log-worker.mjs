import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { isExecutionHalted, ExecutionHaltedError } from 'hiveagents-runtime';
import { LogDecisionStore, LogExecutionDatabase } from 'hiveagents-runtime/orchestration/log';
import { DecisionRunner, WorkflowRunner } from 'hiveagents-runtime/orchestration';
import { openLoggedState } from '../../dist/logged-storage.js';
import { runLoggedDocuments, loggedDefinition, loggedDecisionOptions } from '../../dist/logged-workflow.js';
import { reconcileLoggedDocuments } from '../../dist/logged-reconciliation.js';
import { handoffLoggedDocuments } from '../../dist/logged-handoff.js';
const [directory,mode]=process.argv.slice(2),options={stateDirectory:directory,runId:'crash-proof',documents:[{id:'vpn',text:'VPN private fixture document'}]};
try {
 let result;
 if(mode==='reconcile')result=await reconcileLoggedDocuments(options);
 else if(mode==='handoff')result=await handoffLoggedDocuments(options);
 else if(mode==='new-id'||mode==='rearm'){
  const state=openLoggedState(options),database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:'document-triage'});
  try{const store=new LogDecisionStore({database,association:state.manifest.association});
   if(mode==='new-id')result=await new DecisionRunner(store).run({...loggedDecisionOptions(state),id:'new-decision-to-evade-original'});
   else{const definition=loggedDefinition(state,store);result=await new WorkflowRunner(new (await import('hiveagents-runtime/orchestration/log')).LogWorkflowStore({database,identity:state.manifest.identity,definition})).rearm(definition,{runId:options.runId,steps:'incomplete',acknowledgement:{workStopped:true}});}
  }finally{database.close();}
 }else result=await runLoggedDocuments({...options,hooks:{
  beforeReportWrite(){const fd=openSync(join(directory,'execute-count'),'a',0o600);try{writeSync(fd,'execute\n');fsyncSync(fd);}finally{closeSync(fd);}},
  afterReportWrite(){if(mode==='effect')process.kill(process.pid,'SIGKILL');},
  afterDecisionSave(record){if(record.status===mode||mode==='ackloss'&&record.status==='verified'){
   if(mode==='ackloss')throw new ExecutionHaltedError();process.kill(process.pid,'SIGKILL');}},
 }});
 console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify({blocked:true,halted:isExecutionHalted(error)}));}
