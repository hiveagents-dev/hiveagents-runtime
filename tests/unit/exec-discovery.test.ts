import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';

describe.skipIf(process.platform === 'win32')('healthy CLI selection', () => {
  it('skips a failing shim, binds auth to the healthy installation and respects explicit targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oar-discovery-'));
    try {
      const bad = join(dir, 'stale'), good = join(dir, 'native');
      await Promise.all([mkdir(bad), mkdir(good)]);
      for (const provider of ['claude', 'codex']) {
        for (const [directory, content] of [[bad, '#!/bin/sh\necho "native binary is not installed" >&2\nexit 1\n'],
          [good, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.228"; else echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; fi\n']]) {
          await writeFile(join(directory!, provider), content!); await chmod(join(directory!, provider), 0o755);
        }
        const adapter = provider === 'claude' ? new ClaudeExecAdapter() : new CodexExecAdapter();
        const env = { PATH: [bad, good].join(delimiter) };
        expect(await adapter.detect(env)).toMatchObject({ installed: true, path: await realpath(join(good, provider)), version: '2.1.228' });
        if (provider === 'claude') expect(await adapter.auth(env)).toMatchObject({ authenticated: true, source: 'subscription' });
        const explicit = new ClaudeExecAdapter({ target: { command: join(bad, provider), argsPrefix: [] } });
        expect(await explicit.detect(env)).toEqual({ installed: false });
        expect(await adapter.detect({ PATH: bad })).toEqual({ installed: false });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps a prerelease suffix so it never matches a stable manifest range', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oar-discovery-pre-'));
    try {
      for (const [output, version] of [['codex-cli 0.153.5-alpha.1', '0.153.5-alpha.1'], ['codex-cli 0.153.4', '0.153.4'], ['2.1.228 (Claude Code)', '2.1.228']]) {
        await writeFile(join(dir, 'codex'), `#!/bin/sh\necho "${output}"\n`); await chmod(join(dir, 'codex'), 0o755);
        expect(await new CodexExecAdapter().detect({ PATH: dir })).toMatchObject({ installed: true, version });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
