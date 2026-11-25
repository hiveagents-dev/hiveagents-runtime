import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorkflowScript } from '../../src/orchestration/dynamic/engine.js';
import {
  DynamicJournalCorruptError, DynamicJournalLockedError, fileDynamicJournal, memoryDynamicJournal, validateDynamicRunId,
} from '../../src/orchestration/dynamic/journal.js';
import type { DynamicAgentResult, DynamicWorkflowContext, JsonValue } from '../../src/orchestration/dynamic/types.js';
import { fakeRunner, meta } from './dynamic-engine-fixture.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'oar-dynamic-journal-'));
  directories.push(dir);
  return dir;
}
const record = (key: string, output: DynamicAgentResult['output'] = `out-${key}`): DynamicAgentResult =>
  ({ key, status: 'completed', output, durationMs: 1, cached: false });

describe('dynamic workflow journals', () => {
  it('validates run ids', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a b', 'x'.repeat(129), 7]) expect(() => validateDynamicRunId(bad)).toThrow(TypeError);
    expect(validateDynamicRunId('run-1.2_3')).toBe('run-1.2_3');
  });

  it('memory journal stores copies and allows one open writer per run', async () => {
    const journal = memoryDynamicJournal();
    const original = record('k1', { list: [1] });
    await journal.put('r', original);
    (original.output as { list: number[] }).list.push(2);
    expect((await journal.get('r', 'k1'))?.output).toEqual({ list: [1] });
    await journal.open('r');
    await expect(journal.open('r')).rejects.toBeInstanceOf(DynamicJournalLockedError);
    await journal.close('r');
    await journal.open('r');
    await expect(journal.put('r', { ...record('k2'), status: 'done' } as never)).rejects.toThrow(TypeError);
  });

  it('file journal appends with checksums and replays across instances', async () => {
    const dir = await directory();
    const first = fileDynamicJournal(dir);
    await first.open('run');
    await first.put('run', record('k1'));
    await first.put('run', record('k2', { nested: ['x'] }));
    await first.close('run');
    const lines = (await readFile(join(dir, 'run.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ format: 1, runId: 'run', record: { key: 'k1' } });
    expect(lines[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    const second = fileDynamicJournal(dir);
    await second.open('run');
    expect(await second.get('run', 'k2')).toEqual(record('k2', { nested: ['x'] }));
    expect(await second.get('run', 'missing')).toBeUndefined();
    await second.close('run');
  });

  it('ignores and truncates a torn last line, then appends cleanly', async () => {
    const dir = await directory();
    const journal = fileDynamicJournal(dir);
    await journal.put('run', record('k1'));
    await journal.close('run');
    await appendFile(join(dir, 'run.jsonl'), '{"checksum":"abc","format":1,"rec');
    await journal.open('run');
    expect(await journal.get('run', 'k1')).toBeDefined();
    await journal.put('run', record('k2'));
    await journal.close('run');
    const text = await readFile(join(dir, 'run.jsonl'), 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    const reopened = fileDynamicJournal(dir);
    await reopened.open('run');
    expect(await reopened.get('run', 'k2')).toBeDefined();
    await reopened.close('run');
  });

  it('refuses a run whose journal is corrupt before its last line', async () => {
    const dir = await directory();
    const journal = fileDynamicJournal(dir);
    await journal.put('run', record('k1'));
    await journal.put('run', record('k2'));
    await journal.close('run');
    const path = join(dir, 'run.jsonl');
    const lines = (await readFile(path, 'utf8')).split('\n');
    lines[0] = lines[0]!.replace('out-k1', 'out-XX');
    await writeFile(path, lines.join('\n'));
    const error = await fileDynamicJournal(dir).open('run').catch(caught => caught);
    expect(error).toBeInstanceOf(DynamicJournalCorruptError);
    expect(error.line).toBe(1);
    await expect(runWorkflowScript(meta, async () => null, { runId: 'run', runner: fakeRunner().runner, journal: fileDynamicJournal(dir) }))
      .rejects.toBeInstanceOf(DynamicJournalCorruptError);
  });

  it('allows one writer per run and releases the lock on close', async () => {
    const dir = await directory();
    const first = fileDynamicJournal(dir);
    const second = fileDynamicJournal(dir);
    await first.open('run');
    await expect(second.open('run')).rejects.toBeInstanceOf(DynamicJournalLockedError);
    await expect(first.open('run')).rejects.toBeInstanceOf(DynamicJournalLockedError);
    await expect(runWorkflowScript(meta, async () => null, { runId: 'run', runner: fakeRunner().runner, journal: second }))
      .rejects.toBeInstanceOf(DynamicJournalLockedError);
    expect((await first.inspectOwner('run'))?.pid).toBe(process.pid);
    await first.close('run');
    expect(await first.inspectOwner('run')).toBeUndefined();
    await second.open('run');
    await second.close('run');
  });

  it('recovers an abandoned lock only explicitly, for a dead owner on this host', async () => {
    const dir = await directory();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const token = '00000000-0000-4000-8000-000000000000';
    const lock = (pid: number) => JSON.stringify({ format: 1, runId: 'run', token, pid, host: hostname() });
    const journal = fileDynamicJournal(dir);
    await writeFile(join(dir, 'run.lock'), lock(process.pid));
    await expect(journal.recoverAbandoned('run', token, { ownerStopped: true })).rejects.toThrow(/alive/);
    await writeFile(join(dir, 'run.lock'), lock(dead));
    await expect(journal.open('run')).rejects.toBeInstanceOf(DynamicJournalLockedError);
    await expect(journal.recoverAbandoned('run', token, undefined as never)).rejects.toThrow(/acknowledge/);
    await expect(journal.recoverAbandoned('run', 'other', { ownerStopped: true })).rejects.toThrow(/token/);
    await journal.recoverAbandoned('run', token, { ownerStopped: true });
    await journal.open('run');
    await expect(fileDynamicJournal(dir).recoverAbandoned('run', token, { ownerStopped: true })).rejects.toThrow(/token/);
    await journal.close('run');
  });

  it('resumes an engine run from the file journal in a new journal instance', async () => {
    const dir = await directory();
    const script = async (context: DynamicWorkflowContext) => context.pipeline(['a', 'b'], (item: string) => context.agent(item)) as Promise<JsonValue>;
    const failing = fakeRunner(request => {
      if (request.prompt === 'b') throw new Error('nope');
      return { text: `one:${request.prompt}` };
    });
    const first = await runWorkflowScript(meta, script, { runId: 'resume', runner: failing.runner, journal: fileDynamicJournal(dir) });
    expect(first.result).toEqual(['one:a', null]);
    const second = fakeRunner(request => ({ text: `two:${request.prompt}` }));
    const resumed = await runWorkflowScript(meta, script, { runId: 'resume', runner: second.runner, journal: fileDynamicJournal(dir) });
    expect(second.prompts).toEqual(['b']);
    expect(resumed.result).toEqual(['one:a', 'two:b']);
    expect(await fileDynamicJournal(dir).inspectOwner('resume')).toBeUndefined();
  });
});
