import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

/** A study is single-use, including interrupted attempts; no automatic capacity respend. */
export async function claimLearningStudy(directory, record, names = {}) {
  const start = names.startFile ?? 'learning-live.start.json', receipt = names.receiptFile ?? 'learning-live.json';
  for (const name of [start, receipt]) if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}\.json(?![\s\S])/.test(name)) throw new TypeError('Invalid study claim filename');
  if (start === receipt) throw new TypeError('Study start and receipt must differ');
  const path = join(directory, start);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  try { await lstat(join(directory, receipt)); }
  catch (error) { if (error.code === 'ENOENT') return path; throw error; }
  throw new Error('A completed live study already exists; no model dispatch authorized');
}
