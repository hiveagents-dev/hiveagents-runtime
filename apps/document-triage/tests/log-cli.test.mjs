import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink, chmod, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
async function cli(args){return await new Promise((resolve,reject)=>{let text='',errors='';const child=spawn(process.execPath,[main,...args],{env:{...process.env,OAR_CLAUDE_COMMAND:'invalid-not-absolute',OAR_CODEX_ARGS_JSON:'invalid JSON',OAR_GEMINI_COMMAND:'invalid-not-absolute'},stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',value=>{text+=String(value);if(text.length>1024*1024)child.kill('SIGKILL');});child.stderr.on('data',value=>{errors+=String(value);});child.on('error',reject);child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,text,errors,value:text?JSON.parse(text):undefined});});});}
test('public log CLI runs before provider discovery and preserves private text across projections',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'triage-log-cli-'));
 try{const input=join(root,'input.json'),state=join(root,'state');await writeFile(input,JSON.stringify([{id:'first',text:'VPN CLI_PRIVATE_CANARY'}]),{mode:0o600});
  const args=['--state-dir',state,'--run-id','cli-run'];const first=await cli(['log-run','--input',input,...args]);assert.equal(first.code,0);assert.equal(first.value.status,'completed');assert.equal(first.value.modelLaunches,0);
  const again=await cli(['log-run','--input',input,...args]);assert.equal(again.value.intentId,first.value.intentId);assert.equal(again.value.effectCount,1);
  const inspect=await cli(['log-inspect',...args]);assert.equal(inspect.value.status,'verified');
  const rebuilt=await cli(['log-rebuild',...args]);assert.deepEqual(rebuilt.value.trace.through,rebuilt.value.audit.through);assert.equal(rebuilt.text.includes('CLI_PRIVATE_CANARY'),false);assert.equal(rebuilt.errors.includes('CLI_PRIVATE_CANARY'),false);
  await unlink(first.value.reportPath);
  for(const command of ['log-run','log-inspect','log-reconcile']){const result=await cli([command,...(command==='log-run'?['--input',input]:[]),...args]);assert.equal(result.value.status,'needs-owner');assert.equal(result.value.reportEvidence.kind,'absent');assert.equal(result.value.intentId,first.value.intentId);}
  assert.equal((await cli(['log-handoff',...args])).value.status,'owner-required');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('private state symlink and broad permissions are refused without exposing inputs',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'triage-log-path-'));
 try{const input=join(root,'input.json'),link=join(root,'link');await writeFile(input,JSON.stringify([{id:'x',text:'SECRET_INVALID_PATH'}]),{mode:0o600});await symlink(root,link);
  const denied=await cli(['log-run','--input',input,'--state-dir',link,'--run-id','invalid']);assert.equal(denied.value.status,'owner-required');assert.equal(denied.text.includes('SECRET_INVALID_PATH'),false);
  await chmod(root,0o755);const broad=await cli(['log-run','--input',input,'--state-dir',root,'--run-id','invalid']);assert.equal(broad.value.status,'owner-required');
 }finally{await chmod(root,0o700);await rm(root,{recursive:true,force:true});}
});
