import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const rootFiles = new Set(['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'tsconfig.json', 'tsup.config.ts', 'vitest.config.ts']);
const prefixes = ['src/', 'tests/', 'scripts/', 'examples/', 'packages/', '.github/', 'docs/licenses/', 'docs/releases/',
  'apps/document-triage/'];

export function isSourceInput(path) {
  if (/(?:^|\/)(?:node_modules|dist|dist-electron|\.artifacts|\.env(?:\.[^/]*)?|\.git)(?:\/|$)/.test(path)) return false;
  return rootFiles.has(path) || prefixes.some(prefix => path.startsWith(prefix));
}

export async function sourceIdentity(root) {
  root = await realpath(root);
  const listing = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  assert.equal(listing.status, 0, 'Capture source from the repository checkout');
  const missing = spawnSync('git', ['ls-files', '-z', '--deleted'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 0, 'Capture tracked source deletions');
  const deleted = new Set(missing.stdout.split('\0'));
  const names = [...new Set(listing.stdout.split('\0').filter(path => path && isSourceInput(path) && !deleted.has(path)))].sort();
  const files = [];
  for (const path of names) {
    assert.ok(!/[\r\n]/.test(path), 'Source filenames must not contain line breaks');
    const file = join(root, path), info = await lstat(file);
    assert.equal(info.isSymbolicLink(), false, `Source input is a symlink: ${path}`);
    if (!info.isFile()) continue;
    const canonical = await realpath(file), inside = relative(root, canonical);
    assert.ok(inside !== '..' && !inside.startsWith(`..${sep}`), `Source escaped checkout: ${path}`);
    files.push({ path, sha256: hash(await readFile(file)) });
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, 'Cannot resolve source base commit');
  return { baseCommit: head.stdout.trim(), cleanCommit: false,
    sourceManifestSha256: hash(JSON.stringify(files)), sourceFiles: files.length, files };
}

export async function captureSourceState(root, outputDirectory) {
  root = resolve(root);
  const state = await sourceIdentity(root);
  await mkdir(outputDirectory, { recursive: true });
  const list = join(outputDirectory, 'source-inputs.txt'), archive = join(outputDirectory, 'source-snapshot.tar.gz');
  await writeFile(list, state.files.map(file => file.path).join('\n') + '\n');
  const staging = await mkdtemp(join(tmpdir(), 'oar-source-'));
  try {
    for (const file of state.files) {
      const bytes = await readFile(join(root, file.path));
      assert.equal(hash(bytes), file.sha256, `Source changed while snapshotting: ${file.path}`);
      const destination = join(staging, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: (await lstat(join(root, file.path))).mode & 0o777 });
    }
    const packed = spawnSync('tar', ['-czf', archive, '-C', staging, '-T', list], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr || 'Cannot archive source');
  } finally { await rm(staging, { recursive: true, force: true }); }
  assert.equal((await sourceIdentity(root)).sourceManifestSha256, state.sourceManifestSha256, 'Source changed during snapshot');
  state.sourceArchiveSha256 = hash(await readFile(archive));
  await writeFile(join(outputDirectory, 'source-state.json'), JSON.stringify(state, null, 2) + '\n');
  return state;
}
