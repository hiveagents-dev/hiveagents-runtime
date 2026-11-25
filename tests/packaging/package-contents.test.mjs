import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyInstalledTarball, verifyPackageContents } from '../../scripts/verify-package-contents.mjs';

const manifest = {
  exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
  bin: { fixture: './dist/cli.js' },
};

describe('packed artifacts', () => {
  it('rejects a pack that omitted generated runtime files', () => {
    expect(() => verifyPackageContents(manifest, ['package.json', 'README.md', 'LICENSE']))
      .toThrow(/dist\/index.js/);
  });

  it('checks declarations and CLI entry points as well as JavaScript', () => {
    expect(() => verifyPackageContents(manifest, ['dist/index.js', 'dist/index.d.ts', 'LICENSE']))
      .toThrow(/dist\/cli.js/);
  });

  it('requires the bundled memory license notice in the core distribution', () => {
    const core = { ...manifest, name: 'hiveagents-runtime' };
    const files = ['package.json', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js'];
    expect(() => verifyPackageContents(core, files)).toThrow(/ruflo-memory-MIT/);
    expect(() => verifyPackageContents(core, [...files, 'docs/licenses/ruflo-memory-MIT.txt'])).not.toThrow();
  });

  it('accepts a complete package and rejects source or private data', () => {
    const files = ['package.json', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/cli.js'];
    expect(() => verifyPackageContents(manifest, files)).not.toThrow();
    expect(() => verifyPackageContents(manifest, [...files, '.env'])).toThrow(/private/);
    expect(() => verifyPackageContents(manifest, [...files, 'dist/.env.local'])).toThrow(/private/);
    expect(() => verifyPackageContents(manifest, [...files, 'src/internal.ts'])).toThrow(/allowlist/);
  });

  it('rejects installed manifests that redirect otherwise identical package bytes', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'oar-installed-manifest-'));
    try {
      const installed = join(temporary, 'package');
      await mkdir(join(installed, 'dist'), { recursive: true });
      await writeFile(join(installed, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(installed, 'dist/index.js'), 'export const original = true;');
      const tarball = join(temporary, 'package.tgz');
      execFileSync('tar', ['-czf', tarball, '-C', temporary, 'package/package.json', 'package/dist/index.js']);
      verifyInstalledTarball(tarball, installed);
      await writeFile(join(installed, 'package.json'), JSON.stringify({ exports: { '.': './dist/redirected.js' } }));
      expect(() => verifyInstalledTarball(tarball, installed)).toThrow(/package.json/);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
