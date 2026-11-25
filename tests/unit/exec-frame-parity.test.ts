import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { ExecTurnRequest, ProcessRunner } from '../../src/adapters/provider.js';

const LIMIT = 1024 * 1024;
const fixture = fileURLToPath(new URL('../fixtures/process/oversize-frame-idle.mjs', import.meta.url));
const providers = [{ provider: 'claude', Adapter: ClaudeExecAdapter }, { provider: 'codex', Adapter: CodexExecAdapter }] as const;
const modes = ['execute', 'stream'] as const;
const request = (): ExecTurnRequest => ({ mode: 'open', modelId: 'fixture', cwd: process.cwd(), prompt: 'fixture',
  env: {}, contextArgs: [], permissionArgs: [], timeoutMs: 2_000, maxOutputBytes: 4 * 1024 * 1024, awaitSettlement: true });
function frame(provider: 'claude' | 'codex', bytes: number, unicode = false) {
  const value = provider === 'claude'
    ? { type: 'result', subtype: 'success', is_error: false, session_id: 'native', result: 'done', padding: '' }
    : { type: 'turn.completed', padding: '' };
  const padding = bytes - Buffer.byteLength(JSON.stringify(value));
  value.padding = unicode ? 'é'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2) : 'x'.repeat(padding);
  const raw = JSON.stringify(value); expect(Buffer.byteLength(raw)).toBe(bytes); return raw;
}
async function run(adapter: ClaudeExecAdapter | CodexExecAdapter, mode: typeof modes[number], value: ExecTurnRequest) {
  if (mode === 'execute') return adapter.execute(value);
  let result;
  for await (const item of adapter.stream(value)) if (item.kind === 'result') result = item.result;
  return result;
}

describe.each(providers)('$provider JSONL frame parity', ({ provider, Adapter }) => {
  for (const mode of modes) {
    it.each([
      { bytes: LIMIT, delimiter: '\n', split: false, unicode: false, valid: true },
      { bytes: LIMIT, delimiter: '', split: false, unicode: false, valid: true },
      { bytes: LIMIT, delimiter: '\r\n', split: true, unicode: true, valid: true },
      { bytes: LIMIT + 1, delimiter: '\n', split: false, unicode: false, valid: false },
      { bytes: LIMIT + 1, delimiter: '', split: true, unicode: true, valid: false },
      { bytes: LIMIT + 1, delimiter: '\r\n', split: true, unicode: false, valid: false },
      { bytes: LIMIT, delimiter: '\r', split: false, unicode: false, valid: false },
    ])(`${mode} enforces byte boundaries ($bytes/$delimiter/split=$split/unicode=$unicode)`, async testCase => {
      const raw = frame(provider, testCase.bytes, testCase.unicode) + testCase.delimiter;
      const bytes = Buffer.from(raw);
      const unicodeCut = bytes.indexOf(0xc3) + 1;
      const chunks = testCase.split
        ? [bytes.subarray(0, testCase.unicode ? unicodeCut : Math.floor(bytes.length / 2)),
          bytes.subarray(testCase.unicode ? unicodeCut : Math.floor(bytes.length / 2), bytes.length - 1), bytes.subarray(bytes.length - 1)]
        : [bytes];
      const runner: ProcessRunner = async value => {
        for (const chunk of chunks) {
          if (value.onStdoutAsync) await value.onStdoutAsync(chunk, value.signal!);
          else value.onStdout?.(chunk);
        }
        return { code: 0, signal: null, stdout: raw, stderr: '', durationMs: 1 };
      };
      const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner });
      const result = run(adapter, mode, request());
      if (testCase.valid) await expect(result).resolves.toMatchObject({ completed: true });
      else await expect(result).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', context: { retryable: false, sanitizedDiagnostics: { maxFrameBytes: LIMIT } } });
    });

    it(`${mode} kills an oversized unterminated native frame before the idle process deadline`, async () => {
      const abort = new AbortController(); let timer: NodeJS.Timeout | undefined;
      const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [fixture, provider] } });
      const running = run(adapter, mode, { ...request(), signal: abort.signal }).then(value => ({ value }), error => ({ error }));
      try {
        const result = await Promise.race([running, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('incremental frame guard did not terminate idle fixture')), 1_500);
        })]);
        expect(result).toMatchObject({ error: { code: 'OUTPUT_LIMIT' } });
      } finally { clearTimeout(timer); abort.abort(); await running; }
    });
  }

  it.each(['valid-result', 'later-runner-error'] as const)('retains the first frame failure when a custom runner swallows it (%s)', async mode => {
    let first: unknown;
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async value => {
      try { value.onStdout?.(Buffer.from(frame(provider, LIMIT + 1) + '\n')); }
      catch (error) { first = error; }
      if (mode === 'later-runner-error') throw new Error('later synthetic runner error');
      return { code: 0, signal: null, stdout: frame(provider, 256) + '\n', stderr: '', durationMs: 1 };
    } });
    await expect(adapter.execute(request())).rejects.toSatisfy(error => error === first && error.code === 'OUTPUT_LIMIT');
  });

  it('validates returned stdout when a legacy execute runner omits callbacks', async () => {
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async () =>
      ({ code: 0, signal: null, stdout: frame(provider, LIMIT + 1) + '\n', stderr: '', durationMs: 1 }) });
    await expect(adapter.execute(request())).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });
});
