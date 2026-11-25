import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const { LiveInputAudit, assertLiveWorkspace, assertStudyReceiptBinding, isCompleteLiveStudy, prepareLiveWorkspace, neutralGitEnvironment, captureStudyContinuation, materializeLiveInputs, assertReviewedWorkspaceFailure } = await import(pathToFileURL(resolve('scripts/continuous-live-proof.mjs')).href);
const binding = { domain:'domain', studyId:'study', baseDigest:'base', definitionDigest:'definition', actions:[{key:'a'}], batches:[{id:'one',digest:'batch'}] };
const status = { status:'exhausted', domain:'domain', studyId:'study', baseDigest:'base', registeredBatches:binding.batches, admittedAttempts:98, cycles:[] };
const production = () => ({ status:'completed', invocationAttempts:1, maintenance:{status:'deferred',invocationAttempts:0} });
const complete = () => ({ failure:undefined, matrixComplete:true, matrixVerified:true, productionVerified:true, rows:98, status, pending:[], phases:[], production:[production(),production()] });
it('rejects prospective file mutation before dispatch and retains expected/observed hashes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'oar-live-input-'));
  try { const path=join(dir,'corpus.json'); await writeFile(path,'original'); const audit=new LiveInputAudit([{name:'corpus',path,bytes:'original'}]);
    await writeFile(path,'relabeled'); let calls=0;
    await expect(audit.around('child',async()=>{calls++;})).rejects.toThrow(/input/i); expect(calls).toBe(0);
    expect(audit.records.at(-1).expectedSha256).not.toBe(audit.records.at(-1).observedSha256);
  } finally {await rm(dir,{recursive:true,force:true});}
});
it('rejects mutation during a subprocess and allows only an explicit expected corpus append', async () => {
  const dir=await mkdtemp(join(tmpdir(),'oar-live-input-'));
  try {const path=join(dir,'agent.json');await writeFile(path,'first');const audit=new LiveInputAudit([{name:'agent',path,bytes:'first'}]);
    await expect(audit.around('child',()=>writeFile(path,'second'))).rejects.toThrow(/input/i);
    audit.expect('agent',path,'second'); await expect(audit.around('append',async()=>true)).resolves.toBe(true);
    expect(await readFile(path,'utf8')).toBe('second');
  }finally{await rm(dir,{recursive:true,force:true});}
});
it('rejects a checkout-contained or nonempty native workspace',async()=>{
  const root=await mkdtemp(join(tmpdir(),'oar-root-')), outside=await mkdtemp(join(tmpdir(),'oar-work-'));
  try{const inside=join(root,'work');await mkdir(inside);await expect(assertLiveWorkspace(root,inside)).rejects.toThrow(/outside/i);
    await expect(assertLiveWorkspace(root,outside)).resolves.toBe(await realpath(outside));await writeFile(join(outside,'data'),'x');await expect(assertLiveWorkspace(root,outside)).rejects.toThrow(/empty/i);
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
it('binds persisted corpus labels, batches, definition and action set',()=>{
  expect(()=>assertStudyReceiptBinding(status,binding)).not.toThrow();
  for(const mutation of [{baseDigest:'relabeled'},{registeredBatches:[{id:'one',digest:'relabeled'}]},{domain:'foreign'}]) expect(()=>assertStudyReceiptBinding({...status,...mutation},binding)).toThrow();
  const report={domain:'domain',batchId:'one',batchDigest:'batch',dataSources:{baseDigest:'base',batchDigest:'batch',definitionDigest:'wrong',actions:binding.actions}};
  expect(()=>assertStudyReceiptBinding({...status,cycles:[report]},binding)).toThrow();
});
it('refuses completion for blocked, pending or failed maintenance even after all terminals',()=>{
  expect(isCompleteLiveStudy(complete())).toBe(true);
  for(const update of [{status:{...status,status:'blocked'}},{pending:[{id:'unresolved'}]},{status:{...status,pendingAttemptIds:['unresolved']}},{production:[production(),{...production(),maintenance:{status:'failed'}}]},{production:[production(),{...production(),invocationAttempts:2}]},{phases:[{result:{pendingAttemptIds:['unresolved']}}]},{failure:{code:'CHILD_FAILED'}}]) expect(isCompleteLiveStudy({...complete(),...update})).toBe(false);
});

it('retains a null observed digest for removed or FIFO corpus while auditing other files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oar-live-damaged-'));
  try{const path=join(dir,'corpus.json'), other=join(dir,'agent.json');await writeFile(path,'original');await writeFile(other,'agent');
    const audit=new LiveInputAudit([{name:'corpus',path,bytes:'original'},{name:'agent',path:other,bytes:'agent'}]);await audit.assert('initial');
    await rm(path);await expect(audit.assert('removed')).rejects.toThrow();
    expect(audit.records.findLast((row:any)=>row.name==='corpus')).toMatchObject({phase:'removed',observedSha256:null,matched:false});
    expect(audit.records.at(-1)).toMatchObject({name:'agent',phase:'removed',matched:true});
    expect(spawnSync('mkfifo',[path]).status).toBe(0);await expect(audit.assert('fifo')).rejects.toThrow();
    expect(audit.records.findLast((row:any)=>row.name==='corpus')).toMatchObject({phase:'fifo',observedSha256:null,matched:false});
  }finally{await rm(dir,{recursive:true,force:true});}
});

it('prepares an empty child of a neutral Git parent without inheriting Git redirects',async()=>{
  expect(neutralGitEnvironment({PATH:'path',GIT_DIR:'/foreign',GIT_WORK_TREE:'/foreign',GIT_CONFIG_COUNT:'9'})).toEqual({PATH:'path'});
  const context=await prepareLiveWorkspace(process.cwd());
  try{await expect(assertLiveWorkspace(process.cwd(),context.workspace)).resolves.toBe(context.workspace);
    const result=spawnSync('git',['-C',context.workspace,'rev-parse','--show-toplevel'],{env:neutralGitEnvironment(process.env),encoding:'utf8'});
    expect(result.status).toBe(0);expect(await realpath(result.stdout.trim())).toBe(context.parent);
    expect(spawnSync('git',['-C',context.parent,'config','--local','core.hooksPath'],{encoding:'utf8'}).stdout.trim()).toBe('/dev/null');
  }finally{await rm(context.parent,{recursive:true,force:true});}
});
it('debits an explicitly stopped first-train failure and rejects altered claim, pending state or extra starts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oar-continuation-'));
  try{const path=join(dir,'old.sqlite');const database=new DatabaseSync(path);database.exec('CREATE TABLE records(kind TEXT,json TEXT);CREATE TABLE observations(json TEXT);CREATE TABLE pointers(generation INTEGER,active TEXT,previous TEXT)');
    const observation={domain:'domain',id:'obs',attemptId:'a',outcome:'failed',split:'train',quality:{state:'unknown'}};
    database.prepare('INSERT INTO observations VALUES(?)').run(JSON.stringify(observation));database.prepare('INSERT INTO records VALUES(?,?)').run('attempt',JSON.stringify({id:'a'}));
    database.prepare('INSERT INTO records VALUES(?,?)').run('snapshot',JSON.stringify({domain:'domain',through:0,rows:[]}));database.close();
    const bytes=(value:any)=>Buffer.from(JSON.stringify(value));const claim=bytes({directory:'/state'});const sha=(value:any)=>createHash('sha256').update(value).digest('hex');
    const bindings={coreSha256:'core',applicationCodeSha256:'app'};
    const prior={kind:'independent-app-real-continuous-study',completed:false,safetyEnvelope:{maxNewAdmissions:100,maxCycles:2,effectiveAlpha:.025,familyAlpha:.05,totalTimeoutMs:1800000},durationMs:8219,durableAdmissions:1,durableStarts:1,terminalObservations:1,pendingAttemptCount:0,pendingAttemptIds:[],gates:[],episodes:[],status:{status:'blocked',admittedAttempts:1,domain:'domain',pointer:{generation:0,active:null,previous:null}},claimSha256:sha(claim),stateDirectory:'/state',observations:[{observation}],...bindings};
    expect(captureStudyContinuation(bytes(prior),claim,path,bindings)).toMatchObject({priorAdmissions:1,maxNewAdmissions:99,maxAggregateAdmissions:100,maxNewDurationMs:1791781});
    for(const durationMs of [undefined,null,-1,1800000]) expect(()=>captureStudyContinuation(bytes({...prior,durationMs}),claim,path,bindings)).toThrow();
    expect(()=>captureStudyContinuation(bytes({...prior,pendingAttemptCount:1}),claim,path,bindings)).toThrow();
    expect(()=>captureStudyContinuation(bytes(prior),bytes({directory:'/changed'}),path,bindings)).toThrow();
    const extra=new DatabaseSync(path);extra.prepare('INSERT INTO records VALUES(?,?)').run('attempt',JSON.stringify({id:'b'}));extra.close();
    expect(()=>captureStudyContinuation(bytes(prior),claim,path,bindings)).toThrow();
  }finally{await rm(dir,{recursive:true,force:true});}
});

it('materializes only new files and reaches readiness without changing a preserved prior fixture',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'oar-live-materialize-'));
  try{const prior=join(dir,'prior.json'),fresh=join(dir,'new.json');await writeFile(prior,'preserved');
    const audit=await materializeLiveInputs([{name:'new',path:fresh,bytes:'fresh'}],[{name:'prior',path:prior,bytes:'preserved'}]);
    await audit.assert('ready');expect(await readFile(prior,'utf8')).toBe('preserved');expect(await readFile(fresh,'utf8')).toBe('fresh');
    expect(audit.records.every((row:any)=>row.matched)).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
it('does not authorize another unknown native failure as the reviewed workspace refusal',()=>{
  expect(typeof assertReviewedWorkspaceFailure).toBe('function');
  expect(()=>assertReviewedWorkspaceFailure(Buffer.from('{"kind":"independent-app-real-continuous-study","completed":false}'))).toThrow();
});
