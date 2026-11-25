import { describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/session/session.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import type { ControlSessionHandle } from '../../src/session/control-session.js';

const adapter: ExecAdapter = {
  id: 'claude', detect: async () => ({ installed: true }),
  auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [],
  execute: async () => { throw new Error('must not dispatch exec'); },
};

describe('control settlement boundary', () => {
  it('rejects exec settlement mode on every control turn entry before native dispatch', async () => {
    const startTurn = vi.fn(async () => { throw new Error('must not dispatch'); });
    const control: ControlSessionHandle = {
      transportEpoch: 'test-epoch', identity: undefined, state: () => 'active', startTurn,
      respond: async () => {}, fork: async () => { throw new Error('must not fork'); }, close: async () => {},
    };
    const session = new Session({
      adapter, control, model: { id: 'opus-5', provider: 'claude', aliases: [], source: 'explicit', availability: 'available' },
      cwd: process.cwd(), transport: 'control', persistence: 'provider',
      contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {},
    });
    const options = { awaitSettlement: true };
    await expect(session.send('x', options)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(() => session.start('x', options)).toThrow(/awaitSettlement/);
    await expect(session.stream('x', options)[Symbol.asyncIterator]().next()).rejects.toThrow(/awaitSettlement/);
    await expect(session.runOneShot('x', options)).rejects.toThrow(/awaitSettlement/);
    expect(startTurn).not.toHaveBeenCalled();
    expect(session.state).toBe('idle');
    await session.close();
  });
});
