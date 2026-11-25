import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

interface WorkerMessage {
  event: 'ready' | 'attempt' | 'released' | 'error';
  pid: number;
  result?: { allowed?: boolean; ok?: boolean; reason?: string; reservation?: { token: string } };
  detail?: string;
}

function worker(mode: 'local' | 'shared', databasePath: string, capacity: number, hour = 100, day = 100): ChildProcess {
  return fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [mode, databasePath, String(capacity), String(hour), String(day)], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

function message(child: ChildProcess, event: WorkerMessage['event']): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Worker ${child.pid} timed out awaiting ${event}`)), 15_000);
    let stderr = '';
    const onError = (error: Error) => done(error);
    const onExit = (code: number | null) => done(new Error(`Worker exited ${code}: ${stderr}`));
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString(); };
    const onMessage = (value: WorkerMessage) => {
      if (value.event === 'error') done(new Error(value.detail));
      else if (value.event === event) done(undefined, value);
    };
    function done(error?: Error, value?: WorkerMessage) {
      clearTimeout(timer);
      child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
      if (error) reject(error); else resolve(value!);
    }
    child.on('message', onMessage); child.on('error', onError); child.on('exit', onExit);
    child.stderr?.on('data', onStderr);
  });
}

/** All contenders finish admission before any admitted operation ends. */
export async function measureBudget(mode: 'local' | 'shared', databasePath: string, contenders = 20, capacity = 2, hour = 100, day = 100) {
  const started = performance.now();
  const children = Array.from({ length: contenders }, () => worker(mode, databasePath, capacity, hour, day));
  try {
    await Promise.all(children.map(child => message(child, 'ready')));
    const attempts = children.map(child => message(child, 'attempt'));
    children.forEach(child => child.send('reserve'));
    const observed = await Promise.all(attempts);
    // Every admitted child is still holding its slot at this barrier.
    const admitted = observed.filter(item => item.result?.allowed).length;
    const completions = children.map(child => message(child, 'released'));
    children.forEach(child => child.send('release'));
    const released = await Promise.all(completions);
    if (released.some(item => item.result?.ok === false)) throw new Error('Failed to release a measured slot');
    return {
      workload: 'synthetic IPC-barrier launch reservations; no provider calls',
      mode, contenders, independentProcesses: new Set(observed.map(item => item.pid)).size,
      capacity, maxLaunchesPerHour: hour, maxLaunchesPerDay: day,
      admitted, denied: contenders - admitted, maxSimultaneous: admitted,
      denialReasons: observed.filter(item => !item.result?.allowed).map(item => item.result?.reason),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    };
  } finally {
    children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  }
}

export async function reserveAndCrash(databasePath: string): Promise<string> {
  const child = worker('shared', databasePath, 1);
  try {
    await message(child, 'ready');
    const attempt = message(child, 'attempt'); child.send('reserve');
    const result = (await attempt).result;
    if (!result?.allowed || !result.reservation) throw new Error(`Crash fixture could not reserve: ${JSON.stringify(result)}`);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    return result.reservation.token;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
