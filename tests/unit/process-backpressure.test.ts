import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { AbortError, OutputLimitError, TimeoutError } from '../../src/public/errors.js';
import { runProcess, type ProcessRequest } from '../../src/process/run-process.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture did not reach its expected boundary')), 1_500);
    })]);
  } finally { clearTimeout(timer); }
}

function launch(code: string, options: Partial<ProcessRequest>) {
  const controller = new AbortController();
  const running = runProcess({
    command: process.execPath, args: ['--input-type=module', '-e', code],
    cwd: process.cwd(), env: {}, stdin: '', timeoutMs: 3_000,
    maxOutputBytes: 3 * 1024 * 1024, killGraceMs: 20,
    ...options, signal: controller.signal,
  });
  // Every assertion/fixture failure still observes the process's outcome.
  const observed = running.then(value => ({ value }), error => ({ error }));
  return { controller, running, observed };
}

describe('awaitable native stdout delivery', () => {
  it('reports a spawn failure once even if its async observer aborts and rejects', async () => {
    let calls = 0;
    const processFixture = launch('', {
      command: '/synthetic/oar-no-such-executable',
      onFailure: async () => { calls++; processFixture.controller.abort(); throw new Error('synthetic observer failure'); },
    });
    try {
      const result = await processFixture.observed;
      expect(result).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
      expect(calls).toBe(1);
    } finally { processFixture.controller.abort(); await processFixture.observed; }
  });

  it('keeps delivery serialized when a child exits with unread stdout while the sink is blocked', async () => {
    const entered = deferred(), gate = deferred(); let active = 0, maximum = 0, calls = 0;
    const chunks: Buffer[] = [];
    const processFixture = launch("process.stdout.end(Buffer.alloc(128 * 1024, 120), () => process.exit(0));", {
      onStdoutAsync: async (chunk: Uint8Array) => {
        active++; maximum = Math.max(maximum, active); calls++; entered.resolve();
        try { await gate.promise; chunks.push(Buffer.from(chunk)); } finally { active--; }
      },
    });
    try {
      await bounded(entered.promise); await delay(60);
      expect(calls).toBe(1); expect(maximum).toBe(1);
      gate.resolve(); const outcome = await bounded(processFixture.running);
      expect(Buffer.concat(chunks).equals(Buffer.alloc(128 * 1024, 120))).toBe(true);
      expect(Buffer.byteLength(outcome.stdout)).toBe(128 * 1024); expect(maximum).toBe(1);
    } finally { gate.resolve(); processFixture.controller.abort(); await processFixture.observed; }
  });

  it('prefers the async sink and keeps only one delivery pending while stderr remains live', async () => {
    const entered = deferred(), gate = deferred(), stderr = deferred();
    let active = 0, maximum = 0, calls = 0, finished = false;
    const chunks: Buffer[] = [];
    const sync = vi.fn(() => { throw new Error('sync stdout must not run when async is supplied'); });
    const processFixture = launch(`
      setTimeout(() => process.stderr.write('ready'), 20);
      for (let i = 0; i < 32; i++) {
        if (!process.stdout.write(Buffer.alloc(65536, 65 + i % 26)))
          await new Promise(resolve => process.stdout.once('drain', resolve));
      }
    `, {
      onStdout: sync,
      onStderr: () => stderr.resolve(),
      onStdoutAsync: async (chunk: Uint8Array, signal: AbortSignal) => {
        active++; maximum = Math.max(maximum, active); calls++;
        try {
          expect(signal.aborted).toBe(false);
          entered.resolve(); await gate.promise;
          chunks.push(Buffer.from(chunk));
        } finally { active--; }
      },
    });
    void processFixture.observed.then(() => { finished = true; });
    try {
      await bounded(entered.promise); await bounded(stderr.promise); await delay(30);
      expect(calls).toBe(1); expect(maximum).toBe(1); expect(finished).toBe(false);
      gate.resolve();
      const outcome = await bounded(processFixture.running);

      const expected = Buffer.concat(Array.from({ length: 32 }, (_, i) => Buffer.alloc(65536, 65 + i % 26)));
      expect(Buffer.concat(chunks).equals(expected)).toBe(true);
      expect(Buffer.from(outcome.stdout).equals(expected)).toBe(true);
      expect(outcome.stderr).toBe('ready'); expect(outcome.code).toBe(0);
      expect(maximum).toBe(1); expect(calls).toBeGreaterThan(1); expect(sync).not.toHaveBeenCalled();
    } finally {
      gate.resolve(); processFixture.controller.abort(); await processFixture.observed;
    }
  });

  it('retains the final bytes and an active delivery signal until clean-exit acknowledgment', async () => {
    const entered = deferred(), gate = deferred(); let deliverySignal: AbortSignal | undefined, settled = false;
    const seen: string[] = [];
    const processFixture = launch("process.stdout.end('final-bytes', () => process.exit(0));", {
      onStdoutAsync: async (chunk: Uint8Array, signal: AbortSignal) => {
        deliverySignal = signal; entered.resolve(); await gate.promise;
        seen.push(Buffer.from(chunk).toString());
      },
    });
    void processFixture.observed.then(() => { settled = true; });
    try {
      await bounded(entered.promise); await delay(40);
      expect(settled).toBe(false); expect(deliverySignal?.aborted).toBe(false);
      gate.resolve();
      await expect(bounded(processFixture.running)).resolves.toMatchObject({ code: 0, stdout: 'final-bytes' });
      expect(seen.join('')).toBe('final-bytes'); expect(deliverySignal?.aborted).toBe(false);
    } finally {
      gate.resolve(); processFixture.controller.abort(); await processFixture.observed;
    }
  });

  it.each(['abort', 'timeout'] as const)('terminates while a noncooperative sink is pending on %s', async mode => {
    const entered = deferred(), gate = deferred(); let deliverySignal: AbortSignal | undefined;
    const processFixture = launch("process.stdout.write('one'); setInterval(() => {}, 1000);", {
      timeoutMs: mode === 'timeout' ? 500 : 3_000,
      onStdoutAsync: async (_chunk: Uint8Array, signal: AbortSignal) => {
        deliverySignal = signal; entered.resolve(); await gate.promise;
      },
    });
    try {
      await bounded(entered.promise);
      if (mode === 'abort') processFixture.controller.abort();
      const outcome = await bounded(processFixture.observed);
      expect(outcome).toHaveProperty('error');
      if ('error' in outcome) expect(outcome.error).toBeInstanceOf(mode === 'abort' ? AbortError : TimeoutError);
      expect(deliverySignal?.aborted).toBe(true);
      // A rejected callback after process settlement is still observed, and cannot replace its cause.
      gate.reject(new Error('late private callback rejection')); await delay(10);
    } finally {
      gate.resolve(); processFixture.controller.abort(); await processFixture.observed;
    }
  });

  it('preserves a nominal sink failure while terminating its child', async () => {
    const failure = new OutputLimitError({ retryable: false }, 'fixture frame limit');
    const processFixture = launch("process.stdout.write('one'); setInterval(() => {}, 1000);", {
      onStdoutAsync: async () => { throw failure; },
    });
    try {
      const outcome = await bounded(processFixture.observed);
      expect(outcome).toEqual({ error: failure });
    } finally { processFixture.controller.abort(); await processFixture.observed; }
  });

  it('keeps the aggregate output fuse active while stdout delivery is paused', async () => {
    const gate = deferred(); let deliverySignal: AbortSignal | undefined;
    const processFixture = launch(`
      process.stdout.write('one');
      setTimeout(() => { process.stderr.write('x'.repeat(4096)); }, 50);
      setInterval(() => {}, 1000);
    `, {
      maxOutputBytes: 1024,
      onStdoutAsync: async (_chunk: Uint8Array, signal: AbortSignal) => {
        deliverySignal = signal; await gate.promise;
      },
    });
    try {
      const outcome = await bounded(processFixture.observed);
      expect(outcome).toHaveProperty('error');
      if ('error' in outcome) expect(outcome.error).toBeInstanceOf(OutputLimitError);
      expect(deliverySignal?.aborted).toBe(true);
    } finally {
      gate.resolve(); processFixture.controller.abort(); await processFixture.observed;
    }
  });
});
