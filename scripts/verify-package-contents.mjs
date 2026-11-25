import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function targets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(targets);
}

/** Validate the manifest against the actual tarball inventory. */
export function verifyPackageContents(manifest, files) {
  const inventory = new Set(files);
  const required = targets(manifest.exports).concat(targets(manifest.bin));
  for (const target of required) {
    const path = target.replace(/^\.\//, '');
    assert.ok(path.startsWith('dist/') && !path.split('/').includes('..'), `Invalid export ${target}`);
    assert.ok(inventory.has(path), `Package omitted ${path}`);
  }
  assert.ok(inventory.has('LICENSE'), 'Package omitted LICENSE');
  const core = manifest.name === 'hiveagents-runtime';
  const releaseNotes = core && manifest.version?.includes('-beta.')
    ? `docs/releases/${manifest.version}.md` : undefined;
  if (core) {
    assert.ok(inventory.has('docs/licenses/ruflo-memory-MIT.txt'), 'Package omitted docs/licenses/ruflo-memory-MIT.txt');
  }
  if (releaseNotes) assert.ok(inventory.has(releaseNotes), `Package omitted ${releaseNotes}`);
  for (const path of inventory) {
    assert.ok(!/(^|\/)(?:\.env(?:\.[^/]*)?|\.claude|\.codex|\.swarm|\.git|node_modules)(?:\/|$)/.test(path)
      && !/\.(?:db|rvf)$/.test(path), `Package includes private data ${path}`);
    assert.ok(['package.json', 'README.md', 'LICENSE'].includes(path)
      || path === releaseNotes || path === 'docs/examples/quickstart-offline.mjs' || path.startsWith('dist/') || path.startsWith('docs/licenses/'), `Package exceeds allowlist ${path}`);
  }
}

function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

/** A relative link in packaged Markdown must resolve inside the published package. */
export function verifyPackageMarkdownLinks(name, text, inventory) {
  for (const [, bracketed, bare] of text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))/g)) {
    const href = bracketed ?? bare;
    if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const target = posix.normalize(posix.join(posix.dirname(name), decodeURIComponent(href.split(/[?#]/)[0])));
    assert.ok(inventory.has(target), `Package documentation link ${name} -> ${href} points outside the tarball`);
  }
}

export function verifyTarball(tarball) {
  const paths = tar(['-tzf', tarball]).trim().split('\n').map(path => path.replace(/^package\//, ''));
  const manifest = JSON.parse(tar(['-xOf', tarball, 'package/package.json']));
  verifyPackageContents(manifest, paths);
  const inventory = new Set(paths);
  for (const file of paths.filter(path => /\.md$/i.test(path))) {
    verifyPackageMarkdownLinks(file, tar(['-xOf', tarball, `package/${file}`]), inventory);
  }
  for (const file of paths.filter(path => path.endsWith('.js'))) {
    const content = tar(['-xOf', tarball, `package/${file}`]);
    for (const match of content.matchAll(/(?:from\s*|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g)) {
      const target = new URL(match[1], `file:///${file}`).pathname.slice(1);
      assert.ok(inventory.has(target), `Package omitted imported chunk ${target}`);
    }
  }
  return { name: manifest.name, files: paths.length, passed: true };
}

/** Bind installed entry-point selection, JavaScript and types to the artifact. */
export function verifyInstalledTarball(tarball, directory) {
  const files = tar(['-tzf', tarball]).trim().split('\n');
  for (const file of files.filter(path => path === 'package/package.json'
    || path.startsWith('package/dist/') && !path.endsWith('/'))) {
    const expected = spawnSync('tar', ['-xOf', tarball, file], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(expected.status, 0, 'Cannot read artifact content');
    const installed = readFileSync(join(directory, file.slice('package/'.length)));
    assert.ok(installed.equals(expected.stdout), `Installed artifact differs at ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tarball = process.argv[2];
  assert.ok(tarball, 'Usage: node scripts/verify-package-contents.mjs <tarball>');
  console.log(JSON.stringify(verifyTarball(resolve(tarball))));
}
