import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const { claimLearningStudy } = await import(pathToFileURL(resolve('scripts/learning-live-claim.mjs')).href);

it('allows exactly one study start across concurrent launches and retains interrupted reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-learning-claim-'));
  try {
    const attempts = await Promise.allSettled([claimLearningStudy(directory, { run: 'a' }), claimLearningStudy(directory, { run: 'b' })]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const before = await readFile(join(directory, 'learning-live.start.json'), 'utf8');
    await expect(claimLearningStudy(directory, { run: 'retry' })).rejects.toThrow();
    expect(await readFile(join(directory, 'learning-live.start.json'), 'utf8')).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('refuses to spend when a legacy finished receipt exists without a start record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-learning-claim-'));
  try {
    await writeFile(join(directory, 'learning-live.json'), '{}');
    await expect(claimLearningStudy(directory, { run: 'retry' })).rejects.toThrow(/already exists/);
    await expect(claimLearningStudy(directory, { run: 'second retry' })).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('reserves an explicit continuous-study namespace and rejects invalid filenames before writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-learning-claim-'));
  try {
    await expect(claimLearningStudy(directory, {}, { startFile: '../escape.json' })).rejects.toThrow(/filename/);
    await expect(claimLearningStudy(directory, {}, { startFile: 'escape.json\n' })).rejects.toThrow(/filename/);
    await claimLearningStudy(directory, { run: 'continuous' }, { startFile: 'continuous-live.start.json', receiptFile: 'continuous-live.json' });
    await expect(claimLearningStudy(directory, {}, { startFile: 'continuous-live.start.json', receiptFile: 'continuous-live.json' })).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
