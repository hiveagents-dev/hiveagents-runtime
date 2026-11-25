import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { ProviderUnavailableError } from '../../public/errors.js';
import { CodexAppServerConnection } from './connection.js';
import {
  captureProcessIdentity,
  verifyProcessIdentity,
  type ProcessIdentityRecord,
} from './process-identity.js';
import type { RpcId } from './rpc-peer.js';

export interface CodexAppServerSupervisorOptions {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  experimentalApi: boolean;
  closeGraceMs?: number;
  onServerRequest?(method: string, params: unknown, id: RpcId): Promise<unknown>;
  onNotification?(method: string, params: unknown): void | Promise<void>;
  /**
   * The transport died while we were not shutting it down: the child exited,
   * or its stdout pump died (structural RPC error, stream end) while the child
   * is still alive — in which case `cause` carries the typed error and the
   * supervisor terminates the child itself.
   */
  onUnexpectedExit?(info: CodexUnexpectedExit): void;
  /** A non-JSON stdout line from the child, tolerated and reported. */
  onNoise?(line: string): void;
}

export interface CodexUnexpectedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  cause?: unknown;
}

export interface CodexShutdownOptions {
  /** Interrupt active turns and await their terminal notifications. */
  drainTurns?: () => Promise<void>;
  /** Unsubscribe thread projections after turns are terminal. */
  unsubscribe?: () => void | Promise<void>;
  /** Cap on the drain phase so shutdown always terminates (default 5s). */
  drainTimeoutMs?: number;
}

/** How long a dead pump waits for the child's own 'exit' before being reported as pump death. */
const PUMP_DEATH_EXIT_GRACE_MS = 50;

/** Newest stderr bytes kept for internal diagnostics; older bytes are dropped. */
export const CODEX_STDERR_TAIL_BYTES = 64 * 1024;

/**
 * Drains the child's stderr continuously — an unread pipe fills its kernel
 * buffer and blocks the app-server mid-write — keeping only a bounded tail.
 * The tail is raw provider prose: internal diagnostics only, never copied
 * into a public error (see failure-projection.ts).
 */
class StderrTail {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on('data', (chunk: Buffer | string) => this.#push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    // A broken stderr pipe is not transport death; stdout and 'exit' report that.
    stream.on('error', () => undefined);
  }

  #push(chunk: Buffer): void {
    const kept = chunk.byteLength > CODEX_STDERR_TAIL_BYTES
      ? chunk.subarray(chunk.byteLength - CODEX_STDERR_TAIL_BYTES)
      : chunk;
    // Copy so a retained slice never pins the stream's larger pooled buffer.
    this.#chunks.push(Buffer.from(kept));
    this.#bytes += kept.byteLength;
    while (this.#bytes > CODEX_STDERR_TAIL_BYTES) {
      const oldest = this.#chunks[0]!;
      const excess = this.#bytes - CODEX_STDERR_TAIL_BYTES;
      if (oldest.byteLength <= excess) {
        this.#chunks.shift();
        this.#bytes -= oldest.byteLength;
      } else {
        this.#chunks[0] = oldest.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString('utf8');
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', exited);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', exited);
  });
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    work.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

/**
 * Owns a local codex app-server child and attempts ordered shutdown: drain
 * turns, unsubscribe, close stdin, then escalate signals with cleared timers.
 * Pipe EOF does not prove orphan/descendant termination after a parent crash;
 * identity observations reduce stale-PID risk but do not make signaling atomic.
 * Hosted control needs a guardian-owned transport and independent settlement
 * evidence; this supervisor supplies neither that authority nor containment.
 */
export class CodexAppServerSupervisor {
  readonly connection: CodexAppServerConnection;
  readonly epoch: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #closeGraceMs: number;
  readonly #stderr: StderrTail;
  #identity: ProcessIdentityRecord;
  #closed = false;
  #shutdown: Promise<void> | undefined;
  #onUnexpectedExit: CodexAppServerSupervisorOptions['onUnexpectedExit'];
  #deathReported = false;
  #pumpCause: unknown;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    connection: CodexAppServerConnection,
    epoch: string,
    identity: ProcessIdentityRecord,
    closeGraceMs: number,
    stderr: StderrTail,
  ) {
    this.#child = child;
    this.#stderr = stderr;
    this.connection = connection;
    this.epoch = epoch;
    this.#identity = identity;
    this.#closeGraceMs = closeGraceMs;
  }

  static async start(options: CodexAppServerSupervisorOptions): Promise<CodexAppServerSupervisor> {
    const child = spawn(options.command, options.args ?? ['app-server', '--stdio'], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Attached before any await: the child may write before the handshake.
    const stderr = new StderrTail(child.stderr);
    const earlyFailure = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        reject(new ProviderUnavailableError(
          { provider: 'codex', transport: 'control', retryable: true },
          `Codex App Server exited during initialization (${code ?? signal ?? 'unknown'})`,
        ));
      });
    });
    const epoch = crypto.randomUUID();
    let supervisor: CodexAppServerSupervisor | undefined;
    const connection = new CodexAppServerConnection({
      input: child.stdout,
      output: child.stdin,
      epoch,
      experimentalApi: options.experimentalApi,
      // Only armed once start() has handed the supervisor out; during the
      // handshake a dead pump surfaces through initialize() rejecting.
      onDeath: (cause) => { if (supervisor) supervisor.#onPumpDeath(cause); },
      ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
      ...(options.onNoise === undefined ? {} : { onNoise: options.onNoise }),
    });
    const identity = child.pid === undefined
      ? { pid: -1 }
      : await captureProcessIdentity(child.pid);
    const started = new CodexAppServerSupervisor(
      child,
      connection,
      epoch,
      identity,
      options.closeGraceMs ?? 1_000,
      stderr,
    );
    try {
      await Promise.race([connection.initialize(), earlyFailure]);
    } catch (error) {
      await started.shutdown();
      throw error;
    }
    started.#onUnexpectedExit = options.onUnexpectedExit;
    child.once('exit', (code, signal) => started.#reportDeath({
      code,
      signal,
      ...(started.#pumpCause === undefined ? {} : { cause: started.#pumpCause }),
    }));
    supervisor = started;
    return started;
  }

  /** Reported at most once, and never once shutdown has begun. */
  #reportDeath(info: CodexUnexpectedExit): boolean {
    if (this.#closed || this.#deathReported) return false;
    this.#deathReported = true;
    this.#onUnexpectedExit?.(info);
    return true;
  }

  /**
   * The stdout pump died while the child may still be alive. Report it like an
   * exit, then shut the child down: a thread must not look active, nor a
   * process keep running, after its transport is gone.
   */
  #onPumpDeath(cause: unknown): void {
    if (this.#closed || this.#deathReported) return;
    this.#pumpCause = cause;
    void waitForExit(this.#child, PUMP_DEATH_EXIT_GRACE_MS).then((exited) => {
      // An exiting child closes stdout just before 'exit': let that listener
      // report the real code and signal. Only a child that is still alive
      // after its pump died is reported — and terminated — from here.
      if (exited) return;
      if (!this.#reportDeath({ code: null, signal: null, cause })) return;
      void this.shutdown().catch(() => undefined);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get identity(): ProcessIdentityRecord {
    return this.#identity;
  }

  /**
   * The newest stderr bytes (at most CODEX_STDERR_TAIL_BYTES), for internal
   * diagnostics only. Raw provider prose: never project it into public errors.
   */
  stderrTail(): string {
    return this.#stderr.text();
  }

  /** Backwards-compatible unordered close: shutdown with no drain callbacks. */
  async close(): Promise<void> {
    await this.shutdown();
  }

  /** Idempotent: a second caller joins the shutdown already in flight. */
  shutdown(options: CodexShutdownOptions = {}): Promise<void> {
    this.#shutdown ??= this.#runShutdown(options);
    return this.#shutdown;
  }

  async #runShutdown(options: CodexShutdownOptions): Promise<void> {
    this.#closed = true;
    const drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    if (options.drainTurns) {
      await withTimeout(options.drainTurns(), drainTimeoutMs);
    }
    if (options.unsubscribe) {
      try {
        await options.unsubscribe();
      } catch {
        // Unsubscription is best-effort during shutdown.
      }
    }
    // Closes the peer and ends the child's stdin: a well-behaved app-server
    // exits on EOF without needing any signal.
    await this.connection.close();
    if (await waitForExit(this.#child, this.#closeGraceMs)) return;
    if (await this.#verifiedKill('SIGTERM')) return;
    if (await waitForExit(this.#child, this.#closeGraceMs)) return;
    if (await this.#verifiedKill('SIGKILL')) return;
    await waitForExit(this.#child, this.#closeGraceMs);
  }

  /**
   * Signals through the ChildProcess handle only after re-verifying process
   * identity (start time + executable). A pid whose identity no longer
   * matches the spawn record is a recycled pid and is never signalled.
   * Returns true when the process is already gone.
   */
  async #verifiedKill(signal: NodeJS.Signals): Promise<boolean> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return true;
    if (this.#identity.pid > 0) {
      const verdict = await verifyProcessIdentity(this.#identity);
      if (verdict === 'exited') return true;
      if (verdict === 'mismatch') return false;
    }
    this.#child.kill(signal);
    return false;
  }
}
