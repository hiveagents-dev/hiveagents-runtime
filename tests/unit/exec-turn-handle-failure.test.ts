import { describe, expect, it } from 'vitest';
import { startExecTurn } from '../../src/session/exec-turn.js';
import { AbortError, UsageLimitError } from '../../src/public/errors.js';
import type { SessionConfig } from '../../src/session/config.js';
import type { Turn } from '../../src/public/types.js';

const config = { adapter: { id: 'codex' }, transport: 'exec' } as SessionConfig;

describe('exec turn handle failure channels', () => {
  for (const error of [
    new UsageLimitError({ retryable: false }),
    new AbortError({ retryable: false }),
  ]) {
    it(`keeps ${error.code} on result/events without rejecting the optional turn id`, async () => {
      const handle = startExecTurn(config, async () => { throw error; }, () => 'failed', {});
      // Observe both in the regression test so a broken candidate cannot crash the test runner.
      const [result, id] = await Promise.allSettled([handle.result, handle.turnId]);
      expect(result).toEqual({ status: 'rejected', reason: error });
      expect(id).toEqual({ status: 'fulfilled', value: undefined });
      const events = handle.events[Symbol.asyncIterator]();
      await expect(events.next()).rejects.toBe(error);
    });
  }

  for (const id of ['turn-1', undefined]) {
    it(`preserves a successful turn ${id ? 'with' : 'without'} a provider id`, async () => {
      const turn = { ...(id ? { id } : {}), events: [], status: 'completed' } as unknown as Turn;
      const handle = startExecTurn(config, async () => turn, () => 'idle', {});
      await expect(handle.turnId).resolves.toBe(id);
      await expect(handle.result).resolves.toBe(turn);
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(events).toEqual([{ type: 'turn.completed', turn }]);
    });
  }
});
