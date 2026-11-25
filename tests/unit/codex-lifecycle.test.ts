import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  captureProcessIdentity,
  verifyProcessIdentity,
} from '../../src/adapters/codex-control/process-identity.js';
import { CodexAppServerSupervisor } from '../../src/adapters/codex-control/supervisor.js';
import { ProtocolError } from '../../src/public/errors.js';

const fakeServer = fileURLToPath(new URL('../fixtures/codex-control/fake-app-server.mjs', import.meta.url));
const orphanParent = fileURLToPath(new URL('../fixtures/codex-control/orphan-parent.mjs', import.meta.url));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

function startSupervisor(mode: 'eof-exit' | 'stubborn', options: { closeGraceMs?: number; onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void } = {}) {
  return CodexAppServerSupervisor.start({
    command: process.execPath,
    args: [fakeServer, mode],
    cwd: process.cwd(),
    env: process.env,
    experimentalApi: false,
    ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    ...(options.onUnexpectedExit === undefined ? {} : { onUnexpectedExit: options.onUnexpectedExit }),
  });
}

describe('CodexAppServerSupervisor ordered shutdown', () => {
  it('drains turns, unsubscribes, then closes stdin — in that order — before any signal', async () => {
    const supervisor = await startSupervisor('eof-exit');
    const pid = supervisor.pid!;
    const order: string[] = [];

    await supervisor.shutdown({
      drainTurns: async () => {
        order.push('drain');
        expect(pidAlive(pid)).toBe(true);
      },
      unsubscribe: () => {
        order.push('unsubscribe');
        expect(pidAlive(pid)).toBe(true);
      },
    });

    expect(order).toEqual(['drain', 'unsubscribe']);
    expect(supervisor.closed).toBe(true);
    expect(await eventually(() => !pidAlive(pid))).toBe(true);
  });

  it('escalates TERM then KILL with cancelable timers when the server ignores EOF and SIGTERM', async () => {
    const supervisor = await startSupervisor('stubborn', { closeGraceMs: 60 });
    const pid = supervisor.pid!;
    await supervisor.shutdown();
    expect(await eventually(() => !pidAlive(pid))).toBe(true);
  }, 10_000);

  it('exposes the transport epoch and process identity', async () => {
    const supervisor = await startSupervisor('eof-exit');
    expect(supervisor.epoch).toMatch(/[0-9a-f-]{36}/);
    expect(supervisor.identity.pid).toBe(supervisor.pid);
    expect(supervisor.identity.startTime).toBeDefined();
    await supervisor.shutdown();
  });

  it('reports an unexpected child death exactly when not shutting down', async () => {
    let observed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const supervisor = await startSupervisor('eof-exit', {
      onUnexpectedExit: (info) => { observed = info; },
    });
    process.kill(supervisor.pid!, 'SIGKILL');
    expect(await eventually(() => observed !== undefined)).toBe(true);
    expect(observed?.signal).toBe('SIGKILL');
    await supervisor.shutdown();
  });
});

describe('process identity verification', () => {
  it('matches a live process, detects exit, and refuses recycled identities', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const record = await captureProcessIdentity(pid);
    expect(record.startTime).toBeDefined();
    expect(record.command).toBeDefined();

    await expect(verifyProcessIdentity(record)).resolves.toBe('match');
    // A record whose start time differs is a recycled pid: never signalled.
    await expect(verifyProcessIdentity({ ...record, startTime: 'Thu Jan  1 00:00:00 1970' }))
      .resolves.toBe('mismatch');

    child.kill('SIGKILL');
    await once(child, 'exit');
    await expect(verifyProcessIdentity(record)).resolves.toBe('exited');
  });
});

describe('parent-crash safety', () => {
  it('lets no orphaned app-server survive a SIGKILLed parent (stdin EOF watchdog)', async () => {
    const parent = spawn(process.execPath, [orphanParent], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffered = '';
    const serverPid = await new Promise<number>((resolve, reject) => {
      parent.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const newline = buffered.indexOf('\n');
        if (newline >= 0) resolve(Number(buffered.slice(0, newline)));
      });
      parent.once('exit', () => reject(new Error('parent died before reporting the server pid')));
    });
    expect(Number.isInteger(serverPid)).toBe(true);
    expect(pidAlive(serverPid)).toBe(true);

    parent.kill('SIGKILL');
    await once(parent, 'exit');
    expect(await eventually(() => !pidAlive(serverPid))).toBe(true);
  }, 10_000);
});

describe('CodexAppServerSupervisor pump death (R3)', () => {
  function start(mode: 'orphan' | 'noisy' | 'huge', onUnexpectedExit?: (info: unknown) => void) {
    return CodexAppServerSupervisor.start({
      command: process.execPath,
      args: [fakeServer, mode],
      cwd: process.cwd(),
      env: process.env,
      experimentalApi: false,
      closeGraceMs: 60,
      ...(onUnexpectedExit === undefined ? {} : { onUnexpectedExit }),
    });
  }

  it('treats a dead pump like an unexpected exit and terminates the still-alive child', async () => {
    const deaths: unknown[] = [];
    const supervisor = await start('orphan', (info) => deaths.push(info));
    const pid = supervisor.pid!;

    await expect(supervisor.connection.request('turn/interrupt', { threadId: 't1' }))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });

    expect(await eventually(() => deaths.length === 1)).toBe(true);
    expect(deaths[0]).toMatchObject({ cause: expect.any(ProtocolError) });
    expect(await eventually(() => supervisor.closed)).toBe(true);
    expect(await eventually(() => !pidAlive(pid))).toBe(true);
    expect(deaths).toHaveLength(1);
  }, 10_000);

  it('terminates the child when it emits a frame above the 8 MiB cap, with a typed cause', async () => {
    const deaths: unknown[] = [];
    const supervisor = await start('huge', (info) => deaths.push(info));
    const pid = supervisor.pid!;

    await expect(supervisor.connection.request('turn/start', { threadId: 't1' }))
      .rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });

    expect(await eventually(() => deaths.length === 1)).toBe(true);
    expect(deaths[0]).toMatchObject({ cause: expect.objectContaining({ code: 'OUTPUT_LIMIT' }) });
    // Whether the child dies of EPIPE on the destroyed pipe or is terminated
    // by the supervisor, it must be gone; the cause stays typed either way.
    expect(await eventually(() => !pidAlive(pid))).toBe(true);
    expect(deaths).toHaveLength(1);
    await supervisor.shutdown();
  }, 15_000);

  it('survives plain-text stdout noise and reports it instead of dying', async () => {
    const deaths: unknown[] = [];
    const noise: string[] = [];
    const supervisor = await CodexAppServerSupervisor.start({
      command: process.execPath,
      args: [fakeServer, 'noisy'],
      cwd: process.cwd(),
      env: process.env,
      experimentalApi: false,
      onUnexpectedExit: (info) => { deaths.push(info); },
      onNoise: (line) => { noise.push(line); },
    });

    await expect(supervisor.connection.request('thread/start', {})).resolves.toEqual({ ok: true });
    expect(noise).toEqual(['WARN: plain text on stdout']);
    expect(deaths).toHaveLength(0);
    expect(supervisor.closed).toBe(false);
    await supervisor.shutdown();
  });
});
