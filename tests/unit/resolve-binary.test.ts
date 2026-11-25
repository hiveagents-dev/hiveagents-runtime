import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveBinary } from '../../src/index.js';

describe('resolveBinary on macOS', () => {
  it.runIf(process.platform === 'darwin')('returns the canonical executable behind a Homebrew-style symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oar-resolve-'));
    try {
      const cellar = join(directory, 'Cellar');
      const bin = join(directory, 'bin');
      await Promise.all([
        mkdir(cellar, { recursive: true }),
        mkdir(bin, { recursive: true }),
      ]);
      const executable = join(cellar, 'provider');
      const link = join(bin, 'provider');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);
      await symlink(executable, link);

      expect(resolveBinary('provider', { env: { PATH: bin }, platform: 'darwin' }))
        .toEqual({ command: await realpath(executable), argsPrefix: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
