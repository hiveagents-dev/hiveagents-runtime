import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalizedInputs = new Set(['apps/document-triage/package.json', 'apps/document-triage/package-lock.json']);
/** Only npm-normalized app inputs may differ, and only when equal to the installed consumer. */
export function assertRoutingSource(packed, current, installed) {
  for (const source of [packed, current]) {
    assert.equal(hash(JSON.stringify(source.files)), source.sourceManifestSha256, 'Invalid source manifest');
    assert.equal(new Set(source.files.map(file => file.path)).size, source.files.length, 'Duplicate source input');
  }
  const before = new Map(packed.files.map(file => [file.path, file.sha256]));
  const after = new Map(current.files.map(file => [file.path, file.sha256]));
  const normalized = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) === after.get(path)) continue;
    assert.ok(before.has(path) && after.has(path) && normalizedInputs.has(path)
      && typeof installed[path] === 'string' && installed[path] === after.get(path), `Source changed since artifact build: ${path}`);
    normalized.push(path);
  }
  return normalized.sort();
}
/** A retained fixture is executable evidence input, even though it is outside app dist/. */
export async function assertRoutingFixtures(source, consumer) {
  const files = new Map(source.files.map(file => [file.path, file.sha256]));
  for (const name of ['fake-gemini.mjs', 'fake-antigravity.mjs']) {
    const expected = files.get(`apps/document-triage/tests/fixtures/${name}`);
    assert.ok(expected, `Missing fixture source ${name}`);
    assert.equal(hash(await readFile(join(consumer, 'tests/fixtures', name))), expected, `Fixture differs from artifact source: ${name}`);
  }
}
