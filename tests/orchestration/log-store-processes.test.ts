import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { logDirectory } from './log-store-fixture.js';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function worker() {
  const files = logDirectory(); cleanup.push(files.cleanup); const entry = join(files.directory, 'worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./log-store-fixtures/worker.ts', import.meta.url))], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return { ...files, entry };
}
function run(entry: string, file: string, mode = 'append') {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, file, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', bytes => { output += String(bytes); if (output.length > 4096) child.kill('SIGKILL'); });
    child.stderr.resume(); child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}
it('two actual independent writers race first publication/request and allocate one source range', async () => {
  const { file, entry } = await worker();
  const results = await Promise.all([run(entry, file), run(entry, file)]);
  expect(results.map(result => result.code)).toEqual([0, 0]); expect(JSON.parse(results[0]!.output)).toEqual(JSON.parse(results[1]!.output));
  const store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => store.close());
  expect((await store.readPage()).scanned).toBe(1);
}, 10000);
it('reopens exact committed data after an owned writer is SIGKILLed without close', async () => {
  const { file, entry } = await worker(), crashed = await run(entry, file, 'crash');
  expect(crashed.signal).toBe('SIGKILL');
  const store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' }); cleanup.push(() => store.close());
  expect((await store.lookupRequest('one'))?.head.sequence).toBe(1); expect((await store.readPage()).scanned).toBe(1);
}, 10000);


it('waits for a short writer lock while configuring a new connection', async () => {
  const files = logDirectory();
  cleanup.push(files.cleanup);
  const options = { databasePath: files.file, systemId: 'fixture', busyTimeoutMs: 2000 };
  new SqliteRunLogStore(options).close();
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
  `, files.file], {stdio:['ignore','pipe','ignore']});
  const exited = once(holder, 'close');
  try {
    await once(holder.stdout, 'data');
    const reader = new SqliteRunLogStore(options);
    try { expect((await reader.readPage()).scanned).toBe(0); } finally { reader.close(); }
  } finally { holder.kill(); await exited; }
});
