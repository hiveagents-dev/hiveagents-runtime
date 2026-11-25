import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamicAgentResult } from '../../src/orchestration/dynamic/types.js';

// Fault injection on the journal's append handle: the next append writes half its bytes, then fails (as
// ENOSPC/EIO can); optionally the undo (truncate) fails too.
const fault = { write: false, truncate: false };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (!String(args[0]).endsWith('.jsonl') || args[1] !== 'a') return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'writeFile') {
          return async (data: string) => {
            if (!fault.write) return target.writeFile(data);
            fault.write = false;
            await target.writeFile(data.slice(0, Math.floor(data.length / 2)));
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          };
        }
        if (property === 'truncate') {
          return async (length?: number) => {
            if (!fault.truncate) return target.truncate(length);
            fault.truncate = false;
            throw Object.assign(new Error('i/o error'), { code: 'EIO' });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof actual.open;
  return { ...actual, open };
});

const { DynamicJournalWriteError, fileDynamicJournal } = await import('../../src/orchestration/dynamic/journal.js');

const directories: string[] = [];
afterEach(async () => {
  fault.write = fault.truncate = false;
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'oar-dynamic-journal-faults-'));
  directories.push(dir);
  return dir;
}
const record = (key: string): DynamicAgentResult => ({ key, status: 'completed', output: `out-${key}`, durationMs: 1, cached: false });

describe('file journal after a failed append', () => {
  it('cuts the fragment back, so later records stay readable and the run resumable', async () => {
    const dir = await directory();
    const journal = fileDynamicJournal(dir);
    await journal.open('run');
    await journal.put('run', record('k1'));
    fault.write = true;
    await expect(journal.put('run', record('k2'))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await journal.get('run', 'k2')).toBeUndefined();
    await journal.put('run', record('k3'));
    await journal.put('run', record('k4'));
    await journal.close('run');

    const lines = (await readFile(join(dir, 'run.jsonl'), 'utf8')).split('\n');
    expect(lines).toHaveLength(4); // three records and the final newline
    const resumed = fileDynamicJournal(dir);
    await resumed.open('run');
    expect((await resumed.get('run', 'k1'))?.output).toBe('out-k1');
    expect(await resumed.get('run', 'k2')).toBeUndefined();
    expect((await resumed.get('run', 'k3'))?.output).toBe('out-k3');
    expect((await resumed.get('run', 'k4'))?.output).toBe('out-k4');
    await resumed.close('run');
  });

  it('poisons the session when the undo fails too: every later put rejects, and reopening drops the fragment', async () => {
    const dir = await directory();
    const journal = fileDynamicJournal(dir);
    await journal.open('run');
    await journal.put('run', record('k1'));
    fault.write = true;
    fault.truncate = true;
    await expect(journal.put('run', record('k2'))).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(journal.put('run', record('k3'))).rejects.toBeInstanceOf(DynamicJournalWriteError);
    await expect(journal.put('run', record('k4'))).rejects.toThrow(/could not undo a failed append/);
    expect((await readFile(join(dir, 'run.jsonl'), 'utf8')).endsWith('\n')).toBe(false); // the fragment is still there
    await journal.close('run');

    const resumed = fileDynamicJournal(dir);
    await resumed.open('run');
    expect((await resumed.get('run', 'k1'))?.output).toBe('out-k1');
    for (const key of ['k2', 'k3', 'k4']) expect(await resumed.get('run', key)).toBeUndefined();
    await resumed.put('run', record('k3'));
    await resumed.close('run');
    const again = fileDynamicJournal(dir);
    await again.open('run');
    expect((await again.get('run', 'k3'))?.output).toBe('out-k3');
    await again.close('run');
  });
});
