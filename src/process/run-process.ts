import { spawn, type ChildProcess } from 'node:child_process';

import {
  AbortError as RuntimeAbortError,
  AgentRuntimeError,
  OutputLimitError,
  ProtocolError,
  ProviderUnavailableError,
  TimeoutError,
} from '../public/errors.js';

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string | Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Defaults to true. False returns empty stdout without changing delivery or byte limits. */
  captureStdout?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: Uint8Array) => void;
  /** Cooperative bounded delivery; preferred over onStdout when supplied. */
  onStdoutAsync?: (chunk: Uint8Array, deliverySignal: AbortSignal) => Promise<void>;
  onStderr?: (chunk: Uint8Array) => void;
  /** Synchronous notification of the first native failure, before bounded cleanup. */
  onFailure?: (error: AgentRuntimeError) => void | Promise<void>;
  killGraceMs?: number;
}

export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals, parentClosed = false): void {
  // A saved PID/PGID loses its identity when the leader exits. Inherited
  // pipes do not establish ownership; only a surviving guardian can do that.
  if (parentClosed || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group can already be gone; fall through to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function forceKillWindowsTree(child: ChildProcess): void {
  if (process.platform !== 'win32' || child.pid === undefined
    || child.exitCode !== null || child.signalCode !== null) return;
  const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  killer.unref();
}

/** Node timers silently clamp anything outside this range to 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function validateTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? 600_000;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

export async function runProcess(request: ProcessRequest): Promise<ProcessOutcome> {
  validateTimeoutMs(request.timeoutMs);
  if (request.signal?.aborted) {
    throw new RuntimeAbortError({ retryable: true }, 'Turn aborted before process start');
  }

  const startedAt = Date.now();
  return new Promise<ProcessOutcome>((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] | undefined = request.captureStdout === false ? undefined : [];
    const stderr: Buffer[] = [];
    let terminalError: AgentRuntimeError | undefined;
    let settled = false;
    let parentClosed = false;
    let closeOutcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let pendingDelivery: Promise<void> | undefined;
    let deferredStdout: Buffer | undefined;
    const deliveryController = new AbortController();
    let escalationTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const startTermination = (): void => {
      if (parentClosed || settled || child.exitCode !== null || child.signalCode !== null) return;
      signalProcessTree(child, 'SIGTERM', parentClosed);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        if (process.platform === 'win32') {
          if (!parentClosed) forceKillWindowsTree(child);
        }
        else signalProcessTree(child, 'SIGKILL', parentClosed);
        finishProcess();
      }, request.killGraceMs ?? 100);
      escalationTimer.unref();
    };

    const notifyFailure = (error: AgentRuntimeError): void => {
      try { void Promise.resolve(request.onFailure?.(error)).catch(() => undefined); }
      catch { /* Observation cannot replace the native first cause. */ }
    };
    const terminate = (): void => {
      if (parentClosed || settled) return;
      // If the leader has exited, keep observing actual pipe settlement.
      // Do not guess ownership of its numeric group or destroy pipes as proof.
      startTermination();
    };

    const fail = (error: AgentRuntimeError): void => {
      if (terminalError) return;
      terminalError = error;
      notifyFailure(error);
      deferredStdout = undefined;
      deliveryController.abort(error);
      // Stop waiting for an abandoned/noncooperative sink. Drain the pipe so
      // child close and group cleanup remain observable; discard later bytes.
      child.stdout?.resume();
      terminate();
      finishProcess();
    };

    const exceedLimit = (): void => {
      fail(new OutputLimitError(
        {
          retryable: false,
          sanitizedDiagnostics: {
            maxOutputBytes: request.maxOutputBytes,
            observedOutputBytes: stdoutBytes + stderrBytes,
          },
        },
      ));
    };

    // A consumer callback runs inside the stream 'data' handler: anything it
    // throws would otherwise escape as an uncaughtException in the host while
    // the child keeps running. Its failure is terminal for the turn instead.
    const deliver = (
      sink: Buffer[] | undefined,
      callback: ((chunk: Uint8Array) => void) | undefined,
      value: Buffer,
    ): void => {
      if (terminalError) return;
      if (stdoutBytes + stderrBytes > request.maxOutputBytes) {
        exceedLimit();
        return;
      }
      sink?.push(value);
      try {
        callback?.(value);
      } catch (error) {
        fail(error instanceof AgentRuntimeError ? error : new ProtocolError(
          {
            retryable: false,
            sanitizedDiagnostics: { message: error instanceof Error ? error.message : String(error) },
          },
          'Provider output consumer failed',
        ));
      }
    };

    const deliverAsync = (value: Buffer): void => {
      deliver(stdout, undefined, value);
      if (terminalError) { child.stdout.resume(); return; }
      // Pausing before invoking the sink leaves exactly one outstanding
      // delivery, with Node/OS pipe buffers providing bounded upstream storage.
      timeoutTimer.ref();
      pendingDelivery = Promise.resolve().then(async () => {
        if (!terminalError) await request.onStdoutAsync!(value, deliveryController.signal);
      });
      void pendingDelivery.then(() => {
        pendingDelivery = undefined;
        const deferred = deferredStdout; deferredStdout = undefined;
        if (!terminalError && !settled) {
          if (deferred) deliverAsync(deferred);
          else child.stdout.resume();
        }
        finishProcess();
      }, (error: unknown) => {
        pendingDelivery = undefined;
        fail(error instanceof AgentRuntimeError ? error : new ProtocolError(
          { retryable: false, sanitizedDiagnostics: { message: error instanceof Error ? error.message : String(error) } },
          'Provider output consumer failed',
        ));
      });
    };
    child.stdout?.on('data', (value: Buffer) => {
      stdoutBytes += value.byteLength;
      if (!request.onStdoutAsync) { deliver(stdout, request.onStdout, value); return; }
      if (terminalError) return;
      if (stdoutBytes + stderrBytes > request.maxOutputBytes) { exceedLimit(); return; }
      child.stdout.pause();
      if (pendingDelivery !== undefined) {
        // Node's child-exit flush resumes stdio independently of our pause.
        // Retain at most that one read chunk, counted by the output fuse now,
        // and deliver it only after the current sink acknowledges.
        if (deferredStdout !== undefined) {
          fail(new OutputLimitError({ retryable: false }, 'Provider stdout exceeded its pending delivery buffer'));
        } else deferredStdout = value;
        return;
      }
      deliverAsync(value);
    });
    child.stderr?.on('data', (value: Buffer) => {
      stderrBytes += value.byteLength;
      deliver(stderr, request.onStderr, value);
    });

    // Both go through fail(): the first terminal error wins. A timer or abort
    // landing while the child is still closing after an OUTPUT_LIMIT must not
    // relabel it as a retryable TIMEOUT/ABORTED.
    const timeoutTimer = setTimeout(() => fail(new TimeoutError(
      { retryable: true, sanitizedDiagnostics: { timeoutMs: request.timeoutMs } },
    )), request.timeoutMs);
    timeoutTimer.unref();

    const onAbort = (): void => fail(new RuntimeAbortError({ retryable: true }));
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      request.signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      const hadFailure = terminalError !== undefined;
      const failure = terminalError ?? new ProviderUnavailableError(
        { retryable: true, sanitizedDiagnostics: { command: request.command } },
        `Unable to start provider process: ${cause.message}`,
      );
      terminalError = failure;
      if (!hadFailure) notifyFailure(failure);
      deliveryController.abort(cause);
      cleanup();
      reject(failure);
    });

    function finishProcess(): void {
      if (settled || closeOutcome === undefined) return;
      // A clean close never cancels delivery. Keep the deadline alive until
      // every read byte is acknowledged, even after the child has exited.
      if (!terminalError && pendingDelivery !== undefined) { timeoutTimer.ref(); return; }
      if (terminalError && escalationTimer !== undefined) { escalationTimer.ref(); return; }
      settled = true;
      cleanup();
      if (terminalError) { reject(terminalError); return; }
      resolve({ ...closeOutcome, stdout: stdout === undefined ? '' : Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Date.now() - startedAt });
    }

    child.once('close', (code, signal) => {
      if (settled) return;
      parentClosed = true;
      closeOutcome = { code, signal };
      // Escalation rechecks the live leader before every native signal.
      finishProcess();
    });

    child.stdin?.once('error', () => {
      // A provider may exit before consuming stdin; close/exit classification is authoritative.
    });
    child.stdin?.end(request.stdin);
  });
}
