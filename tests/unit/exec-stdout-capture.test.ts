import { describe, expect, it } from 'vitest';

import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { AdapterStreamItem, ExecTurnRequest, ProcessRunner } from '../../src/adapters/provider.js';
import { runProcess, type ProcessOutcome } from '../../src/process/run-process.js';

const providers = [
  { provider: 'claude', Adapter: ClaudeExecAdapter },
  { provider: 'codex', Adapter: CodexExecAdapter },
] as const;
const request = (): ExecTurnRequest => ({
  mode: 'open', modelId: 'fixture-model', cwd: process.cwd(), prompt: 'fixture', env: {},
  contextArgs: [], permissionArgs: [], timeoutMs: 5_000, maxOutputBytes: 8 * 1024 * 1024,
  awaitSettlement: true,
});
function transcript(provider: 'claude' | 'codex'): string {
  return (provider === 'claude' ? [
    { type: 'system', subtype: 'init', session_id: 'native-fixture' },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'native-fixture',
      result: 'done', usage: { input_tokens: 10, output_tokens: 2 } },
  ] : [
    { type: 'thread.started', thread_id: 'native-fixture' },
    { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
  ]).map(line => JSON.stringify(line)).join('\n');
}
async function collect(stream: AsyncIterable<AdapterStreamItem>) {
  const items: AdapterStreamItem[] = [];
  for await (const item of stream) items.push(item);
  const terminal = items.find(item => item.kind === 'result');
  if (terminal?.kind !== 'result') throw new Error('missing terminal result');
  return terminal.result;
}

describe.each(providers)('$provider streaming stdout capture', ({ provider, Adapter }) => {
  it('retains execute stdout but builds the same stream result with no retained stdout', async () => {
    const stdout = transcript(provider);
    const outcomes: ProcessOutcome[] = [];
    const adapter = new Adapter({
      target: { command: process.execPath, argsPrefix: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`, '--'] },
      runner: async value => {
        const outcome = await runProcess(value);
        outcomes.push(outcome);
        return outcome;
      },
    });
    const executed = await adapter.execute(request());
    const streamed = await collect(adapter.stream(request()));

    expect(executed).toMatchObject({ completed: true, text: 'done', sessionId: 'native-fixture' });
    expect(streamed).toEqual(executed);
    expect(outcomes.map(outcome => Buffer.byteLength(outcome.stdout))).toEqual([Buffer.byteLength(stdout), 0]);
  });

  it('keeps legacy runners that ignore async delivery and capture policy working', async () => {
    const stdout = transcript(provider);
    const runner: ProcessRunner = async value => {
      value.onStdout?.(Buffer.from(stdout));
      return { code: 0, signal: null, stdout, stderr: '', durationMs: 1 };
    };
    const adapter = new Adapter({ target: { command: provider, argsPrefix: [] }, runner });
    await expect(collect(adapter.stream(request()))).resolves.toMatchObject({
      completed: true, text: 'done', sessionId: 'native-fixture', usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it('preserves stderr-based failure classification with no retained stdout', async () => {
    const firstLine = transcript(provider).split('\n')[0]!;
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: ['-e',
      `process.stdout.write(${JSON.stringify(firstLine)}); process.stderr.write("fixture provider unavailable"); process.exitCode = 1;`, '--'] } });
    const executed = await adapter.execute(request());
    const streamed = await collect(adapter.stream(request()));
    expect(streamed.failure).toEqual(executed.failure);
    expect(streamed.failure).toMatchObject({ kind: 'provider-unavailable', message: 'fixture provider unavailable' });
  });
});
