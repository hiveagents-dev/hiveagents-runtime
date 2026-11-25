import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDirectory } from './log-store-fixture.js';

const cleanup: (() => void)[] = []; afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const files = logDirectory(); cleanup.push(files.cleanup); const entry = join(files.directory, 'history-worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./log-store-fixtures/run-history-worker.ts', import.meta.url))], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return { ...files, entry, target: join(files.directory, 'owned-effect'), cli: fileURLToPath(new URL('../fixtures/process/required-capture-cli.mjs', import.meta.url)) };
}
function run(files: Awaited<ReturnType<typeof fixture>>, mode: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [files.entry, files.file, files.target, mode, files.cli], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    for (const [stream, receive] of [[child.stdout, (bytes: Buffer) => { output += bytes; }], [child.stderr, (bytes: Buffer) => { error += bytes; }]] as const) stream.on('data', bytes => { receive(bytes); if (output.length + error.length > 32768) child.kill('SIGKILL'); });
    child.once('error', value => { clearTimeout(timer); reject(value); }); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, error }); });
  });
}
it('two real processes use public built SDK Runtime capture, effect, history and audit in the same log', async () => {
  const files = await fixture(), first = await run(files, 'complete'); expect(first.code, first.error).toBe(0);
  const original = JSON.parse(first.output); expect(original).toMatchObject({ kind: 'started', record: { status: 'completed' }, trace: { kind: 'observed' }, audit: { runMarkers: 2 }, effect: 'verified' });
  expect(original.trace.events).toBeGreaterThan(0); expect(original.audit.decisions).toBeGreaterThan(0); expect(original.sources).toEqual([original.source]);
  const second = await run(files, 'recover'); expect(second.code, second.error).toBe(0);
  const recovered = JSON.parse(second.output); expect(recovered.kind).toBe('existing'); expect(recovered.record).toEqual(original.record); expect(recovered.events).toEqual(original.events);
  expect(recovered.list).toEqual([original.record]); expect(readFileSync(files.target, 'utf8')).toBe('effect\n');
}, 15000);
it('a second process observes crash UNKNOWN without replaying the same run or uncertain external effect', async () => {
  const files = await fixture(), crashed = await run(files, 'crash'); expect(crashed.signal, crashed.error).toBe('SIGKILL');
  const second = await run(files, 'recover'); expect(second.code, second.error).toBe(0);
  const recovered = JSON.parse(second.output); expect(recovered).toMatchObject({ kind: 'existing', record: { status: 'unknown' }, effect: 'intent', audit: { runMarkers: 1 } });
  expect(recovered.events).not.toContain('run.completed'); expect(recovered.trace.events).toBeGreaterThan(0); expect(readFileSync(files.target, 'utf8')).toBe('effect\n');
}, 15000);
it('two independent first begins cannot each dispatch the same task', async () => {
  const files = await fixture(), pair = await Promise.all([run(files, 'complete'), run(files, 'complete')]);
  for (const result of pair) expect(result.code, result.error).toBe(0);
  expect(pair.map(result => JSON.parse(result.output).kind).sort()).toEqual(['existing', 'started']);
  expect(readFileSync(files.target, 'utf8')).toBe('effect\n');
}, 15000);
