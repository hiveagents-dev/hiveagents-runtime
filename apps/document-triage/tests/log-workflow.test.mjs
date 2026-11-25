import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoggedDocuments } from '../dist/logged-workflow.js';
import { inspectLoggedDocuments, rebuildLoggedDocuments } from '../dist/logged-inspection.js';
import { handoffLoggedDocuments } from '../dist/logged-handoff.js';
test('independent public SDK workflow caches one owned file effect and rebuilds safe matching source heads', async () => {
 const directory=await mkdtemp(join(tmpdir(),'oar-app-log-'));
 try {
  const options={stateDirectory:directory,runId:'real-work',documents:[{id:'vpn',text:'VPN PRIVATE_CANARY_3D'},{id:'backup',text:'daily backup'}]};
  const first=await runLoggedDocuments(options), second=await runLoggedDocuments(options);
  assert.equal(first.status,'completed'); assert.equal(second.status,'completed'); assert.equal(first.intentId,second.intentId);
  assert.equal(first.modelLaunches,0); assert.equal(second.effectCount,1);
  const report=JSON.parse(await readFile(first.reportPath,'utf8')); assert.equal(report.intentId,first.intentId); assert.equal(report.payload.documents.length,2);
  assert.equal((await readdir(join(directory,'reports'))).length,1);
  const view=await inspectLoggedDocuments(options); assert.equal(view.status,'verified'); assert.deepEqual(view.unresolvedEffects,[]);
  const rebuilt=await rebuildLoggedDocuments(options); assert.deepEqual(rebuilt.trace.through,rebuilt.audit.through); assert.equal(JSON.stringify(rebuilt).includes('PRIVATE_CANARY_3D'),false);
  const handoff=await handoffLoggedDocuments(options); assert.equal(handoff.status,'verified'); assert.equal(handoff.modelLaunches,0);
  await assert.rejects(runLoggedDocuments({...options,documents:[{id:'vpn',text:'different'}]}));
 } finally {await rm(directory,{recursive:true,force:true});}
});
