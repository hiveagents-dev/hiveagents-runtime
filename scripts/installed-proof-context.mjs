/** Exact source, tarball and independent-consumer bindings shared by continuous proofs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { auditDependencyPaths, hashApplicationCode } from './verify-external-consumer.mjs';
import { verifyInstalledTarball } from './verify-package-contents.mjs';
import { sourceIdentity } from './source-state.mjs';
import { assertRoutingSource } from './routing-proof-inputs.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function installedProofContext(root, out, fixtureNames = []) {
  const external = JSON.parse(await readFile(join(out, 'external-receipt.json'), 'utf8'));
  const packed = JSON.parse(await readFile(join(out, 'artifact-source.json'), 'utf8'));
  assert.equal(external.passed, true);
  assert.equal(packed.kind, 'artifact-build-source');
  assert.equal(packed.source.sourceManifestSha256, external.artifactSourceManifestSha256);
  const app = await realpath(external.consumerDirectory), rel = relative(await realpath(root), app);
  assert.ok(rel === '..' || rel.startsWith(`..${sep}`), 'Consumer must be outside checkout');
  async function audit() {
    await auditDependencyPaths(app, root);
    const tarball = join(out, 'core.tgz');
    assert.equal(packed.coreSha256, external.core.sha256);
    assert.equal(sha256(await readFile(tarball)), external.core.sha256);
    verifyInstalledTarball(tarball, join(app, 'node_modules/hiveagents-runtime'));
    assert.equal(await hashApplicationCode(app), external.applicationCodeSha256);
    assert.equal(sha256(await readFile(join(app, 'package-lock.json'))), external.lockSha256);
    for (const name of fixtureNames) {
      assert.match(name, /^[a-z0-9-]+\.mjs$/);
      const expected = packed.source.files.find(file => file.path === `apps/document-triage/tests/fixtures/${name}`)?.sha256;
      assert.ok(expected, `Missing fixture in build source: ${name}`);
      assert.equal(sha256(await readFile(join(app, 'tests/fixtures', name))), expected, `Fixture changed: ${name}`);
    }
  }
  await audit();
  const before = await sourceIdentity(root);
  const normalizedAppInputs = assertRoutingSource(packed.source, before, {
    'apps/document-triage/package.json': sha256(await readFile(join(app, 'package.json'))),
    'apps/document-triage/package-lock.json': external.lockSha256,
  });
  return { app, external, packed, bindings: {
    artifactBuildDigest: packed.source.sourceManifestSha256, proofSourceDigest: before.sourceManifestSha256,
    inputCount: before.files.length, normalizedAppInputs, coreSha256: external.core.sha256,
    applicationCodeSha256: external.applicationCodeSha256, lockSha256: external.lockSha256,
  }, async assertUnchanged() {
    await audit();
    assert.equal((await sourceIdentity(root)).sourceManifestSha256, before.sourceManifestSha256, 'Source changed during proof');
  } };
}
