import assert from 'node:assert/strict';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';

const sanitize = value => value.replace(/AIza[A-Za-z0-9_-]{20,}/g, '[redacted]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');

async function reserveLaunch(counterPath) {
  // Contention fails closed; no waiting or implicit retry can launch a model.
  const lockPath = counterPath + '.reservation';
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = counterPath + `.${process.pid}.next`;
  try {
    const count = JSON.parse(await readFile(counterPath, 'utf8'));
    assert.ok(Number.isInteger(count) && count >= 0 && count < 4, 'Live model launch limit reached');
    await writeFile(temporary, JSON.stringify(count + 1), { mode: 0o600 });
    await rename(temporary, counterPath);
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** The caller supplies runProcess from the independently installed public SDK. */
export async function superviseNative(options) {
  const { target, args, counterPath, diagnosticPath, runner, cwd, env, signal } = options;
  const prompt = args.some(arg => ['--prompt', '--print', '-p'].some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (prompt) await reserveLaunch(counterPath);
  let stderr = '';
  let diagnostic;
  try {
    const result = await runner({
      command: target.command, args: [...target.argsPrefix, ...args], cwd, env,
      stdin: '', timeoutMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576, signal,
      // Finish killing the detached native group before the outer SDK kills
      // this wrapper after its own 100ms grace period.
      killGraceMs: options.killGraceMs ?? 10,
      onStdout: options.stdout,
      onStderr(chunk) {
        stderr = (stderr + Buffer.from(chunk).toString('utf8')).slice(-8000);
        options.stderr?.(chunk);
      },
    });
    diagnostic = { exitCode: result.code, signal: result.signal };
    return result;
  } catch (error) {
    diagnostic = { error: error.code ?? 'SUPERVISOR_ERROR' };
    throw error;
  } finally {
    if (prompt) await writeFile(diagnosticPath,
      JSON.stringify({ ...diagnostic, stderr: sanitize(stderr) }, null, 2), { mode: 0o600 });
  }
}
