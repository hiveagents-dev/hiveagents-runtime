import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import type {ExecTurnRequest,ProcessRunner} from "../../../src/index.js";
import {ExecutionHaltedError} from "../../../src/index.js";
import {createGeminiCliProvider} from '../../../src/adapters/gemini/registration.js';
import {ANALYZE_MARKER} from '../../../src/adapters/gemini/policy.js';
const directories:string[]=[];
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})});
const outcome=(stdout:string)=>({code:0,signal:null,stdout,stderr:'',durationMs:1});
const help=['--prompt','--model','--output-format','--resume','--admin-policy','--approval-mode','--extensions'].map(f=>'  '+f+'  fixture').join('\n');
const stdout=[{type:'init',session_id:'11111111-1111-4111-8111-111111111111'},{type:'message',role:'assistant',content:'fixture',delta:true},{type:'result',status:'success'}].map(v=>JSON.stringify(v)).join('\n');
async function request():Promise<ExecTurnRequest>{const cwd=await mkdtemp(join(tmpdir(),'oar-gemini-probe-'));directories.push(cwd);return{mode:'open',modelId:'gemini-test',cwd,prompt:'fixture',env:{HOME:cwd},contextArgs:[],permissionArgs:[ANALYZE_MARKER],timeoutMs:3000,maxOutputBytes:100000}}
it('keeps internal stream probes outside the turn runner, including target pinning and caller mutation',async()=>{
 const probeRunner=vi.fn<ProcessRunner>(async r=>{if(r.args.includes('--version'))return outcome('0.56.0');if(r.args.includes('--help'))return outcome(help);throw Error('generation entered probe lane')});
 const runner=vi.fn<ProcessRunner>(async r=>{if(r.args.includes('--version')||r.args.includes('--help'))throw Error('probe entered turn lane');r.onStdout?.(Buffer.from(stdout));return outcome(stdout)});
 const options:{executable:{command:string;argsPrefix:string[]};runner:ProcessRunner;probeRunner:ProcessRunner}={executable:{command:process.execPath,argsPrefix:[] as string[]},runner,probeRunner};const provider=createGeminiCliProvider(options);
 options.runner=async()=>{throw Error('mutated turn runner')};options.probeRunner=async()=>{throw Error('mutated probe runner')};
 for(const adapter of [provider.exec.adapter,provider.exec.withTarget({command:process.execPath,argsPrefix:['--pinned-fixture']})]){
  runner.mockClear();probeRunner.mockClear();expect(await adapter.execute(await request())).toMatchObject({completed:true,text:'fixture'});
  expect(probeRunner).toHaveBeenCalledTimes(2);expect(runner).toHaveBeenCalledOnce();
 }
});
it('defaults all probe and turn work to the ordinary injected runner',async()=>{
 const runner=vi.fn<ProcessRunner>(async r=>{if(r.args.includes('--version'))return outcome('0.56.0');if(r.args.includes('--help'))return outcome(help);r.onStdout?.(Buffer.from(stdout));return outcome(stdout)});
 const provider=createGeminiCliProvider({executable:{command:process.execPath,argsPrefix:[]},runner});
 expect((await provider.exec.adapter.execute(await request())).completed).toBe(true);expect(runner).toHaveBeenCalledTimes(3);
});
it('rejects an invalid explicit probe runner before discovery',()=>{expect(()=>createGeminiCliProvider({probeRunner:null} as never)).toThrow(TypeError)});

it.each([false,true])('preserves a nominal halt through internal discovery and abort=%s',async abort=>{
 const halt=new ExecutionHaltedError(),controller=new AbortController(),runner=vi.fn<ProcessRunner>(async()=>{throw Error('unexpected generation')});
 const provider=createGeminiCliProvider({executable:{command:process.execPath,argsPrefix:[]},runner,probeRunner:async()=>{if(abort)controller.abort();throw halt}});
 await expect(provider.exec.adapter.execute({...await request(),signal:controller.signal})).rejects.toBe(halt);expect(runner).not.toHaveBeenCalled();
});
