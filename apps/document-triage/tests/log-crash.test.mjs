import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogExecutionDatabase } from 'hiveagents-runtime/orchestration/log';
import { openLoggedState } from '../dist/logged-storage.js';
import { inspectLoggedDocuments } from '../dist/logged-inspection.js';
const worker=fileURLToPath(new URL('./fixtures/log-worker.mjs',import.meta.url));
async function child(directory,mode){return await new Promise((resolve,reject)=>{
 const processChild=spawn(process.execPath,[worker,directory,mode],{stdio:['ignore','pipe','pipe']});let output='';
 const timer=setTimeout(()=>processChild.kill('SIGKILL'),15000);
 processChild.stdout.on('data',bytes=>{output+=String(bytes);if(output.length>65536)processChild.kill('SIGKILL');});processChild.stderr.resume();
 processChild.once('error',error=>{clearTimeout(timer);reject(error);});processChild.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,value:output?JSON.parse(output):undefined});});
});}
function acknowledgeObservedExit(directory){
 const state=openLoggedState({stateDirectory:directory,runId:'crash-proof'}),database=new LogExecutionDatabase({databasePath:state.databasePath,systemId:'document-triage'});
 try{for(const kind of ['decision','workflow']){const owner=database.inspectOwnership(kind,state.manifest.identity);if(owner)database.recoverAbandoned(owner,{ownerStopped:true});}}
 finally{database.close();}
}
async function effects(directory){try{return (await readFile(join(directory,'execute-count'),'utf8')).trim().split('\n').length;}catch(error){if(error.code==='ENOENT')return 0;throw error;}}
for(const mode of ['intent','effect','dispatched','verified','ackloss'])test(`real child ${mode}: original evidence, UNKNOWN blocking and exactly zero/one report dispatch`,{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'triage-log-crash-'));
 try{
  const crashed=await child(directory,mode);if(mode==='ackloss'){assert.equal(crashed.value.halted,true);}else assert.equal(crashed.signal,'SIGKILL');
  let observed=await inspectLoggedDocuments({stateDirectory:directory,runId:'crash-proof'});const originalIntent=observed.intentId;
  assert.equal(await effects(directory),mode==='intent'?0:1);
  const denied=await child(directory,'resume');if(mode!=='ackloss')assert.equal(denied.value.blocked,true);
  // This parent owns this exact child and observed its close. Standalone acknowledgement only, never Host proof.
  acknowledgeObservedExit(directory);
  const resumed=await child(directory,'resume');
  if(mode==='intent'||mode==='effect'){
   assert.equal(resumed.value.blocked,true);acknowledgeObservedExit(directory);
   for(const operation of ['new-id','rearm','handoff']){const blocked=await child(directory,operation);assert.equal(blocked.value.blocked,true);acknowledgeObservedExit(directory);}
   const result=await child(directory,'reconcile');
   assert.equal(result.value.status,mode==='effect'?'verified':'needs-owner');
   if(mode==='effect'){const completed=await child(directory,'resume');assert.equal(completed.value.status,'completed');}
  }else assert.equal(resumed.value.status,'completed');
  observed=await inspectLoggedDocuments({stateDirectory:directory,runId:'crash-proof'});assert.equal(observed.intentId,originalIntent);
  assert.equal(observed.status,mode==='intent'?'needs-owner':'verified');assert.equal(await effects(directory),mode==='intent'?0:1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('a changed original report target cannot produce a positive reconciliation',{timeout:45000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'triage-log-target-'));
 try{assert.equal((await child(directory,'effect')).signal,'SIGKILL');acknowledgeObservedExit(directory);
  const state=openLoggedState({stateDirectory:directory,runId:'crash-proof'});await writeFile(state.manifest.reportPath,JSON.stringify({intentId:'different',payload:state.manifest.payload}),{mode:0o600});
  assert.equal((await child(directory,'reconcile')).value.status,'intent');assert.equal((await child(directory,'resume')).value.blocked,true);assert.equal(await effects(directory),1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
