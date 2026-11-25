import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyInstalledTarball, verifyTarball } from './verify-package-contents.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'hiveagents-distribution-'));
const { values } = parseArgs({ options: { out: { type: 'string' }, tarball: { type: 'string' } } });
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OAR_LIVE: '0', OAR_LIVE_TURNS: '0' },
  });
  assert.equal(result.status, 0, `${command} failed\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

try {
  const filename = `${manifest.name}-${manifest.version}.tgz`;
  const tarball = values.tarball ? resolve(values.tarball) : join(temp, filename);
  if (!values.tarball) run(npm, ['pack', '--pack-destination', temp, '--silent'], root);
  const inventory = verifyTarball(tarball);
  const app = join(temp, 'consumer');
  await mkdir(app);
  await writeFile(join(app, 'package.json'), '{"name":"hiveagents-smoke","private":true,"type":"module"}\n');
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], app);
  const installed = join(app, 'node_modules', manifest.name);
  verifyInstalledTarball(tarball, installed);
  const packageJson = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, manifest.version);
  const imports = Object.keys(manifest.exports).map(key => manifest.name + key.slice(1));
  run(process.execPath, ['--input-type=module', '-e', `await Promise.all(${JSON.stringify(imports)}.map(id => import(id)))`], app);
  const example = JSON.parse(run(process.execPath, [join(installed, 'docs/examples/quickstart-offline.mjs')], app));
  assert.deepEqual(example, { status: 'completed', words: 3, model: 'local-counter/words' });
  const diagnosis = JSON.parse(run(process.execPath, [join(installed, manifest.bin[manifest.name]), 'doctor', '--share'], app));
  assert.equal(diagnosis.format, 1);
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const receipt = {
    format: 1, package: manifest.name, version: manifest.version, sha256, file: filename, files: inventory.files,
    node: process.version, platform: process.platform, architecture: process.arch, imports: imports.length,
    packagedLinks: true, externalInstallation: true, offlineTurn: example.status, shareableDoctor: true,
  };
  if (values.out) {
    const output = resolve(values.out);
    await mkdir(output, { recursive: true });
    if (tarball !== join(output, filename)) await copyFile(tarball, join(output, filename));
    await writeFile(join(output, 'distribution-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
