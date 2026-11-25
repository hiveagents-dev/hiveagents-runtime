import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExecAdapter, ExecTurnRequest } from '../../src/adapters/provider.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { OperationScope } from '../../src/control/operation-scope.js';
import { SubscriptionExecAdapter } from '../../src/core/subscription-exec.js';
import { createExecutablePin, PinnedExecAdapter } from '../../src/core/registry.js';

const request: ExecTurnRequest = { mode:'open',modelId:'codex:gpt-5.4',cwd:process.cwd(),prompt:'x',env:{},contextArgs:[],permissionArgs:[],timeoutMs:30,maxOutputBytes:1024 };
function adapter(auth: ExecAdapter['auth']): ExecAdapter {
  return { id:'codex', detect:async()=>({installed:true}),auth,models:async()=>[],execute:vi.fn(async()=>({completed:true,failed:false,refused:false,text:'',events:[],nativeEvents:[]})) };
}
describe('exec operation deadlines', () => {
  it('bounds a hung auth probe, aborts its context and never launches inference later', async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (value: { authenticated:boolean; source:'subscription' })=>void;
    const inner = adapter(async (_env, context) => { signal=context?.signal; return new Promise((done)=>{resolve=done;}); });
    const result = new SubscriptionExecAdapter(inner).execute(request);
    await expect(result).rejects.toMatchObject({code:'TIMEOUT'});
    expect(signal?.aborted).toBe(true);
    resolve({authenticated:true,source:'subscription'});
    await new Promise((done)=>setTimeout(done,5));
    expect(inner.execute).not.toHaveBeenCalled();
  });
  it('bounds reprobes and does not give inference a fresh budget', async () => {
    const directory = await mkdtemp(join(tmpdir(),'oar-deadline-'));
    try {
      const path=join(directory,'cli'); await writeFile(path,'old');
      const pin=(await createExecutablePin(path))!;
      await writeFile(path,'changed');
      const inner=adapter(async()=>({authenticated:true,source:'subscription'}));
      let signal: AbortSignal | undefined;
      const pinned=new PinnedExecAdapter(inner,pin,async (_env,_previous,context)=>{signal=context?.signal;return new Promise(()=>{});});
      await expect(pinned.execute(request)).rejects.toMatchObject({code:'TIMEOUT'});
      expect(signal?.aborted).toBe(true);
      expect(inner.execute).not.toHaveBeenCalled();
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('passes only the remaining shared budget to inference', async () => {
    const inner=adapter(async()=>{await new Promise((done)=>setTimeout(done,15));return {authenticated:true,source:'subscription'};});
    await new SubscriptionExecAdapter(inner).execute({...request,timeoutMs:100});
    expect(vi.mocked(inner.execute).mock.calls[0]![0].timeoutMs).toBeLessThan(95);
    expect(vi.mocked(inner.execute).mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  });
});

for (const Adapter of [CodexExecAdapter, ClaudeExecAdapter]) {
  it(`${Adapter.name} forwards cancellation to real probe processes`, async () => {
    const { runProcess } = await import('../../src/process/run-process.js');
    let outcome: unknown;
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: ['-e', 'setInterval(()=>{},1000)', '--'] }, runner: async (request) => { try { return await runProcess(request); } catch (error) { outcome=error; throw error; } } });
    const scope=new OperationScope({timeoutMs:30});
    try { await expect(scope.race(()=>adapter.auth({},scope))).rejects.toMatchObject({code:'TIMEOUT'}); }
    finally { scope.dispose(); }
    await new Promise((resolve)=>setTimeout(resolve,1200));
    expect(outcome).toMatchObject({code: expect.stringMatching(/ABORTED|TIMEOUT/)});
  });
}
