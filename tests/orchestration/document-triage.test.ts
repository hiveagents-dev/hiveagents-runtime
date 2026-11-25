import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { runDocumentTriage } from '../../examples/document-triage/triage.ts';

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'oar-triage-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('a second domain resumes completed intake and does not spend admissions again', async () => {
  const stateDirectory = await directory();
  const paused = await runDocumentTriage({ stateDirectory, stopAfterIntake: true });
  expect(paused.status).toBe('cancelled');
  expect(paused.executedSteps).toEqual(['intake']);
  const resumed = await runDocumentTriage({ stateDirectory });
  expect(resumed.status).toBe('completed');
  expect(resumed.executedSteps.sort()).toEqual(['backups', 'network', 'report']);
  expect(resumed.admittedLaunches).toBe(2);
  expect(resumed.report).toMatchObject({ network: { sources: ['vpn'] }, backups: { sources: ['backup'] } });
  const cached = await runDocumentTriage({ stateDirectory });
  expect(cached.status).toBe('completed');
  expect(cached.executedSteps).toEqual([]);
  expect(cached.admittedLaunches).toBe(2);
  expect(cached.report).toEqual(resumed.report);
});

it('rejects a requested provider mode before creating storage without explicit turn consent', async () => {
  const stateDirectory = join(await directory(), 'unused');
  await expect(runDocumentTriage({ stateDirectory, model: 'claude/example' })).rejects.toThrow(/allowProviderTurns/);
  const { access } = await import('node:fs/promises');
  await expect(access(stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('changing the input creates a separate checkpoint rather than returning a stale report', async () => {
  const stateDirectory = await directory();
  const original = await runDocumentTriage({ stateDirectory });
  const changed = await runDocumentTriage({ stateDirectory, documents: [{ id: 'replacement', text: 'VPN acceso remoto actualizado' }] });
  expect(changed.runId).not.toBe(original.runId);
  expect(changed.executedSteps).toHaveLength(4);
  expect(changed.report).toMatchObject({ network: { sources: ['replacement'] } });
});
