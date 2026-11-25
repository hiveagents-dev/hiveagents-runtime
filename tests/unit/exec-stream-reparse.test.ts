import { describe, expect, it, vi } from 'vitest';

import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { parseClaudeJsonl } from '../../src/adapters/claude/protocol.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import { parseCodexJsonl } from '../../src/adapters/codex/protocol.js';
import type { AdapterStreamItem, ExecTurnRequest, ProcessRunner, ProtocolResult } from '../../src/adapters/provider.js';

// R12: stream() parsed every line as it arrived and then re-parsed the WHOLE
// stdout (up to 64 MB, +413 ms synchronous at 48 MB in the app's main
// process) to build the final ProtocolResult. The final result must come from
// the lines already seen, with only the terminal lines parsed again.

vi.mock('../../src/adapters/claude/protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/claude/protocol.js')>();
  return { ...actual, parseClaudeJsonl: vi.fn(actual.parseClaudeJsonl) };
});
vi.mock('../../src/adapters/codex/protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/codex/protocol.js')>();
  return { ...actual, parseCodexJsonl: vi.fn(actual.parseCodexJsonl) };
});

const LINES = 20_000;
const CHUNK = 64 * 1024;

function runnerFor(stdout: string, code = 0, stderr = ''): ProcessRunner {
  return async (request) => {
    const bytes = Buffer.from(stdout, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      request.onStdout?.(bytes.subarray(offset, offset + CHUNK));
      // One pipe 'data' event per chunk, with the event loop in between.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { code, signal: null, stdout, stderr, durationMs: 1 };
  };
}

function request(): ExecTurnRequest {
  return {
    mode: 'open',
    modelId: 'm',
    cwd: '/tmp',
    prompt: 'hi',
    env: {},
    contextArgs: [],
    permissionArgs: [],
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024 * 1024,
  };
}

async function collect(stream: AsyncIterable<AdapterStreamItem>): Promise<{ items: AdapterStreamItem[]; result: ProtocolResult }> {
  const items: AdapterStreamItem[] = [];
  let result: ProtocolResult | undefined;
  for await (const item of stream) {
    items.push(item);
    if (item.kind === 'result') result = item.result;
  }
  if (!result) throw new Error('stream ended without a result');
  return { items, result };
}

function comparable(result: ProtocolResult) {
  const { events, nativeEvents, ...rest } = result;
  return { ...rest, eventCount: events.length, nativeEventCount: nativeEvents.length };
}

function longestArgument(spy: ReturnType<typeof vi.fn>): number {
  return Math.max(0, ...spy.mock.calls.map((call) => String(call[0]).length));
}

function claudeStdout(): string {
  const lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })];
  for (let i = 0; i < LINES; i++) {
    lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: `palabra ${i} ${'x'.repeat(150)}` } }, session_id: 'sess-1', uuid: `u${i}` }));
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Read', input: { path: '/a' } }, { type: 'tool_use', name: 'Read', input: { path: '/b' } }] } }));
  lines.push(JSON.stringify({ type: 'result', session_id: 'sess-1', result: 'done', is_error: false, structured_output: { ok: true },
    total_cost_usd: 0.42, modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 1, costUSD: 0.42 } } }));
  return `${lines.join('\n')}\n`;
}

function codexStdout(outcome: 'completed' | 'failed'): string {
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-1' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'e1', type: 'error', message: 'Not logged in: run codex login' } }),
  ];
  for (let i = 0; i < LINES; i++) {
    lines.push(JSON.stringify({ type: 'item.updated', item: { id: `c${i}`, type: 'command_execution', command: `echo ${'x'.repeat(150)}` } }));
  }
  lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'first answer' } }));
  lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'final answer' } }));
  lines.push(outcome === 'completed'
    ? JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 2 } })
    : JSON.stringify({ type: 'turn.failed', message: 'turn failed' }));
  return `${lines.join('\n')}\n`;
}

describe('Claude exec stream builds its final result without re-parsing stdout', () => {
  it(`matches execute() over ${LINES} lines and only parses the result line again`, async () => {
    const stdout = claudeStdout();
    const spy = vi.mocked(parseClaudeJsonl);
    const adapter = new ClaudeExecAdapter({ target: { command: 'claude', argsPrefix: [] }, runner: runnerFor(stdout) });

    const expected = await adapter.execute(request());
    spy.mockClear();
    const { items, result } = await collect(adapter.stream(request()));

    expect(result.sessionId).toBe('sess-1');
    expect(result.text).toBe('done');
    expect(result.usage).toEqual(expected.usage);
    expect(comparable(result)).toEqual(comparable(expected));
    expect(items.filter((item) => item.kind === 'event')).toHaveLength(expected.events.length);
    expect(longestArgument(spy)).toBeLessThan(4_096);
    expect(stdout.length).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('still reclassifies a non-zero exit without a result event from stderr', async () => {
    const stdout = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })}\n`;
    const adapter = new ClaudeExecAdapter({ target: { command: 'claude', argsPrefix: [] }, runner: runnerFor(stdout, 1, 'claude: boom\n') });

    const expected = await adapter.execute(request());
    const { result } = await collect(adapter.stream(request()));

    expect(result.failure).toEqual({ kind: 'provider-unavailable', message: 'claude: boom' });
    expect(comparable(result)).toEqual(comparable(expected));
  });
});

describe('Codex exec stream builds its final result without re-parsing stdout', () => {
  it.each(['completed', 'failed'] as const)('matches execute() for a %s turn and only parses verdict lines again', async (outcome) => {
    const stdout = codexStdout(outcome);
    const spy = vi.mocked(parseCodexJsonl);
    const adapter = new CodexExecAdapter({ target: { command: 'codex', argsPrefix: [] }, runner: runnerFor(stdout) });

    const expected = await adapter.execute(request());
    spy.mockClear();
    const { result } = await collect(adapter.stream(request()));

    expect(result.sessionId).toBe('thread-1');
    expect(result.turnId).toBe('turn-1');
    expect(result.text).toBe('final answer');
    expect(result.usage).toEqual(expected.usage);
    // The failure kind depends on every error line seen, not only the terminal one.
    expect(result.failure).toEqual(expected.failure);
    if (outcome === 'failed') expect(result.failure?.kind).toBe('not-authenticated');
    expect(comparable(result)).toEqual(comparable(expected));
    expect(longestArgument(spy)).toBeLessThan(4_096);
  });

  it('keeps structured output parsing and the non-zero exit reclassification', async () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '{"count":3}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    const adapter = new CodexExecAdapter({ target: { command: 'codex', argsPrefix: [] }, runner: runnerFor(`${stdout}\n`) });
    const structured = { ...request(), outputSchema: { type: 'object' } };
    expect((await collect(adapter.stream(structured))).result.output).toEqual({ count: 3 });

    const failing = new CodexExecAdapter({ target: { command: 'codex', argsPrefix: [] },
      runner: runnerFor(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n`, 2, 'Not inside a trusted directory') });
    const expected = await failing.execute(request());
    const { result } = await collect(failing.stream(request()));
    expect(result.failure?.kind).toBe('untrusted-workspace');
    expect(comparable(result)).toEqual(comparable(expected));
  });
});
