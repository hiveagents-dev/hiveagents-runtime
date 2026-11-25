import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogDecisionStore, LogExecutionDatabase, inspectManagedEffect } from 'hiveagents-runtime/orchestration/log';
import { runLoggedDocuments } from '../dist/logged-workflow.js';
import { inspectLoggedDocuments } from '../dist/logged-inspection.js';
import { reconcileLoggedDocuments } from '../dist/logged-reconciliation.js';
import { handoffLoggedDocuments } from '../dist/logged-handoff.js';
import { openLoggedState } from '../dist/logged-storage.js';
async function fixture(body){const directory=await mkdtemp(join(tmpdir(),'triage-postcondition-'));const options={stateDirectory:directory,runId:'original',documents:[{id:'vpn',text:'VPN original private input'}]};
 try{const result=await runLoggedDocuments(options),bytes=await readFile(result.reportPath);const state=openLoggedState(options),db=new LogExecutionDatabase({databasePath:state.databasePath,systemId:'document-triage'});let original;
  try{original=inspectManagedEffect(db,state.manifest.association).record;}finally{db.close();}
  await body({options,result,state,bytes,original});
 }finally{mock.restoreAll();await rm(directory,{recursive:true,force:true});}}
for(const mutation of ['absent','corrupt'])test(`reopen ${mutation}: historical verification cannot claim a current business postcondition`,()=>fixture(async f=>{
 if(mutation==='absent')await unlink(f.result.reportPath);else await writeFile(f.result.reportPath,'{"corrupt":true}',{mode:0o600});
 const resumed=await runLoggedDocuments(f.options);assert.equal(resumed.status,'needs-owner');assert.equal(resumed.historicalStatus,'completed');assert.equal(resumed.intentId,f.original.intentId);assert.equal(resumed.reportEvidence.kind,mutation==='absent'?'absent':'mismatch');
 const inspected=await inspectLoggedDocuments(f.options);assert.equal(inspected.status,'needs-owner');assert.equal(inspected.historicalStatus,'verified');assert.deepEqual(inspected.unresolvedEffects,[f.original.id]);
 const reconciled=await reconcileLoggedDocuments(f.options);assert.equal(reconciled.status,'needs-owner');assert.equal(reconciled.historicalStatus,'verified');
 await assert.rejects(handoffLoggedDocuments(f.options));
 const db=new LogExecutionDatabase({databasePath:f.state.databasePath,systemId:'document-triage'});try{assert.deepEqual(inspectManagedEffect(db,f.state.manifest.association).record,f.original);}finally{db.close();}
 // Restoring original evidence is not dispatch: immutable original receipt and cached workflow remain valid.
 await writeFile(f.result.reportPath,f.bytes,{mode:0o600});assert.equal((await runLoggedDocuments(f.options)).status,'completed');
}));
for(const operation of ['run','inspect','reconcile'])test(`${operation} checks original target after its final asynchronous source read`,()=>fixture(async f=>{
 const read=LogExecutionDatabase.prototype.readPage;let removed=false;
 mock.method(LogExecutionDatabase.prototype,'readPage',async function(query){const page=await read.call(this,query);if(!removed){removed=true;unlinkSync(f.result.reportPath);}return page;});
 const result=await (operation==='run'?runLoggedDocuments(f.options):operation==='inspect'?inspectLoggedDocuments(f.options):reconcileLoggedDocuments(f.options));assert.equal(removed,true);assert.equal(result.status,'needs-owner');assert.equal(result.reportEvidence.kind,'absent');
}));
test('handoff checks the original report again after acquisition before acknowledging another effect',()=>fixture(async f=>{
 const acquire=LogDecisionStore.prototype.acquire;let removed=false;
 mock.method(LogDecisionStore.prototype,'acquire',async function(id){const lease=await acquire.call(this,id);if(id.startsWith('handoff-decision-')&&!removed){removed=true;unlinkSync(f.result.reportPath);}return lease;});
 let result;try{result=await handoffLoggedDocuments(f.options);}catch{}assert.equal(removed,true);assert.notEqual(result?.status,'verified');
}));
