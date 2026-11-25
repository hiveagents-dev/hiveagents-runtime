import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CODEX_STDERR_TAIL_BYTES,
  CodexAppServerSupervisor,
} from '../../src/adapters/codex-control/supervisor.js';

const fakeServer = fileURLToPath(new URL('../fixtures/codex-control/fake-app-server.mjs', import.meta.url));

describe('CodexAppServerSupervisor stderr drain', () => {
  it('keeps reading a stderr flood far above the pipe buffer so the handshake and a turn complete', async () => {
    // The fake writes 2 MiB to stderr and answers only once the pipe accepted
    // it; an undrained stderr would leave both answers blocked forever.
    const supervisor = await CodexAppServerSupervisor.start({
      command: process.execPath,
      args: [fakeServer, 'stderr-flood'],
      cwd: process.cwd(),
      env: process.env,
      experimentalApi: false,
      closeGraceMs: 60,
    });
    try {
      await expect(supervisor.connection.request('turn/start', { threadId: 't1' }))
        .resolves.toEqual({ ok: true });

      // Only a bounded private tail survives, ending with the newest bytes.
      const tail = supervisor.stderrTail();
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(CODEX_STDERR_TAIL_BYTES);
      expect(Buffer.byteLength(tail)).toBeGreaterThan(CODEX_STDERR_TAIL_BYTES / 2);
      expect(tail.endsWith('flood-2-end\n')).toBe(true);
      expect(tail).not.toContain('flood-1-end');
    } finally {
      await supervisor.shutdown();
    }
  }, 15_000);
});
