import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTarball } from './verify-package-contents.mjs';
import { sourceIdentity } from './source-state.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'oar-first-delivery-'));

function run(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OAR_LIVE: '0', OAR_LIVE_TURNS: '0' },
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function pack(cwd) {
  const output = run('npm', ['pack', '--json', '--pack-destination', temporary], cwd);
  // npm may forward prepack build logs before its final JSON array.
  const [artifact] = JSON.parse(output.slice(output.lastIndexOf('\n[') + 1));
  const path = join(temporary, artifact.filename);
  verifyTarball(path);
  return path;
}

try {
  const source = await sourceIdentity(root);
  const coreTarball = pack(root);
  const artifacts = resolve(root, process.env.OAR_ARTIFACT_DIR ?? '.artifacts/first-delivery');
  await mkdir(artifacts, { recursive: true });
  await cp(coreTarball, join(artifacts, 'core.tgz'));
  const result = run(process.execPath, [join(root, 'scripts/verify-external-consumer.mjs'),
    '--core-tarball', coreTarball], root, 390_000);
  assert.equal((await sourceIdentity(root)).sourceManifestSha256, source.sourceManifestSha256, 'Source changed during artifact build/consumer validation');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const artifactSource = { kind: 'artifact-build-source', source,
    coreSha256: hash(await readFile(coreTarball)) };
  await writeFile(join(artifacts, 'artifact-source.json'), JSON.stringify(artifactSource, null, 2) + '\n');
  const receipt = { ...JSON.parse(result), artifactSourceManifestSha256: source.sourceManifestSha256 };
  const serialized = JSON.stringify(receipt, null, 2) + '\n';
  process.stdout.write(serialized);
  await writeFile(join(artifacts, 'external-receipt.json'), serialized);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
