import { describe, expect, it } from 'vitest';

import { CodexDynamicToolHost, type CodexDynamicToolDefinition } from '../../src/adapters/codex-control/dynamic-tools.js';

function tool(overrides: Partial<CodexDynamicToolDefinition> = {}): CodexDynamicToolDefinition {
  return {
    name: 'echo',
    description: 'echoes input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    handler: async (input) => input,
    ...overrides,
  };
}

const signal = new AbortController().signal;

describe('CodexDynamicToolHost', () => {
  it('is gated behind experimentalApi', () => {
    expect(() => new CodexDynamicToolHost({ experimentalApi: false, tools: [tool()] }))
      .toThrowError(/experimentalApi/);
    expect(new CodexDynamicToolHost({ experimentalApi: false, tools: [] }).size).toBe(0);
  });

  it('validates input against the tool schema before running the handler', async () => {
    let ran = false;
    const host = new CodexDynamicToolHost({
      experimentalApi: true,
      tools: [tool({ handler: async () => { ran = true; return {}; } })],
    });
    await expect(host.call('echo', { text: 42 }, { signal })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(ran).toBe(false);
    await expect(host.call('echo', { text: 'ok' }, { signal })).resolves.toEqual({});
  });

  it('enforces timeoutMs with a typed timeout', async () => {
    const host = new CodexDynamicToolHost({
      experimentalApi: true,
      tools: [tool({ timeoutMs: 20, handler: () => new Promise(() => undefined) })],
    });
    await expect(host.call('echo', { text: 'slow' }, { signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('caps output bytes', async () => {
    const host = new CodexDynamicToolHost({
      experimentalApi: true,
      tools: [tool({ maxOutputBytes: 16, handler: async () => ({ blob: 'x'.repeat(64) }) })],
    });
    await expect(host.call('echo', { text: 'big' }, { signal })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  it('honors an already-aborted signal without running the handler', async () => {
    let ran = false;
    const host = new CodexDynamicToolHost({
      experimentalApi: true,
      tools: [tool({ handler: async () => { ran = true; return {}; } })],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(host.call('echo', { text: 'x' }, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' });
    expect(ran).toBe(false);
  });

  it('hashes the registry deterministically and independent of registration order', () => {
    const a = tool();
    const b = tool({ name: 'other', description: 'other tool' });
    const first = new CodexDynamicToolHost({ experimentalApi: true, tools: [a, b] });
    const second = new CodexDynamicToolHost({ experimentalApi: true, tools: [b, a] });
    expect(first.registryHash()).toBe(second.registryHash());

    const changed = new CodexDynamicToolHost({
      experimentalApi: true,
      tools: [a, tool({ name: 'other', description: 'other tool', timeoutMs: 5 })],
    });
    expect(changed.registryHash()).not.toBe(first.registryHash());
  });

  it('rejects duplicate tool names', () => {
    expect(() => new CodexDynamicToolHost({ experimentalApi: true, tools: [tool(), tool()] }))
      .toThrowError(/Duplicate/);
  });

  it('exposes wire declarations without handlers or limits', () => {
    const host = new CodexDynamicToolHost({ experimentalApi: true, tools: [tool()] });
    expect(host.wireDeclarations()).toEqual([{
      name: 'echo',
      description: 'echoes input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }]);
  });
});

it('aborts the derived handler signal at timeout and cleans the parent listener', async () => {
  const controller=new AbortController();
  const {vi}=await import('vitest');const remove=vi.spyOn(controller.signal,'removeEventListener');
  let observed: AbortSignal | undefined;
  const host=new CodexDynamicToolHost({experimentalApi:true,tools:[tool({timeoutMs:15,handler:async(_input,context)=>{observed=context.signal;return new Promise(()=>{});}})]});
  await expect(host.call('echo',{text:'x'},{signal:controller.signal})).rejects.toMatchObject({code:'TIMEOUT'});
  expect(observed).not.toBe(controller.signal);expect(observed?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
});
it('rejects invalid dynamic tool bounds before accepting calls', () => {
  for(const timeoutMs of [0,1.2,NaN,2**31]) expect(()=>new CodexDynamicToolHost({experimentalApi:true,tools:[tool({timeoutMs})]})).toThrow();
  for(const maxOutputBytes of [0,1.2,NaN]) expect(()=>new CodexDynamicToolHost({experimentalApi:true,tools:[tool({maxOutputBytes})]})).toThrow();
});
it('snapshots metadata and handler authority at registration', async () => {
  const definition=tool();const host=new CodexDynamicToolHost({experimentalApi:true,tools:[definition]});
  definition.handler=async()=>{throw new Error('mutated');};definition.maxOutputBytes=1;
  await expect(host.call('echo',{text:'ok'},{signal})).resolves.toEqual({text:'ok'});
});
it('tracks work that ignores cancellation until its actual settlement', async () => {
  let finish!: (value: unknown)=>void;
  const host=new CodexDynamicToolHost({experimentalApi:true,tools:[tool({timeoutMs:10,handler:()=>new Promise((resolve)=>{finish=resolve;})})]});
  await expect(host.call('echo',{text:'x'},{signal,scope:{provider:'codex',transport:'control',cwd:process.cwd(),sessionId:'one',authorityEpoch:'epoch'}})).rejects.toMatchObject({code:'TIMEOUT'});
  expect(host.hasPending('one')).toBe(true);expect(host.hasPending('two')).toBe(false);
  finish(null);await new Promise((resolve)=>setTimeout(resolve,0));expect(host.hasPending('one')).toBe(false);
});
