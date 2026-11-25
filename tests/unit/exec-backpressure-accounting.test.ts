import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { AdapterStreamItem, ExecAdapter, ExecTurnRequest, ProcessRunner } from '../../src/adapters/provider.js';
import { AbortError, OutputLimitError, ProviderUnavailableError } from '../../src/public/errors.js';
import { runProcess } from '../../src/process/run-process.js';
import { Session } from '../../src/session/session.js';
import type { AgentEvent } from '../../src/public/types.js';

const providers = [{ provider: 'claude', Adapter: ClaudeExecAdapter }, { provider: 'codex', Adapter: CodexExecAdapter }] as const;
const fixture = fileURLToPath(new URL('../fixtures/process/exec-output.mjs', import.meta.url));
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const request = (): ExecTurnRequest => ({ mode: 'open', modelId: 'fixture', cwd: process.cwd(), prompt: 'fixture',
  env: {}, contextArgs: [], permissionArgs: [], timeoutMs: 2_000, maxOutputBytes: 1024 * 1024, awaitSettlement: true });
const outcome = () => ({ code: 0, signal: null, stdout: '', stderr: '', durationMs: 1 });
const usage = { inputTokens: 1234, outputTokens: 66, costMeaning: 'unavailable' as const };
function terminal(provider: 'claude' | 'codex') {
  return Buffer.from((provider === 'claude' ? [
    { type: 'system', subtype: 'init', session_id: 'native' },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'native', result: 'done', usage: { input_tokens: 1234, output_tokens: 66 } },
  ] : [
    { type: 'thread.started', thread_id: 'native' },
    { type: 'item.completed', item: { type: 'agent_message', id: 'final', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 1234, output_tokens: 66 } },
  ]).map(value => JSON.stringify(value)).join('\n') + '\n');
}
async function collect(stream: AsyncIterable<AdapterStreamItem>) { const result: AdapterStreamItem[] = []; for await (const item of stream) result.push(item); return result; }
function session(adapter: ExecAdapter) {
  return new Session({ adapter, model: { id: 'fixture', provider: adapter.id, aliases: [], source: 'explicit', availability: 'available' },
    cwd: process.cwd(), transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
}

describe.each(providers)('$provider stream accounting and precedence', ({ provider, Adapter }) => {
  it('retains late nominal usage after actual settlement without a late session or completion', async () => {
    const entered = deferred(), release = deferred(), abort = new AbortController(); let settled = false;
    const runner: ProcessRunner = async () => { entered.resolve(); await release.promise; throw new ProviderUnavailableError({ retryable: true, observedUsage: usage }); };
    const owner = session(new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner }));
    const events: AgentEvent[] = [];
    const running = (async () => { for await (const event of owner.stream('fixture', { signal: abort.signal, awaitSettlement: true })) events.push(event); })()
      .then(() => undefined, error => error).finally(() => { settled = true; });
    try {
      await entered.promise; abort.abort(); await immediate(); expect(settled).toBe(false);
      release.resolve(); const error = await running;
      expect(error).toBeInstanceOf(AbortError); expect(error.context.observedUsage).toEqual(usage);
      expect(owner.ref).toBeUndefined();
      expect(events.filter(event => ['message.completed', 'message.delta', 'turn.completed'].includes(event.type))).toHaveLength(0);
    } finally { release.resolve(); abort.abort(); await running; await owner.close(); }
  });

  it('retains already observed terminal usage when cancellation suppresses the buffered terminal', async () => {
    const abort = new AbortController();
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async value => {
      await value.onStdoutAsync!(terminal(provider), value.signal!); return outcome();
    } });
    const iterator = adapter.stream({ ...request(), signal: abort.signal })[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toMatchObject({ kind: 'session' });
      await immediate(); abort.abort();
      const seen: AdapterStreamItem[] = [];
      const error = await (async () => { for (;;) { const step = await iterator.next(); if (step.done) break; seen.push(step.value); } })().catch(error => error);
      expect(error).toBeInstanceOf(AbortError); expect(error.context.observedUsage).toEqual(usage);
      expect(seen.some(item => item.kind === 'result')).toBe(false);
    } finally { abort.abort(); await iterator.return?.(); }
  });

  it('fails an ignored async mode switch after synchronous valid completion', async () => {
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async value => {
      value.onStdout?.(terminal(provider));
      void value.onStdoutAsync!(Buffer.from('{"type":"extra"}\n'), value.signal!);
      return outcome();
    } });
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('keeps the native first failure when a later caller abort lands during kill grace', async () => {
    const abort = new AbortController(), failure = new OutputLimitError({ retryable: false });
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [fixture, provider, 'native-first-error'] },
      runner: value => runProcess({ ...value, killGraceMs: 20, onStderr() {
        queueMicrotask(() => abort.abort()); throw failure;
      } }),
    });
    await expect(collect(adapter.stream({ ...request(), signal: abort.signal }))).rejects.toBe(failure);
  });
});
