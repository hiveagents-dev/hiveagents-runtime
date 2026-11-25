import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { AbortError, OutputLimitError, TimeoutError } from '../../src/index.js';
// Internos por deep import: no forman parte de la superficie publicada.
import { IncrementalLineDecoder } from '../../src/process/json-lines.js';
import { runProcess } from '../../src/process/run-process.js';

const fixture = fileURLToPath(new URL('../fixtures/process/fixture-cli.mjs', import.meta.url));

function request(args: string[], overrides: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return {
    command: process.execPath,
    args: [fixture, ...args],
    cwd: process.cwd(),
    env: process.env,
    stdin: '',
    timeoutMs: 2_000,
    maxOutputBytes: 1_024 * 1_024,
    ...overrides,
  };
}

describe('runProcess', () => {
  it('delivers prompts through stdin and preserves argv boundaries', async () => {
    const outcome = await runProcess(request(
      ['echo', 'a path', 'x&y'],
      { stdin: 'prompt with > and | operators' },
    ));

    expect(JSON.parse(outcome.stdout)).toEqual({
      argv: ['a path', 'x&y'],
      stdin: 'prompt with > and | operators',
    });
  });

  it('keeps stdout and stderr separate', async () => {
    await expect(runProcess(request(['stderr']))).resolves.toMatchObject({
      stdout: 'out',
      stderr: 'err',
      code: 0,
    });
  });

  it('raises a typed timeout instead of returning a partial success', async () => {
    await expect(runProcess(request(['hang'], { timeoutMs: 25 }))).rejects.toBeInstanceOf(TimeoutError);
  });

  it('raises a typed abort and terminates the process tree', async () => {
    const controller = new AbortController();
    const outcome = runProcess(request(['hang'], { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);

    await expect(outcome).rejects.toBeInstanceOf(AbortError);
  });

  it('never silently truncates provider output', async () => {
    await expect(runProcess(request(['large', '10000'], { maxOutputBytes: 100 })))
      .rejects.toBeInstanceOf(OutputLimitError);
  });

  it('closes stdin even when it is empty', async () => {
    await expect(runProcess(request(['echo']))).resolves.toMatchObject({ code: 0 });
  });

  it.runIf(process.platform === 'darwin')('kills the full Darwin descendant process group after abort', async () => {
    const controller = new AbortController();
    let output = '';
    let descendantPid: number | undefined;
    let announce!: () => void;
    const announced = new Promise<void>((resolve) => { announce = resolve; });
    const running = runProcess(request(['spawn-tree'], {
      signal: controller.signal,
      killGraceMs: 25,
      onStdout(chunk) {
        output += Buffer.from(chunk).toString('utf8');
        const parsed = Number.parseInt(output, 10);
        if (Number.isInteger(parsed) && descendantPid === undefined) {
          descendantPid = parsed;
          announce();
        }
      },
    }));

    await announced;
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(AbortError);
    expect(descendantPid).toBeDefined();
    await expect.poll(() => {
      try {
        process.kill(descendantPid as number, 0);
        return 'alive';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code;
      }
    }, { timeout: 1_000 }).toBe('ESRCH');
  });

  it.runIf(process.platform === 'darwin')('kills the full Darwin descendant process group after timeout', async () => {
    // Only the timers are fake, so the 100 ms timeout fires once the tree exists (under load, Node
    // startup alone can outlast a real 100 ms); the spawn, the signals and the ESRCH poll are real.
    // Both processes ignore SIGTERM: only the group SIGKILL after the grace period ends them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let output = '';
      let descendantPid: number | undefined;
      let announce!: () => void;
      const announced = new Promise<void>((resolve) => { announce = resolve; });
      const running = runProcess(request(['spawn-tree'], {
        timeoutMs: 100,
        killGraceMs: 25,
        onStdout(chunk) {
          output += Buffer.from(chunk).toString('utf8');
          const parsed = Number.parseInt(output, 10);
          if (Number.isInteger(parsed) && descendantPid === undefined) {
            descendantPid = parsed;
            announce();
          }
        },
      }));
      const outcome = running.then(() => 'resolved', (error: unknown) => error);

      await announced;
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(25);
      expect(await outcome).toBeInstanceOf(TimeoutError);
      expect(descendantPid).toBeDefined();
      await expect.poll(() => {
        try {
          process.kill(descendantPid as number, 0);
          return 'alive';
        } catch (error) {
          return (error as NodeJS.ErrnoException).code;
        }
      }, { timeout: 1_000 }).toBe('ESRCH');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IncrementalLineDecoder', () => {
  it('handles JSONL split across arbitrary byte chunks', () => {
    const decoder = new IncrementalLineDecoder();

    expect(decoder.push(Buffer.from('{"n":1}\n{"n"'))).toEqual(['{"n":1}']);
    expect(decoder.push(Buffer.from(':2}\n'))).toEqual(['{"n":2}']);
    expect(decoder.finish()).toEqual([]);
  });

  it('returns a final unterminated line', () => {
    const decoder = new IncrementalLineDecoder();
    decoder.push(Buffer.from('last'));
    expect(decoder.finish()).toEqual(['last']);
  });

  it('rejects an unterminated frame once its byte limit is exceeded', () => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 8 });

    expect(() => decoder.push(Buffer.from('123456789'))).toThrow(OutputLimitError);
  });
});
