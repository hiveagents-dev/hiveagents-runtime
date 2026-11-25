import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { AdapterStreamItem, ExecTurnRequest } from '../../src/adapters/provider.js';
import { IncrementalLineDecoder } from '../../src/process/json-lines.js';
import { runProcess } from '../../src/process/run-process.js';
import { AgentRuntimeError, OutputLimitError, ProtocolError } from '../../src/public/errors.js';

const fixture = fileURLToPath(new URL('../fixtures/process/fixture-cli.mjs', import.meta.url));

// R1 + N1: an oversized JSONL frame (a tool_result > 1 MiB) used to make the
// decoder throw inside the stdout 'data' handler on every chunk until the
// newline: uncaught exceptions in the host (an Electron modal per chunk), the
// child kept running, and the frame was delivered anyway as `completed`.

function processAlive(pid: number): string {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown';
  }
}

describe('IncrementalLineDecoder frame guard', () => {
  it('discards the oversized frame and stays terminal instead of throwing per chunk', () => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 16 });

    expect(() => decoder.push(Buffer.from('{"big":"xxxxxxxxxxxxxxxxxxxx'))).toThrow(OutputLimitError);
    // The newline arrives later: the frame must not be delivered.
    let delivered: string[] | undefined;
    expect(() => { delivered = decoder.push(Buffer.from('x"}\n{"ok":1}\n')); }).toThrow(OutputLimitError);
    expect(delivered).toBeUndefined();
    expect(decoder.finish()).toEqual([]);
  });
});

describe('runProcess output callbacks', () => {
  it('turns a throwing onStdout into a terminal rejection and terminates the child', async () => {
    let calls = 0;
    const started = Date.now();
    await expect(runProcess({
      command: process.execPath,
      args: [fixture, 'bigline', '300000'],
      cwd: process.cwd(),
      env: process.env,
      stdin: '',
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024 * 1024,
      killGraceMs: 50,
      onStdout: () => {
        calls += 1;
        throw new OutputLimitError({ retryable: false }, 'consumer refused the frame');
      },
    })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', message: 'consumer refused the frame' });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('wraps a non-runtime consumer error as a typed protocol error', async () => {
    await expect(runProcess({
      command: process.execPath,
      args: [fixture, 'bigline', '1000'],
      cwd: process.cwd(),
      env: process.env,
      stdin: '',
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024 * 1024,
      killGraceMs: 50,
      onStdout: () => { throw new Error('parser bug'); },
    })).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe('runProcess keeps the first terminal error', () => {
  const breachThen = (overrides: { signal?: AbortSignal; timeoutMs?: number; afterBreach?: () => void }) => runProcess({
    command: process.execPath,
    args: [fixture, 'bigline', '1000', 'ignore-sigterm'],
    cwd: process.cwd(),
    env: process.env,
    stdin: '',
    timeoutMs: overrides.timeoutMs ?? 10_000,
    maxOutputBytes: 64 * 1024 * 1024,
    killGraceMs: 700,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    onStdout: () => {
      // runProcess catches this callback's error synchronously. Trigger the
      // competing failure only after that catch, regardless of child startup.
      if (overrides.afterBreach) queueMicrotask(overrides.afterBreach);
      throw new OutputLimitError({ retryable: false }, 'frame over the limit');
    },
  });

  it('an abort arriving after an output-limit breach does not relabel it ABORTED', async () => {
    const controller = new AbortController();
    const outcome = breachThen({
      signal: controller.signal,
      afterBreach: () => controller.abort(),
    });

    await expect(outcome).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      message: 'frame over the limit',
      context: { retryable: false },
    });
    expect(controller.signal.aborted).toBe(true);
  });

  it('a timeout firing after an output-limit breach does not relabel it TIMEOUT', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let timersAfterDeadline = 0;
    try {
      await expect(breachThen({
        timeoutMs: 300,
        afterBreach: () => {
          vi.advanceTimersByTime(300);
          timersAfterDeadline = vi.getTimerCount();
          // Finish the kill grace too, so a failing assertion cannot leave a child alive.
          vi.runOnlyPendingTimers();
        },
      })).rejects.toMatchObject({
        code: 'OUTPUT_LIMIT',
        context: { retryable: false },
      });
      expect(timersAfterDeadline).toBe(1); // The deadline fired; escalation was still pending.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each([
  ['claude', () => new ClaudeExecAdapter({ target: { command: process.execPath, argsPrefix: [fixture, 'bigline', '1200000'] } })],
  ['codex', () => new CodexExecAdapter({ target: { command: process.execPath, argsPrefix: [fixture, 'bigline', '1200000'] } })],
] as const)('%s exec stream with a frame over 1 MiB', (_provider, makeAdapter) => {
  let uncaught = 0;
  const onUncaught = (): void => { uncaught += 1; };

  beforeEach(() => {
    uncaught = 0;
    process.on('uncaughtException', onUncaught);
  });
  afterEach(() => {
    process.off('uncaughtException', onUncaught);
  });

  it('rejects the consumer with OUTPUT_LIMIT once, terminates the child, and leaks no uncaught exception', async () => {
    const request: ExecTurnRequest = {
      mode: 'open',
      modelId: 'm',
      cwd: process.cwd(),
      prompt: 'hi',
      env: process.env,
      contextArgs: [],
      permissionArgs: [],
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
    };
    const items: AdapterStreamItem[] = [];
    const errors: unknown[] = [];
    const started = Date.now();
    try {
      for await (const item of makeAdapter().stream(request)) items.push(item);
    } catch (error) {
      errors.push(error);
    }
    const elapsed = Date.now() - started;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AgentRuntimeError);
    expect((errors[0] as AgentRuntimeError).code).toBe('OUTPUT_LIMIT');
    // The fixture idles 15 s after the frame: a prompt rejection proves the child was terminated.
    expect(elapsed).toBeLessThan(3_000);
    expect(items.some((item) => item.kind === 'result')).toBe(false);
    expect(items.some((item) => item.kind === 'event' && JSON.stringify(item.event).length > 1_000_000)).toBe(false);

    const session = items.find((item) => item.kind === 'session');
    expect(session?.kind).toBe('session');
    const pid = Number((session as { sessionId: string }).sessionId.replace('pid-', ''));
    expect(Number.isInteger(pid)).toBe(true);
    await expect.poll(() => processAlive(pid), { timeout: 1_000 }).toBe('ESRCH');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uncaught).toBe(0);
  });
});
