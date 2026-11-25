import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../../src/process/run-process.js';
import type { ProcessRequest } from '../../src/process/run-process.js';

const { superviseNative } = await import(pathToFileURL(resolve('scripts/gemini-live-supervisor.mjs')).href);

const directories: string[] = [];
async function setup(count = 0) {
  const cwd = await mkdtemp(join(tmpdir(), 'oar-live-supervisor-test-'));
  directories.push(cwd);
  const counterPath = join(cwd, 'count.json');
  const diagnosticPath = join(cwd, 'native.json');
  await writeFile(counterPath, JSON.stringify(count));
  return { cwd, counterPath, diagnosticPath, env: process.env, runner: runProcess,
    target: { command: process.execPath, argsPrefix: [] }, stdout() {}, stderr() {} };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('live native supervisor without model calls', () => {
  it('rejects a fifth prompt before invoking the runner', async () => {
    const options = await setup(4);
    let invoked = false;
    await expect(superviseNative({ ...options, args: ['--prompt=test'],
      runner: async () => { invoked = true; throw new Error('must not run'); } })).rejects.toThrow(/limit/);
    expect(invoked).toBe(false);
    expect(JSON.parse(await readFile(options.counterPath, 'utf8'))).toBe(4);
  });

  it('counts Antigravity print flags against the same native launch ceiling', async () => {
    const options = await setup(3);
    const runner = async () => ({ code: 0, signal: null, stdout: '', stderr: '', durationMs: 1 });
    await superviseNative({ ...options, args: ['--print=hello'], runner });
    expect(JSON.parse(await readFile(options.counterPath, 'utf8'))).toBe(4);
    await expect(superviseNative({ ...options, args: ['-p', 'again'], runner })).rejects.toThrow(/limit/);
  });

  it('serializes competing reservations before either native runner starts', async () => {
    const options = await setup(3);
    let launches = 0;
    const runner = async () => { launches++; return { code: 0, signal: null, stdout: '', stderr: '', durationMs: 1 }; };
    await Promise.allSettled([
      superviseNative({ ...options, args: ['--print=one'], runner }),
      superviseNative({ ...options, args: ['--print=two'], runner }),
    ]);
    expect(launches).toBe(1);
    expect(JSON.parse(await readFile(options.counterPath, 'utf8'))).toBe(4);
  });

  it('counts failures durably and sanitizes diagnostic stderr', async () => {
    const options = await setup();
    const result = await superviseNative({ ...options, args: ['--prompt=test'], runner: async (request: ProcessRequest) => {
      request.onStderr?.(Buffer.from('Bearer private-token user@example.com'));
      return { code: 1, signal: null, stdout: '', stderr: '', durationMs: 1 };
    } });
    expect(result.code).toBe(1);
    expect(JSON.parse(await readFile(options.counterPath, 'utf8'))).toBe(1);
    const diagnostics = await readFile(options.diagnosticPath, 'utf8');
    expect(diagnostics).toContain('[redacted]');
    expect(diagnostics).not.toMatch(/private-token|user@example.com/);
  });

  it('enforces combined native output and a bounded native deadline', async () => {
    const options = await setup();
    await expect(superviseNative({ ...options, maxOutputBytes: 1024,
      target: { command: process.execPath, argsPrefix: ['-e', 'process.stdout.write("x".repeat(2048));setInterval(()=>{},1000)', '--'] },
      args: ['--prompt=test'] })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(JSON.parse(await readFile(options.counterPath, 'utf8'))).toBe(1);
    await expect(superviseNative({ ...options, timeoutMs: 50,
      target: { command: process.execPath, argsPrefix: ['-e', 'setInterval(()=>{},1000)', '--'] },
      args: ['--prompt=test'] })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(JSON.parse(await readFile(options.counterPath, 'utf8'))).toBe(2);
  });

  it('kills a detached native group before its outer wrapper is killed', async () => {
    const options = await setup();
    const wrapper = join(options.cwd, 'wrapper.mjs');
    const nativeCode = 'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000);';
    await writeFile(wrapper, `
      import { runProcess } from ${JSON.stringify(pathToFileURL(resolve('dist/adapter-kit.js')).href)};
      import { superviseNative } from ${JSON.stringify(pathToFileURL(resolve('scripts/gemini-live-supervisor.mjs')).href)};
      const controller = new AbortController();
      process.once('SIGTERM', () => controller.abort());
      await superviseNative({runner: runProcess, target: {command: process.execPath,
        argsPrefix: ['-e', ${JSON.stringify(nativeCode)}, '--']}, args: ['--print=fixture'],
        cwd: process.cwd(), env: process.env, signal: controller.signal,
        counterPath: ${JSON.stringify(options.counterPath)}, diagnosticPath: ${JSON.stringify(options.diagnosticPath)},
        stdout: chunk => process.stdout.write(chunk)}).catch(() => { process.exitCode = 1; });
    `);
    const controller = new AbortController();
    let nativePid: number | undefined;
    try {
      await expect(runProcess({ command: process.execPath, args: [wrapper], cwd: options.cwd,
        env: process.env, stdin: '', timeoutMs: 3000, maxOutputBytes: 4096, signal: controller.signal,
        onStdout(chunk) { nativePid = Number(Buffer.from(chunk).toString().trim()); controller.abort(); },
      })).rejects.toMatchObject({ code: 'ABORTED' });
      expect(Number.isInteger(nativePid)).toBe(true);
      let alive = true;
      for (let attempt = 0; attempt < 30 && alive; attempt++) {
        try { process.kill(nativePid!, 0); await new Promise(done => setTimeout(done, 10)); }
        catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      if (nativePid) { try { process.kill(-nativePid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    }
  });
});
