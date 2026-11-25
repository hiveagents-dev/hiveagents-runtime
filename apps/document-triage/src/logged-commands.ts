import { readPrivateFile } from './logged-storage.js';
import { runLoggedDocuments } from './logged-workflow.js';
import { inspectLoggedDocuments, rebuildLoggedDocuments } from './logged-inspection.js';
import { handoffLoggedDocuments } from './logged-handoff.js';
import { reconcileLoggedDocuments } from './logged-reconciliation.js';
import { isExecutionHalted } from 'hiveagents-runtime';
export async function loggedCommand(command:string,values:Map<string,string>):Promise<unknown> {
 const required=(key:string)=>{const value=values.get(key);if(!value)throw Error('Missing logged command argument');return value;};
 const options={stateDirectory:required('--state-dir'),runId:required('--run-id')};
 try {
  if(command==='log-run')return await runLoggedDocuments({...options,documents:JSON.parse(readPrivateFile(required('--input'),1024*1024))});
  if(command==='log-inspect')return await inspectLoggedDocuments(options);
  if(command==='log-rebuild')return await rebuildLoggedDocuments(options);
  if(command==='log-handoff')return await handoffLoggedDocuments(options);
  return await reconcileLoggedDocuments(options);
 }catch(error){return {format:1,runId:options.runId,status:'owner-required',halted:isExecutionHalted(error),modelLaunches:0};}
}
