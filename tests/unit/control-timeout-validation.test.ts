import { describe, expect, it } from 'vitest';

import type { ExecAdapter } from '../../src/adapters/provider.js';
import { resolveModel } from '../../src/core/models.js';
import { ControlTurnLifecycle } from '../../src/session/control-lifecycle.js';
import type { ControlSessionHandle } from '../../src/session/control-session.js';
import { Session } from '../../src/session/session.js';

// R10 (control path): the lifecycle accepted any positive safe integer, so a
// deadline in 2^31..2^53 reached setTimeout, which Node clamps to 1 ms — the
// turn timed out at once. Aligned with the exec path: integer in 1..2^31-1.

const adapter: ExecAdapter = {
  id: 'claude',
  detect: async () => ({ installed: true }),
  auth: async () => ({ authenticated: true, source: 'unknown' }),
  models: async () => [],
  execute: async () => { throw new Error('unused'); },
};

function controlThatMustNotStart(): ControlSessionHandle & { starts: number } {
  return {
    starts: 0,
    transportEpoch: 'epoch',
    identity: undefined,
    state: () => 'active',
    async startTurn() {
      this.starts += 1;
      throw new Error('startTurn must not be reached with an invalid deadline');
    },
    respond: async () => undefined,
    fork: async () => { throw new Error('unused'); },
    close: async () => undefined,
  };
}

function sessionFor(control: ControlSessionHandle): Session {
  return new Session({
    adapter, model: resolveModel('sonnet'), cwd: process.cwd(), transport: 'control', persistence: 'process',
    control, negotiated: {}, contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {},
  });
}

describe('control timeoutMs validation', () => {
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31, 2 ** 53 - 1])(
    'rejects %s with a RangeError before the provider sees a turn',
    (timeoutMs) => {
      expect(() => new ControlTurnLifecycle('claude', { timeoutMs })).toThrow(RangeError);
      const control = controlThatMustNotStart();
      const session = sessionFor(control);
      expect(() => session.start('hi', { timeoutMs })).toThrow(RangeError);
      expect(control.starts).toBe(0);
    },
  );

  it.each([1, 86_400_000, 2 ** 31 - 1])('accepts %s', (timeoutMs) => {
    const lifecycle = new ControlTurnLifecycle('claude', { timeoutMs });
    expect(lifecycle.error).toBeUndefined();
    lifecycle.dispose();
  });

  it('defaults to ten minutes when omitted', () => {
    const lifecycle = new ControlTurnLifecycle('claude', {});
    expect(lifecycle.error).toBeUndefined();
    lifecycle.dispose();
  });
});
