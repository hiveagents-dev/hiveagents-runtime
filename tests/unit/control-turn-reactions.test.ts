import v8 from 'node:v8';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import type { ExecAdapter } from '../../src/adapters/provider.js';
import { resolveModel } from '../../src/core/models.js';
import { Session } from '../../src/session/session.js';
import type { ControlSessionHandle, ControlTurnHandle } from '../../src/session/control-session.js';

// Vitest does not run with --expose-gc; V8 lets us turn the flag on at runtime
// and reach the collector through a fresh context. Measurements are of
// retained heap after a full collection, so they are stable across runs.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const EVENTS = 100_000;

function fakeControl(onLastEvent: () => void): ControlSessionHandle {
  return {
    transportEpoch: 'epoch',
    identity: undefined,
    state: () => 'active',
    async startTurn(): Promise<ControlTurnHandle> {
      const stream = (async function* () {
        yield { kind: 'session' as const, sessionId: 'sid' };
        for (let i = 0; i < EVENTS; i++) {
          yield { kind: 'event' as const, event: { type: 'message.delta' as const, text: 'a' } };
          if (i === EVENTS - 1) onLastEvent();
        }
        yield {
          kind: 'result' as const,
          result: {
            completed: true, failed: false, refused: false, sessionId: 'sid', text: 'ok', events: [], nativeEvents: [],
          },
        };
      })();
      return { stream, interrupt: async () => ({ requested: true, terminal: 'completed' }) };
    },
    respond: async () => undefined,
    fork: async () => { throw new Error('unused'); },
    close: async () => undefined,
  };
}

const adapter: ExecAdapter = {
  id: 'claude',
  detect: async () => ({ installed: true }),
  auth: async () => ({ authenticated: true, source: 'unknown' }),
  models: async () => [],
  execute: async () => { throw new Error('unused'); },
};

describe('streamControlTurn cancellation reactions (R9)', () => {
  it('retains one cancellation reaction for the whole turn, not one per event', async () => {
    let atLastEvent = 0;
    const session = new Session({
      adapter,
      model: resolveModel('sonnet'),
      cwd: process.cwd(),
      transport: 'control',
      persistence: 'process',
      control: fakeControl(() => { gc(); atLastEvent = process.memoryUsage().heapUsed; }),
      negotiated: {},
      contextArgs: [],
      permissionArgs: [],
      env: {},
      warnings: [],
      features: {},
    });
    gc();
    const base = process.memoryUsage().heapUsed;

    let count = 0;
    for await (const _event of session.stream('hi')) count++;

    const bytesPerEvent = (atLastEvent - base) / EVENTS;
    expect(count).toBe(EVENTS + 2);
    // Before the fix every event left a `lifecycle.cancelled.then` reaction
    // behind: ~555 B per event (53 MiB at 100k). What remains is the turn's
    // own event list, which the completed Turn carries by design.
    expect(bytesPerEvent).toBeLessThan(150);
  }, 60_000);
});
