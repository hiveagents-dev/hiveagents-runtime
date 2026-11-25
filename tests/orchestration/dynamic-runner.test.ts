import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { ProviderUnavailableError, UsageLimitError } from '../../src/public/errors.js';
import { DynamicRunnerError, agentRunner } from '../../src/orchestration/dynamic/agent-runner.js';
import type { DynamicAgentRequest } from '../../src/orchestration/dynamic/types.js';
import { RecordingExec, SCOPE, memoryOf, recordingProvider, success } from '../unit/memory.fixture.js';

function runtimeAnswering(answer: (request: ExecTurnRequest) => Promise<ProtocolResult> | ProtocolResult = request => success(request.sessionId ?? 's1')) {
  const exec = new RecordingExec();
  exec.executeImpl = async request => answer(request);
  return { exec, runtime: new Runtime({ adapters: [exec] }) };
}

function request(options: Partial<DynamicAgentRequest['options']> = {}, extra: Partial<DynamicAgentRequest> = {}): DynamicAgentRequest {
  return {
    runId: 'run-1', key: 'k1', prompt: 'Review the file.',
    options: { permissions: 'analyze', ...options },
    signal: new AbortController().signal,
    ...extra,
  };
}

async function permissionArgsOf(mode: 'analyze' | 'edit'): Promise<string[]> {
  const { exec, runtime } = runtimeAnswering();
  const agent = new Agent({ model: 'opus-5', permissions: { mode } }, runtime);
  await agent.send('probe');
  await agent.close();
  return exec.requests[0]!.permissionArgs;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DynamicRunnerError);
  return (error as DynamicRunnerError).code;
}

describe('agentRunner', () => {
  it('runs one turn and returns its text and usage', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, costMeaning: 'provider-reported' as const };
    const { exec, runtime } = runtimeAnswering(() => success('s1', { text: 'looks fine', usage }));
    const runner = agentRunner({ agent: { model: 'opus-5' }, runtime });

    const result = await runner.run(request());

    expect(result).toEqual({ text: 'looks fine', usage });
    expect(exec.requests).toHaveLength(1);
    expect(exec.requests[0]!.prompt).toContain('Review the file.');
    expect(exec.requests[0]!.outputSchema).toBeUndefined();
  });

  it('maps analyze and edit to the Agent permissions, keeping every other base permission field', async () => {
    const analyze = await permissionArgsOf('analyze');
    const edit = await permissionArgsOf('edit');
    expect(analyze).not.toEqual(edit);
    const { exec, runtime } = runtimeAnswering();
    // The base asks analyze with extra directories and network: only the mode is chosen per call.
    const directories = [tmpdir()];
    const runner = agentRunner({
      agent: { model: 'opus-5', permissions: { mode: 'analyze', network: 'allow', additionalDirectories: directories } },
      runtime, ceiling: 'edit',
    });
    directories.push('/changed/after/build');

    await runner.run(request({ permissions: 'edit' }));
    await runner.run(request({ permissions: 'analyze' }));

    const addDir = ['--add-dir', await import('node:fs/promises').then(fs => fs.realpath(tmpdir()))];
    const stripped = (args: string[]) => args.filter((arg, index) => arg !== '--add-dir' && args[index - 1] !== '--add-dir');
    expect(stripped(exec.requests[0]!.permissionArgs)).toEqual(edit);
    expect(stripped(exec.requests[1]!.permissionArgs)).toEqual(analyze);
    for (const sent of exec.requests) {
      expect(sent.permissionArgs.join(' ')).toContain(addDir.join(' '));
      expect(sent.permissionArgs.join(' ')).not.toContain('/changed/after/build');
    }
  });

  it('refuses permissions above the ceiling, at build time and per call', async () => {
    const { exec, runtime } = runtimeAnswering();
    expect(() => agentRunner({ agent: { model: 'opus-5', permissions: { mode: 'unrestricted' } }, runtime, ceiling: 'edit' })).toThrow(TypeError);
    expect(() => agentRunner({ agent: { model: 'opus-5', permissions: { mode: 'edit' } }, runtime })).toThrow(TypeError);
    expect(() => agentRunner({ agent: { model: 'opus-5', permissions: { mode: 'edit' } }, runtime, ceiling: 'edit' })).not.toThrow();
    expect(() => agentRunner({ agent: { model: 'opus-5' }, runtime, ceiling: 'unrestricted' as never })).toThrow(TypeError);

    const runner = agentRunner({ agent: { model: 'opus-5' }, runtime });
    expect(await codeOf(runner.run(request({ permissions: 'edit' })))).toBe('PERMISSION_DENIED');
    expect(await codeOf(runner.run(request({ permissions: 'unrestricted' as never })))).toBe('PERMISSION_DENIED');
    expect(exec.requests).toEqual([]);
  });

  it('allows only the base model and the listed ones', async () => {
    const { exec, runtime } = runtimeAnswering();
    const strict = agentRunner({ agent: { model: 'opus-5' }, runtime });
    expect(await codeOf(strict.run(request({ model: 'sonnet-5' })))).toBe('MODEL_NOT_ALLOWED');
    await strict.run(request({ model: 'opus-5' }));

    const listed = agentRunner({ agent: { model: 'opus-5' }, runtime, models: ['sonnet-5'] });
    await listed.run(request({ model: 'sonnet-5' }));
    expect(await codeOf(listed.run(request({ model: 'haiku-5' })))).toBe('MODEL_NOT_ALLOWED');

    expect(exec.requests.map(sent => sent.modelId)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('runs in the call cwd when isolated, else the base cwd', async () => {
    const { exec, runtime } = runtimeAnswering();
    const base = await import('node:fs/promises').then(fs => fs.realpath(tmpdir()));
    const own = process.cwd();
    const runner = agentRunner({ agent: { model: 'opus-5', cwd: base }, runtime });

    await runner.run(request());
    await runner.run(request({}, { cwd: own }));

    expect(exec.requests[0]!.cwd).toBe(base);
    expect(exec.requests[1]!.cwd).toBe(await import('node:fs/promises').then(fs => fs.realpath(own)));
    expect(await codeOf(runner.run(request({}, { cwd: 'relative/dir' })))).toBe('INVALID_REQUEST');
  });

  it('passes the schema as outputSchema and returns the structured output', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const { exec, runtime } = runtimeAnswering(() => success('s1', { text: '{"ok":true}', output: { ok: true } }));
    const runner = agentRunner({ agent: { model: 'opus-5' }, runtime });

    const result = await runner.run(request({ schema }));

    expect(exec.requests[0]!.outputSchema).toEqual(schema);
    expect(result.output).toEqual({ ok: true });
    expect(result.text).toBe('{"ok":true}');
  });

  it('passes effort and refuses one that could read as a CLI option', async () => {
    const { exec, runtime } = runtimeAnswering();
    const runner = agentRunner({ agent: { model: 'opus-5', effort: 'low' }, runtime });
    await runner.run(request());
    await runner.run(request({ effort: 'high' }));
    expect(exec.requests.map(sent => sent.effort)).toEqual(['low', 'high']);
    expect(await codeOf(runner.run(request({ effort: '--dangerously-skip-permissions' })))).toBe('INVALID_REQUEST');
    expect(() => agentRunner({ agent: { model: 'opus-5', effort: '-x' }, runtime })).toThrow(TypeError);
  });

  it('maps a timeout and an abort to TIMEOUT and ABORTED', async () => {
    const hang = (sent: ExecTurnRequest) => new Promise<ProtocolResult>((_resolve, reject) => {
      sent.signal?.addEventListener('abort', () => reject(sent.signal!.reason), { once: true });
    });
    const { runtime } = runtimeAnswering(hang);
    const runner = agentRunner({ agent: { model: 'opus-5' }, runtime });

    expect(await codeOf(runner.run(request({ timeoutMs: 30 })))).toBe('TIMEOUT');

    const controller = new AbortController();
    const running = runner.run(request({}, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await codeOf(running)).toBe('ABORTED');

    const aborted = new AbortController();
    aborted.abort();
    expect(await codeOf(runner.run(request({}, { signal: aborted.signal })))).toBe('ABORTED');
    expect(await codeOf(runner.run(request({ timeoutMs: 0 })))).toBe('INVALID_REQUEST');
  });

  it('maps a refusal and provider failures without provider text', async () => {
    const refused = runtimeAnswering(() => success('s1', { completed: false, refused: true, text: 'I will not' }));
    expect(await codeOf(agentRunner({ agent: { model: 'opus-5' }, runtime: refused.runtime }).run(request()))).toBe('REFUSED');

    const secret = 'provider says: token sk-123 rejected';
    const failing = runtimeAnswering(() => { throw new ProviderUnavailableError({ retryable: true }, secret); });
    const error = await agentRunner({ agent: { model: 'opus-5' }, runtime: failing.runtime }).run(request()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DynamicRunnerError);
    expect((error as DynamicRunnerError).code).toBe('PROVIDER_FAILED');
    expect((error as DynamicRunnerError).runtimeCode).toBe('PROVIDER_UNAVAILABLE');
    expect((error as Error).message).not.toContain('sk-123');
    expect(JSON.stringify(error)).not.toContain('sk-123');

    const unknown = runtimeAnswering();
    expect(await codeOf(agentRunner({ agent: { model: 'opus-5' }, runtime: unknown.runtime, models: ['nope/model'] })
      .run(request({ model: 'nope/model' })))).toBe('UNSUPPORTED');
  });

  it('maps the SDK usage limit to RATE_LIMITED with the confirmed reset, never from provider text', async () => {
    const retryAt = Date.now() + 60_000;
    const limit = (failure: object) => runtimeAnswering(() => {
      throw new UsageLimitError({ retryable: false, provider: 'claude', failure: failure as never }, 'provider prose sk-123');
    });
    const withReset = await agentRunner({ agent: { model: 'opus-5' }, runtime: limit({ kind: 'usage-limit', retryAt }).runtime })
      .run(request()).catch((failure: unknown) => failure) as DynamicRunnerError;
    expect(withReset).toBeInstanceOf(DynamicRunnerError);
    expect([withReset.code, withReset.runtimeCode, withReset.retryAt]).toEqual(['RATE_LIMITED', 'USAGE_LIMIT', retryAt]);
    expect(withReset.message).not.toContain('sk-123');
    const noReset = await agentRunner({ agent: { model: 'opus-5' }, runtime: limit({ kind: 'usage-limit' }).runtime })
      .run(request()).catch((failure: unknown) => failure) as DynamicRunnerError;
    expect([noReset.code, noReset.retryAt]).toEqual(['RATE_LIMITED', undefined]);
    // A throttle the SDK did not classify as a usage limit stays a provider failure.
    const throttled = runtimeAnswering(() => { throw new ProviderUnavailableError({ retryable: true }, 'rate limit 429'); });
    expect(await codeOf(agentRunner({ agent: { model: 'opus-5' }, runtime: throttled.runtime }).run(request()))).toBe('PROVIDER_FAILED');
  });

  it('closes every Agent, also when the turn throws', async () => {
    const closed: number[] = [];
    const original = Agent.prototype.close;
    Agent.prototype.close = async function (this: Agent) { closed.push(1); return original.call(this); };
    try {
      const ok = runtimeAnswering();
      await agentRunner({ agent: { model: 'opus-5' }, runtime: ok.runtime }).run(request());
      const failing = runtimeAnswering(() => { throw new Error('boom'); });
      await expect(agentRunner({ agent: { model: 'opus-5' }, runtime: failing.runtime }).run(request())).rejects.toBeInstanceOf(DynamicRunnerError);
      expect(closed).toHaveLength(2);
      await agentRunner({ agent: { model: 'opus-5' }, runtime: ok.runtime, closeAgents: false }).run(request());
      expect(closed).toHaveLength(2);
    } finally {
      Agent.prototype.close = original;
    }
  });

  it('opts the Agent out of memory unless the base sets memory', async () => {
    const provider = recordingProvider();
    const runtime = new Runtime({ adapters: [new RecordingExec()], memory: { provider, scope: () => SCOPE } });
    await agentRunner({ agent: { model: 'opus-5' }, runtime }).run(request());
    expect(provider.recalls).toHaveLength(0);
    // The same Runtime does recall into an Agent that does not opt out, and into a runner whose base sets memory.
    const plain = new Agent({ model: 'opus-5' }, runtime);
    await plain.send('probe');
    await plain.close();
    expect(provider.recalls).toHaveLength(1);
    await agentRunner({ agent: { model: 'opus-5', memory: memoryOf(provider) }, runtime }).run(request());
    expect(provider.recalls).toHaveLength(2);
  });

  it('keeps the runtime out of the module graph: Agent is loaded on the first call only', () => {
    // A static (value) import graph; dynamic `import()` and `import type` do not count.
    const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'|^import\s+'(\.[^']+)'/gm)) {
        const target = resolve(dirname(file), (match[1] ?? match[2])!.replace(/\.js$/, '.ts'));
        walk(existsSync(target) ? target : target.replace(/\.ts$/, '/index.ts'));
      }
    };
    walk(resolve(source, 'orchestration/dynamic/agent-runner.ts'));
    walk(resolve(source, 'orchestration/dynamic/isolation.ts'));
    expect(seen.has(resolve(source, 'public/agent.ts'))).toBe(false);
    expect([...seen].some(file => file.includes(`${resolve(source, 'orchestration/memory')}`))).toBe(false);
    expect(readFileSync(resolve(source, 'orchestration/dynamic/agent-runner.ts'), 'utf8')).toContain("await import('../../public/agent.js')");
  });
});
