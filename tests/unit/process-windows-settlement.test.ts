import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { runProcess } from '../../src/process/run-process.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers(); spawn.mockReset();
});

describe('Windows async delivery settlement', () => {
  it('keeps the existing tree escalation for a child that is still alive', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn(), unref: vi.fn(),
    });
    spawn.mockImplementation((command: string) => command === 'taskkill.exe' ? { unref: vi.fn() } : child);
    const running = runProcess({ command: 'fixture-node', args: [], cwd: process.cwd(), env: {},
      stdin: '', timeoutMs: 20, maxOutputBytes: 1024, killGraceMs: 10,
    }).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawn).toHaveBeenCalledWith('taskkill.exe', ['/pid', '12345', '/t', '/f'], expect.any(Object));
      child.emit('close', null, 'SIGKILL');
      expect(await running).toMatchObject({ code: 'TIMEOUT' });
    } finally {
      child.emit('close', null, 'SIGKILL'); await vi.runAllTimersAsync(); await running;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });

  it.each(['close', 'exit-before-close'] as const)('never taskkills an exited PID after %s while awaiting a sink', async phase => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(), unref: vi.fn(),
    });
    spawn.mockImplementation((command: string) => command === 'taskkill.exe' ? { unref: vi.fn() } : child);
    let acknowledge!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { acknowledge = resolve; });
    const seen = new Promise<void>(resolve => { entered = resolve; });
    let deliverySignal: AbortSignal | undefined;
    const running = runProcess({ command: 'fixture-node', args: [], cwd: process.cwd(), env: {},
      stdin: '', timeoutMs: 20, maxOutputBytes: 1024, killGraceMs: 10,
      onStdoutAsync: async (_chunk, signal) => { deliverySignal = signal; entered(); await gate; },
    }).then(value => ({ value }), error => ({ error }));
    try {
      child.stdout.write('last'); await seen;
      child.exitCode = 0; child.emit('exit', 0, null);
      if (phase === 'close') child.emit('close', 0, null);
      expect(deliverySignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(35);
      if (phase !== 'close') child.emit('close', 0, null);
      expect(await running).toMatchObject({ error: { code: 'TIMEOUT' } });
      expect(deliverySignal?.aborted).toBe(true);
      expect(spawn.mock.calls.map(call => call[0])).toEqual(['fixture-node']);
    } finally {
      acknowledge(); child.emit('close', 0, null); await vi.runAllTimersAsync(); await running;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });
});
