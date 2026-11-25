import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('Optional SDK absent in this fixture'); });

import {
  CLAUDE_CONTROL_TERMINAL_GRACE_MS,
  ClaudeControlSession,
} from '../../src/adapters/claude-control/session.js';
import type { ClaudeAgentSdk, SdkQuery } from '../../src/adapters/claude-control/sdk.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
import { AgentRuntimeError } from '../../src/public/errors.js';
import type { AdapterStreamItem } from '../../src/adapters/provider.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * A Query whose first turn runs until interrupted. After the interrupt it
 * emits that turn's result, unless `wedged`; later turns complete at once.
 */
function fakeSdk(options: { wedged?: boolean } = {}) {
  const state = { interrupts: 0, closes: 0, started: deferred<void>() };
  const closed = deferred<void>();
  const sdk: ClaudeAgentSdk = {
    query({ prompt }) {
      let release: (() => void) | undefined;
      const generator = (async function* () {
        let turn = 0;
        for await (const _user of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'native-1' };
          if (turn++ === 0) {
            state.started.resolve();
            await new Promise<void>((resolve) => { release = resolve; });
            if (options.wedged) {
              await closed.promise;
              return;
            }
            yield { type: 'result', subtype: 'error_during_execution', session_id: 'native-1', result: 'stopped' };
          } else {
            yield { type: 'result', subtype: 'success', session_id: 'native-1', result: `turn ${turn}` };
          }
        }
      })();
      return Object.assign(generator, {
        interrupt: async () => { state.interrupts += 1; release?.(); },
        setPermissionMode: async () => undefined,
        setModel: async () => undefined,
        close: () => { state.closes += 1; closed.resolve(); },
      }) as unknown as SdkQuery;
    },
  };
  return { sdk, state };
}

function session(sdk: ClaudeAgentSdk) {
  return new ClaudeControlSession({
    sessionId: 'session-1',
    cwd: '/tmp/project',
    persistence: 'process',
    broker: new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' }),
    sdk,
  });
}

async function drain(items: AsyncIterable<AdapterStreamItem>): Promise<AdapterStreamItem[]> {
  const collected: AdapterStreamItem[] = [];
  for await (const item of items) collected.push(item);
  return collected;
}

describe('Claude control turn deadline', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('interrupts an expired turn and settles it with the exec-shaped TIMEOUT', async () => {
    const { sdk, state } = fakeSdk();
    const control = session(sdk);

    const error = await control.send('long', { timeoutMs: 40 }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      context: { provider: 'claude', transport: 'control', retryable: true, sanitizedDiagnostics: { timeoutMs: 40 } },
    });
    expect(state.interrupts).toBe(1);
    // The interrupted turn's result was consumed, so the Query is reusable.
    expect(control.deliveryFailure).toBeUndefined();
    await expect(control.send('next')).resolves.toMatchObject({ text: 'turn 2' });
    await control.close();
  });

  it('fails the session when the interrupted turn reaches no terminal within the grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, state } = fakeSdk({ wedged: true });
    const control = session(sdk);

    const outcome = drain(control.stream('long', { timeoutMs: 1_000 })).catch((cause: unknown) => cause);
    await state.started.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.interrupts).toBe(1);
    expect(control.deliveryFailure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(CLAUDE_CONTROL_TERMINAL_GRACE_MS);

    await expect(outcome).resolves.toMatchObject({ code: 'TIMEOUT' });
    // A late result could otherwise be taken for the next turn's.
    expect(control.deliveryFailure).toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(state.closes).toBeGreaterThan(0);
    await expect(control.send('next')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await control.close();
  });

  it('leaves an owner-cancelled turn to its owner: the drained result is not relabelled', async () => {
    const { sdk, state } = fakeSdk();
    const control = session(sdk);
    const owner = new AbortController();

    const outcome = drain(control.stream('long', { timeoutMs: 40, signal: owner.signal }));
    await state.started.promise;
    owner.abort();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.interrupts).toBe(0);
    await control.interrupt();

    const items = await outcome;
    expect(items.at(-1)).toMatchObject({ kind: 'result' });
    expect(state.interrupts).toBe(1);
    await control.close();
  });

  it('keeps a turn that finished in time completed when its consumer is slower than the deadline and grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, state } = fakeSdk();
    const control = session(sdk);
    // Turn 1 is the fake's interrupt-until-stopped turn; spend it so turn 2 completes at once.
    const warm = control.send('warm', { timeoutMs: 60_000 });
    await state.started.promise;
    await control.interrupt();
    await warm;

    const items = control.stream('quick', { timeoutMs: 1_000 })[Symbol.asyncIterator]();
    expect((await items.next()).done).toBe(false);
    // The pump has queued the result; the consumer now stalls past the deadline and the grace.
    await vi.advanceTimersByTimeAsync(1_000 + CLAUDE_CONTROL_TERMINAL_GRACE_MS);
    const rest: AdapterStreamItem[] = [];
    for (let next = await items.next(); !next.done; next = await items.next()) rest.push(next.value);

    expect(rest.at(-1)).toMatchObject({ kind: 'result', result: { text: 'turn 2' } });
    expect(control.deliveryFailure).toBeUndefined();
    await control.close();
  });

  it('clears its deadline once the turn completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sdk, state } = fakeSdk();
    const control = session(sdk);
    const first = control.send('long', { timeoutMs: 60_000 });
    await state.started.promise;
    await control.interrupt();
    await expect(first).resolves.toMatchObject({ text: 'stopped' });
    expect(vi.getTimerCount()).toBe(0);
    await control.close();
  });
});
