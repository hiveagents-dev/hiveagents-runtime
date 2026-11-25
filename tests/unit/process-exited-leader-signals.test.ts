import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(),
  });
}
const request = () => ({ command: 'fixture-node', args: [], cwd: process.cwd(), env: {},
  stdin: '', timeoutMs: 20, maxOutputBytes: 1024, killGraceMs: 10 });

describe('exited native leader signaling boundary', () => {
  it.each(['ESRCH', 'EPERM'])('never signals a numeric group after leader exit, even if its probe would return %s', async code => {
    vi.useFakeTimers(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('group unavailable'), { code }); });
    const child = fixture(); spawn.mockReturnValue(child);
    let settled = false;
    const running = runProcess(request()).catch(error => error).finally(() => { settled = true; });
    try {
      child.exitCode = 0; child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(35);
      expect(signal).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled(); expect(settled).toBe(false);
      child.emit('close', 0, null); expect(await running).toMatchObject({ code: 'TIMEOUT' });
    } finally {
      child.emit('close', 0, null); await vi.runAllTimersAsync(); await running;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });

  it('close before the deferred cleanup decision forbids starting any new signals', async () => {
    vi.useFakeTimers(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true), controller = new AbortController();
    const child = fixture(); spawn.mockReturnValue(child);
    const running = runProcess({ ...request(), signal: controller.signal }).catch(error => error);
    try {
      child.exitCode = 0; child.emit('exit', 0, null); controller.abort(); child.emit('close', 0, null);
      await vi.runAllTimersAsync(); expect(await running).toMatchObject({ code: 'ABORTED' });
      expect(signal).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
    } finally {
      child.emit('close', 0, null); await vi.runAllTimersAsync(); await running;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });

  it('inherited open pipes never grant post-exit signal authority', async () => {
    vi.useFakeTimers(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true), controller = new AbortController();
    const child = fixture(); spawn.mockReturnValue(child);
    const running = runProcess({ ...request(), signal: controller.signal }).catch(error => error);
    try {
      child.exitCode = 0; child.emit('exit', 0, null); controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(signal).not.toHaveBeenCalled();
      child.emit('close', 0, null); await vi.runAllTimersAsync();
      expect(await running).toMatchObject({ code: 'ABORTED' });
      expect(signal).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      child.emit('close', 0, null); await vi.runAllTimersAsync(); await running;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });
});
