import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputLimitError } from '../../src/public/errors.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { runProcess } from '../../src/process/run-process.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers(); vi.restoreAllMocks(); spawn.mockReset();
});

function fixture() {
  return Object.assign(new EventEmitter(), {
    pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  });
}
const request = () => ({ command: 'fixture-node', args: [], cwd: process.cwd(), env: {},
  stdin: '', timeoutMs: 20, maxOutputBytes: 1024, killGraceMs: 10 });

describe('late delivery failure after native exit', () => {
  it.each(['close', 'exit-before-close'].flatMap(phase => ['timeout', 'rejection'].map(mode => ({ phase, mode }))))(
    'does not signal an expired process/group identity on $mode after $phase', async ({ phase, mode }) => {
      vi.useFakeTimers(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
      const child = fixture(); spawn.mockReturnValue(child);
      let acknowledge!: () => void, reject!: (error: unknown) => void, entered!: () => void;
      const gate = new Promise<void>((yes, no) => { acknowledge = yes; reject = no; });
      const seen = new Promise<void>(resolve => { entered = resolve; });
      const failure = new OutputLimitError({ retryable: false });
      const running = runProcess({ ...request(), onStdoutAsync: async () => { entered(); await gate; } })
        .then(value => ({ value }), error => ({ error }));
      try {
        child.stdout.write('last'); await seen;
        child.exitCode = 0; child.emit('exit', 0, null);
        // Model the real clean-exit EOF queued behind the paused delivery.
        // fail() resumes stdout before the deferred group-cleanup decision.
        child.stdout.end(); child.stderr.end(); child.stderr.resume();
        if (phase === 'close') child.emit('close', 0, null);
        if (mode === 'rejection') reject(failure);
        await vi.advanceTimersByTimeAsync(35);
        if (phase !== 'close') child.emit('close', 0, null);
        const outcome = await running;
        expect(outcome).toMatchObject({ error: { code: mode === 'timeout' ? 'TIMEOUT' : 'OUTPUT_LIMIT' } });
        if (mode === 'rejection') expect(outcome).toEqual({ error: failure });
        expect(signal).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
      } finally {
        acknowledge(); child.emit('close', 0, null); await vi.runAllTimersAsync(); await running;
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      }
    },
  );

  it('does not escalate a saved numeric group once the original child has exited', async () => {
    vi.useFakeTimers(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = fixture(); spawn.mockReturnValue(child);
    const running = runProcess(request()).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(signal).toHaveBeenCalledWith(-12345, 'SIGTERM');
      child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(15);
      expect(await running).toMatchObject({ code: 'TIMEOUT' });
      expect(signal.mock.calls).toEqual([[-12345, 'SIGTERM']]);
    } finally {
      child.emit('close', 0, null); await vi.runAllTimersAsync(); await running;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });
});
