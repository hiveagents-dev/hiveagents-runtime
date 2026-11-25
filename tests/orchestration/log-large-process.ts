import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export async function largeReader(directory: string, file: string, artifacts: string, counter: string, mode: string): Promise<{ status: string; digest: string; intentId?: string }> {
  const entry = join(directory, 'large-reader.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./log-store-fixtures/large-reader.ts', import.meta.url))], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, file, artifacts, counter, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', bytes => { output += String(bytes); if (output.length > 4096) child.kill('SIGKILL'); }); child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (code !== 0 || signal) reject(Error('owned large reader failed')); else resolve(output); });
  });
  return JSON.parse(text);
}
