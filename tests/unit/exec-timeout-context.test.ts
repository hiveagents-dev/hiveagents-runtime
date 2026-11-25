import { describe, expect, it } from 'vitest';

import type { ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { Session } from '../../src/session/session.js';

describe('exec stream timeout context', () => {
  for (const provider of ['claude', 'codex', 'external-fixture']) {
    it(`retains ${provider} when its stream deadline cancels pending work`, async () => {
      let signal: AbortSignal | undefined;
      let inferenceStarts = 0;
      let streamClosed = false;
      const adapter: ExecAdapter = {
        id: provider,
        detect: async () => ({ installed: true }),
        auth: async () => ({ authenticated: true, source: 'subscription' }),
        models: async () => [],
        execute: async (): Promise<ProtocolResult> => {
          inferenceStarts++;
          return { completed: true, failed: false, refused: false, text: '', events: [], nativeEvents: [] };
        },
        stream: async function* (request: ExecTurnRequest) {
          signal = request.signal!;
          try {
            // Only the session deadline can release this pending prerequisite.
            await new Promise<void>((resolve) => {
              signal!.addEventListener('abort', () => resolve(), { once: true });
            });
            if (signal.aborted) return;
            yield { kind: 'result' as const, result: await adapter.execute(request) };
          } finally {
            streamClosed = true;
          }
        },
      };
      const session = new Session({
        adapter,
        model: { id: 'fixture-model', provider, aliases: [], source: 'explicit', availability: 'available' },
        cwd: process.cwd(),
        transport: 'exec',
        persistence: 'provider',
        contextArgs: [],
        permissionArgs: [],
        env: {},
        warnings: [],
        features: {},
      });
      try {
        const events = session.stream('wait before inference', { timeoutMs: 30 });
        await expect(events[Symbol.asyncIterator]().next())
          .rejects.toMatchObject({ code: 'TIMEOUT', context: { provider, transport: 'exec', retryable: true } });
        expect(signal?.aborted).toBe(true);
        expect(streamClosed).toBe(true);
        expect(inferenceStarts).toBe(0);
      } finally {
        await session.close();
      }
    });
  }
});
