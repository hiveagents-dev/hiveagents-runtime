import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const helper = await import(pathToFileURL(resolve('scripts/routing-proof-inputs.mjs')).href);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function source(entries: Record<string, string>) {
  const files = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
  return { files, sourceManifestSha256: hash(JSON.stringify(files)) };
}
it('rejects stale or inconsistent pack-time inputs instead of attributing old artifacts to current source', () => {
  const packed = source({ 'src/index.ts': hash('old') });
  expect(() => helper.assertRoutingSource(packed, source({ 'src/index.ts': hash('new') }), {})).toThrow(/Source changed/);
  expect(() => helper.assertRoutingSource(packed, source({ 'src/index.ts': hash('old'), 'src/new.ts': hash('new') }), {})).toThrow(/Source changed/);
  expect(() => helper.assertRoutingSource({ ...packed, sourceManifestSha256: '0'.repeat(64) }, packed, {})).toThrow(/manifest/);
});
it('allows only app manifest/lock normalization to the exact independently installed input hashes', () => {
  const name = 'apps/document-triage/package-lock.json', old = hash('old lock'), next = hash('installed lock');
  const packed = source({ [name]: old }), current = source({ [name]: next });
  expect(helper.assertRoutingSource(packed, current, { [name]: next })).toEqual([name]);
  expect(() => helper.assertRoutingSource(packed, current, { [name]: old })).toThrow(/Source changed/);
  expect(() => helper.assertRoutingSource(packed, source({}), {})).toThrow(/Source changed/);
  expect(() => helper.assertRoutingSource(source({ 'src/index.ts': old }), source({ 'src/index.ts': next }), { 'src/index.ts': next })).toThrow(/Source changed/);
});
it('verifies retained fixture bytes against pack-time source before invoking them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-proof-fixtures-'));
  try {
    await mkdir(join(dir, 'tests/fixtures'), { recursive: true });
    const entries: Record<string, string> = {};
    for (const name of ['fake-gemini.mjs', 'fake-antigravity.mjs']) {
      await writeFile(join(dir, 'tests/fixtures', name), name);
      entries[`apps/document-triage/tests/fixtures/${name}`] = hash(name);
    }
    await helper.assertRoutingFixtures(source(entries), dir);
    await writeFile(join(dir, 'tests/fixtures/fake-gemini.mjs'), 'changed');
    await expect(helper.assertRoutingFixtures(source(entries), dir)).rejects.toThrow(/Fixture differs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
