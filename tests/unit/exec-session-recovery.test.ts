import { describe, expect, it } from 'vitest';

import type { ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { resolveModel } from '../../src/core/models.js';
import { NotAuthenticatedError, ProtocolError, UnsupportedCapabilityError } from '../../src/public/errors.js';
import { Session } from '../../src/session/session.js';
import type { SessionConfig } from '../../src/session/config.js';

// R4: a request that fails validation (unsupported input, bad timeout) was
// evaluated inside the execute try/catch, so the session went `failed` for
// good although the CLI never ran; and forkAndSend turned any execute()
// failure (CLI missing, not authenticated) into a generic ProtocolError that
// poisoned the parent session.

function ok(sessionId: string): ProtocolResult {
  return { completed: true, failed: false, refused: false, sessionId, text: 'ok', events: [], nativeEvents: [] };
}

class RecordingAdapter implements ExecAdapter {
  readonly id = 'claude' as const;
  readonly requests: ExecTurnRequest[] = [];
  executeImpl: (request: ExecTurnRequest) => Promise<ProtocolResult> = async (request) => ok(
    request.mode === 'fork' ? 'child-id' : request.sessionId ?? 'parent-id',
  );

  async detect() { return { installed: true }; }
  async auth() { return { authenticated: true, source: 'unknown' as const }; }
  async models() { return []; }
  async execute(request: ExecTurnRequest) {
    this.requests.push(request);
    return this.executeImpl(request);
  }

  async *stream(request: ExecTurnRequest) {
    this.requests.push(request);
    yield { kind: 'result' as const, result: await this.executeImpl(request) };
  }
}

function session(adapter: ExecAdapter, overrides: Partial<SessionConfig> = {}): Session {
  return new Session({
    adapter,
    model: resolveModel('sonnet'),
    cwd: process.cwd(),
    transport: 'exec',
    persistence: 'provider',
    contextArgs: [],
    permissionArgs: [],
    env: {},
    warnings: [],
    features: {},
    ...overrides,
  });
}

describe('exec session stays usable after a request that never reached the CLI', () => {
  it('send(): an unsupported input leaves the session idle and the next turn runs', async () => {
    const adapter = new RecordingAdapter();
    const current = session(adapter);
    await current.send('hello');

    await expect(current.send([{ type: 'image', data: 'x', mediaType: 'image/png' } as never]))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(current.state).toBe('idle');
    expect(adapter.requests).toHaveLength(1);

    await expect(current.send('hello again')).resolves.toMatchObject({ status: 'completed' });
    expect(adapter.requests).toHaveLength(2);
  });

  it('send(): an invalid timeoutMs leaves the session idle and the adapter untouched', async () => {
    const adapter = new RecordingAdapter();
    const current = session(adapter);

    await expect(current.send('hi', { timeoutMs: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(current.state).toBe('idle');
    expect(adapter.requests).toHaveLength(0);
    await expect(current.send('hi', { timeoutMs: 1_000 })).resolves.toMatchObject({ status: 'completed' });
  });

  it('start(): an unsupported input rejects the handle and leaves the session idle', async () => {
    const adapter = new RecordingAdapter();
    const current = session(adapter);

    expect(() => current.start([{ type: 'file', path: '/x' } as never])).toThrow(UnsupportedCapabilityError);
    expect(current.state).toBe('idle');
    await expect(current.start('ok').result).resolves.toMatchObject({ status: 'completed' });
  });

  it('stream(): an unsupported input leaves the session idle', async () => {
    const adapter = new RecordingAdapter();
    const current = session(adapter);

    const drain = async (): Promise<void> => {
      for await (const _event of current.stream([{ type: 'image', data: 'x' } as never])) { /* nothing */ }
    };
    await expect(drain()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(current.state).toBe('idle');
    expect(adapter.requests).toHaveLength(0);
    await expect(current.send('ok')).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('forkAndSend maps the provider failure and keeps the parent usable', () => {
  it('a not-authenticated CLI yields NOT_AUTHENTICATED and the parent stays idle', async () => {
    const adapter = new RecordingAdapter();
    const parent = session(adapter);
    await parent.send('hello');
    adapter.executeImpl = async () => ({
      completed: false,
      failed: true,
      refused: false,
      text: '',
      events: [],
      nativeEvents: [],
      failure: { kind: 'not-authenticated', message: 'Not logged in' },
    });

    await expect(parent.forkAndSend('branch')).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(parent.state).toBe('idle');
    expect(parent.ref?.id).toBe('parent-id');

    adapter.executeImpl = async (request) => ok(request.sessionId ?? 'parent-id');
    await expect(parent.send('still works')).resolves.toMatchObject({ status: 'completed' });
  });

  it('a fork that returns the parent id is still a protocol error, without poisoning the parent', async () => {
    const adapter = new RecordingAdapter();
    const parent = session(adapter);
    await parent.send('hello');
    adapter.executeImpl = async () => ok('parent-id');

    await expect(parent.forkAndSend('branch')).rejects.toBeInstanceOf(ProtocolError);
    expect(parent.state).toBe('idle');
  });

  it('a confirmed child with a failed first turn is still returned', async () => {
    const adapter = new RecordingAdapter();
    const parent = session(adapter);
    await parent.send('hello');
    adapter.executeImpl = async () => ({
      ...ok('child-id'),
      completed: false,
      failed: true,
      failure: { kind: 'provider-unavailable', message: 'boom' },
    });

    const fork = await parent.forkAndSend('branch');
    expect(fork.session.ref?.id).toBe('child-id');
    expect(fork.turn.status).toBe('failed');
    expect(parent.state).toBe('idle');
  });

  it('an unsupported fork input never reaches the adapter and leaves the parent idle', async () => {
    const adapter = new RecordingAdapter();
    const parent = session(adapter);
    await parent.send('hello');

    await expect(parent.forkAndSend([{ type: 'image', data: 'x' } as never]))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(parent.state).toBe('idle');
    expect(adapter.requests).toHaveLength(1);
  });
});
