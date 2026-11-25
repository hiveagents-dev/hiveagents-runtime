import { describe, expect, it } from 'vitest';

import { runProcess, type ProcessRequest } from '../../src/process/run-process.js';

function request(code: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return {
    command: process.execPath, args: ['-e', code], cwd: process.cwd(), env: process.env,
    stdin: '', timeoutMs: 5_000, maxOutputBytes: 8 * 1024 * 1024, ...overrides,
  };
}

describe('runProcess stdout capture policy', () => {
  it.each([
    { policy: 'default', options: {}, retainedStdoutBytes: 4_194_304 },
    { policy: 'enabled', options: { captureStdout: true }, retainedStdoutBytes: 4_194_304 },
    { policy: 'streaming', options: { captureStdout: false }, retainedStdoutBytes: 0 },
  ])('delivers all 4 MiB with $policy capture', async ({ options, retainedStdoutBytes }) => {
    let deliveredBytes = 0;
    let active = 0;
    let maximumActive = 0;
    const outcome = await runProcess(request('process.stdout.write(Buffer.alloc(4*1024*1024,97))', {
      ...options,
      onStdout: () => { throw new Error('async delivery must take precedence'); },
      onStdoutAsync: async chunk => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>(resolve => setImmediate(resolve));
        deliveredBytes += chunk.byteLength;
        active--;
      },
    }));

    expect({ deliveredBytes, retainedStdoutBytes: Buffer.byteLength(outcome.stdout), exit: outcome.code })
      .toEqual({ deliveredBytes: 4_194_304, retainedStdoutBytes, exit: 0 });
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
  });

  it('keeps synchronous delivery, stderr and nonzero exits without capturing stdout', async () => {
    let delivered = '';
    let stderr = '';
    const outcome = await runProcess(request(
      'process.stdout.write("héllo"); process.stderr.write("diagnostic"); process.exitCode = 7;', {
        captureStdout: false,
        onStdout: chunk => { delivered += Buffer.from(chunk).toString('utf8'); },
        onStderr: chunk => { stderr += Buffer.from(chunk).toString('utf8'); },
      },
    ));
    expect(delivered).toBe('héllo');
    expect(stderr).toBe('diagnostic');
    expect(outcome).toMatchObject({ stdout: '', stderr: 'diagnostic', code: 7, signal: null });
  });

  it.each([
    { name: 'stdout alone', code: 'process.stdout.write(Buffer.alloc(17,97))' },
    { name: 'stdout plus stderr', code: 'process.stdout.write(Buffer.alloc(8,97)); process.stderr.write(Buffer.alloc(9,98))' },
  ])('still counts $name towards the output fuse', async ({ code }) => {
    await expect(runProcess(request(code, {
      captureStdout: false, maxOutputBytes: 16, onStdoutAsync: async () => {},
    }))).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      context: { retryable: false, sanitizedDiagnostics: { maxOutputBytes: 16, observedOutputBytes: 17 } },
    });
  });

  it('keeps consumer failures typed when capture is disabled', async () => {
    await expect(runProcess(request('process.stdout.write("output")', {
      captureStdout: false,
      onStdoutAsync: async () => { throw new Error('consumer failed'); },
    }))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR', context: { retryable: false, sanitizedDiagnostics: { message: 'consumer failed' } },
    });
  });
});
