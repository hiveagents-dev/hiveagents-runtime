import { describe, expect, it } from 'vitest';

import type { AdapterStreamItem, ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { BoundedQueue } from '../../src/control/bounded-queue.js';
import { AbortError, ProtocolError, SessionInterruptedError, TimeoutError, UnsupportedCapabilityError } from '../../src/public/errors.js';
import type { AgentEvent, InteractionResponse, InterruptReceipt, SessionIdentity, SessionPersistence } from '../../src/public/types.js';
import type { ControlSessionHandle, ControlSessionState, ControlTurnHandle, ControlTurnRequest } from '../../src/session/control-session.js';
import { Session } from '../../src/session/session.js';

interface TurnPlan {
  events?: AgentEvent[];
  hang?: boolean;
  text?: string;
}

class FakeControlSession implements ControlSessionHandle {
  readonly transportEpoch = 'epoch-1';
  readonly identity: SessionIdentity;
  plan: TurnPlan = {};
  starts = 0;
  interrupts = 0;
  delayStart: Promise<void> | undefined;
  terminalOnInterrupt = true;
  delayInterrupt: Promise<void> | undefined;
  closeFailure: Error | undefined;
  #state: ControlSessionState = 'active';
  #inbox: BoundedQueue<AdapterStreamItem> | undefined;
  #settleTerminal: (() => void) | undefined;

  constructor(threadId: string, readonly persistence: SessionPersistence) {
    this.identity = {
      schemaVersion: 1, provider: 'claude', id: threadId,
      cwd: process.cwd(), transport: 'control', persistence,
      transportEpoch: this.transportEpoch, createdAt: new Date().toISOString(),
    };
  }

  state(): ControlSessionState { return this.#state; }
  death(): void {
    this.#state = this.persistence === 'provider' ? 'unknown' : 'failed';
    this.#inbox?.fail(new Error('control transport died'));
  }

  async startTurn(_request: ControlTurnRequest): Promise<ControlTurnHandle> {
    this.starts += 1;
    if (this.delayStart) await this.delayStart;
    const inbox = new BoundedQueue<AdapterStreamItem>({ maxItems: 64 });
    this.#inbox = inbox;
    inbox.push({ kind: 'session', sessionId: this.identity.id });
    for (const event of this.plan.events ?? []) inbox.push({ kind: 'event', event });
    const finish = () => {
      inbox.push({ kind: 'result', result: {
        completed: true, failed: false, refused: false,
        sessionId: this.identity.id, turnId: 'turn-1',
        text: this.plan.text ?? 'ok', events: [], nativeEvents: [],
      } });
      inbox.close();
    };
    if (this.plan.hang) this.#settleTerminal = finish;
    else finish();
    return {
      stream: inbox,
      interrupt: async (): Promise<InterruptReceipt> => {
        this.interrupts += 1;
        if (this.delayInterrupt) await this.delayInterrupt;
        if (this.terminalOnInterrupt) {
          this.#settleTerminal?.();
          this.#settleTerminal = undefined;
        }
        return { requested: true, terminal: this.terminalOnInterrupt ? 'interrupted' : 'unknown' };
      },
    };
  }

  async respond(_interactionId: string, _response: InteractionResponse): Promise<void> {}
  async fork(): Promise<ControlSessionHandle> { throw new Error('unused'); }
  async close(): Promise<void> {
    if (this.closeFailure) throw this.closeFailure;
    this.#state = 'closed';
  }
}

function makeSession(control: FakeControlSession): Session {
  const adapter: ExecAdapter = {
    id: 'claude',
    detect: async () => ({ installed: true }),
    auth: async () => ({ authenticated: true, source: 'subscription' }),
    models: async () => [],
    execute: async (_request: ExecTurnRequest): Promise<ProtocolResult> => { throw new Error('unexpected exec'); },
  };
  return new Session({
    adapter,
    model: { id: 'claude-test', provider: 'claude', aliases: [], source: 'explicit', availability: 'available' },
    cwd: process.cwd(), transport: 'control', persistence: control.persistence,
    contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {}, control,
  });
}

describe('control turn cancellation', () => {
  it('cannot respond through a handle that no longer owns the session', async () => {
    const control = new FakeControlSession('thread-stale-response', 'provider');
    let responses = 0;
    control.respond = async () => { responses += 1; };
    const session = makeSession(control);
    const handle = session.start('first');
    await handle.result;

    await expect(handle.respond('interaction-2', { kind: 'approval', decision: 'allow' }))
      .rejects.toBeInstanceOf(ProtocolError);
    expect(responses).toBe(0);
    await session.close();
  });

  it('cannot revive a process session after an unconfirmed timeout', async () => {
    const control = new FakeControlSession('thread-process-timeout', 'process');
    control.plan = { hang: true };
    control.terminalOnInterrupt = false;
    const session = makeSession(control);
    await expect(session.send('hello', { timeoutMs: 10 })).rejects.toBeInstanceOf(TimeoutError);
    expect(session.state).toBe('failed');
    await expect(session.reconcile()).resolves.toBe('failed');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
  });
  it('rejects a pre-aborted turn before sending it to the provider', async () => {
    const control = new FakeControlSession('thread-abort', 'provider');
    const session = makeSession(control);
    const controller = new AbortController();
    controller.abort();

    await expect(session.send('hello', { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
    expect(control.starts).toBe(0);
    expect(session.state).toBe('interrupted');
  });

  it('interrupts a hanging turn on AbortSignal and never silently reuses its session', async () => {
    const control = new FakeControlSession('thread-abort', 'provider');
    control.plan = { hang: true };
    const session = makeSession(control);
    const controller = new AbortController();
    const result = session.send('hello', { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(AbortError);
    expect(control.interrupts).toBe(1);
    expect(session.state).toBe('interrupted');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
  });

  it('bounds a turn whose provider never confirms interruption', async () => {
    const control = new FakeControlSession('thread-timeout', 'provider');
    control.plan = { hang: true };
    control.terminalOnInterrupt = false;
    const session = makeSession(control);

    await expect(session.send('hello', { timeoutMs: 10 })).rejects.toBeInstanceOf(TimeoutError);
    expect(control.interrupts).toBe(1);
    expect(session.state).toBe('unknown');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
  }, 10_000);

  it('rejects detach instead of silently ignoring its requested semantics', async () => {
    const control = new FakeControlSession('thread-detach', 'provider');
    const session = makeSession(control);

    await expect(session.send('hello', { signalBehavior: 'detach' }))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(control.starts).toBe(0);
    expect(session.state).toBe('idle');
  });

  it('does not make a pending start reusable when it is aborted', async () => {
    const control = new FakeControlSession('thread-start', 'provider');
    control.plan = { hang: true };
    let release!: () => void;
    control.delayStart = new Promise<void>((resolve) => { release = resolve; });
    const session = makeSession(control);
    const controller = new AbortController();
    const result = session.send('hello', { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(AbortError);
    expect(session.state).toBe('unknown');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(control.interrupts).toBe(1);
  });

  it('aborts a live event stream and interrupts its provider turn', async () => {
    const control = new FakeControlSession('thread-stream', 'provider');
    control.plan = { events: [{ type: 'message.delta', text: 'first' }], hang: true };
    const session = makeSession(control);
    const controller = new AbortController();
    const iterator = session.stream('hello', { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();

    await expect(iterator.next()).rejects.toBeInstanceOf(AbortError);
    expect(control.interrupts).toBe(1);
    expect(session.state).toBe('interrupted');
  });

  it('interrupts a stream when its consumer returns early', async () => {
    const control = new FakeControlSession('thread-stream-return', 'provider');
    control.plan = { events: [{ type: 'message.delta', text: 'first' }], hang: true };
    const session = makeSession(control);
    const iterator = session.stream('hello')[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(control.interrupts).toBe(1);
    expect(session.state).toBe('interrupted');
  });

  it('cannot reconcile a terminal receipt until its stream has retired', async () => {
    const control = new FakeControlSession('thread-undrained', 'provider');
    control.plan = { events: [{ type: 'message.delta', text: 'first' }], hang: true };
    const startTurn = control.startTurn.bind(control);
    control.startTurn = async (request) => ({
      ...await startTurn(request),
      interrupt: async () => ({ requested: true, terminal: 'interrupted' }),
    });
    const session = makeSession(control);
    const iterator = session.stream('hello')[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(session.state).toBe('unknown');
    await expect(session.reconcile()).resolves.toBe('unknown');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
    await session.close();
  });


  it('rejects detach on stream without stranding the session as busy', async () => {
    const control = new FakeControlSession('thread-detach-stream', 'provider');
    const session = makeSession(control);
    const iterator = session.stream('hello', { signalBehavior: 'detach' })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(control.starts).toBe(0);
    expect(session.state).toBe('idle');
  });


  it('preserves transport-death state when a stream fails', async () => {
    const control = new FakeControlSession('thread-death-stream', 'provider');
    control.plan = { events: [{ type: 'message.delta', text: 'first' }], hang: true };
    const session = makeSession(control);
    const iterator = session.stream('hello')[Symbol.asyncIterator]();
    await iterator.next();
    control.death();

    await expect(iterator.next()).rejects.toThrow(/transport died/);
    expect(session.state).toBe('unknown');
    expect(control.interrupts).toBe(0);
  });


  it('does not strand a session if the adapter throws before returning a start promise', async () => {
    const control = new FakeControlSession('thread-start-throw', 'provider');
    control.startTurn = () => { throw new Error('start failed'); };
    const session = makeSession(control);

    await expect(session.send('hello')).rejects.toThrow('start failed');
    expect(session.state).toBe('failed');
  });


  it('updates session state when an aborted stream consumer stays paused', async () => {
    const control = new FakeControlSession('thread-paused-stream', 'provider');
    control.plan = { events: [{ type: 'message.delta', text: 'first' }], hang: true };
    const session = makeSession(control);
    const controller = new AbortController();
    const iterator = session.stream('hello', { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(control.interrupts).toBe(1);
    expect(session.state).toBe('interrupted');
    await iterator.return?.();
  });


  it('keeps a late-start abort unknown when the interrupt receipt confirms no terminal', async () => {
    const control = new FakeControlSession('thread-late-unknown', 'provider');
    control.plan = { hang: true };
    control.terminalOnInterrupt = false;
    let release!: () => void;
    control.delayStart = new Promise<void>((resolve) => { release = resolve; });
    const session = makeSession(control);
    const controller = new AbortController();
    const result = session.send('hello', { signal: controller.signal });
    controller.abort();
    release();

    await expect(result).rejects.toBeInstanceOf(AbortError);
    expect(control.interrupts).toBe(1);
    expect(session.state).toBe('unknown');
    await expect(session.reconcile()).resolves.toBe('unknown');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
  });


  it('sends one interrupt when manual interrupt and signal abort overlap', async () => {
    const control = new FakeControlSession('thread-interrupt-once', 'provider');
    control.plan = { hang: true };
    let release!: () => void;
    control.delayInterrupt = new Promise<void>((resolve) => { release = resolve; });
    const session = makeSession(control);
    const controller = new AbortController();
    const handle = session.start('hello', { signal: controller.signal });
    const manual = handle.interrupt();
    controller.abort();
    release();

    await manual;
    await expect(handle.result).rejects.toBeInstanceOf(AbortError);
    expect(control.interrupts).toBe(1);
  });


  it('keeps a failed control close retryable instead of stranding closing state', async () => {
    const control = new FakeControlSession('thread-close', 'provider');
    const session = makeSession(control);
    control.closeFailure = new Error('close failed');

    await expect(session.close()).rejects.toThrow('close failed');
    expect(session.state).toBe('unknown');
    control.closeFailure = undefined;
    await expect(session.close()).resolves.toBeUndefined();
    expect(session.state).toBe('closed');
  });

});
