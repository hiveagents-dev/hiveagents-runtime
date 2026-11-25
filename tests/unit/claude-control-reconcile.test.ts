import { describe, expect, it } from 'vitest';

import { createClaudeControlRegistration } from '../../src/adapters/claude-control/factory.js';
import type { ClaudeAgentSdk, SdkQuery, SdkQueryOptions, SdkUserMessage } from '../../src/adapters/claude-control/sdk.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { AbortError } from '../../src/public/errors.js';
import type { ControlSessionState } from '../../src/session/control-session.js';

/**
 * An SDK whose first turn, once interrupted, takes `resultDelayMs` to emit its
 * result message — longer than the runtime's 1 s interrupt grace. The Query
 * stays alive throughout, exactly like the real SDK after `interrupt()`.
 */
class SlowInterruptSdk implements ClaudeAgentSdk {
  interrupts = 0;
  readonly prompts: unknown[] = [];
  prompted!: () => void;
  readonly firstPrompt = new Promise<void>((resolve) => { this.prompted = resolve; });
  #release: (() => void) | undefined;

  constructor(private readonly resultDelayMs: number) {}

  finishFirstTurn(): void { this.#release?.(); }

  query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }): SdkQuery {
    const sdk = this;
    const generator = (async function* () {
      let first = true;
      for await (const message of prompt) {
        sdk.prompts.push(message.message.content);
        if (first) {
          first = false;
          yield { type: 'system', subtype: 'init', session_id: 'claude-thread' };
          sdk.prompted();
          await new Promise<void>((resolve) => { sdk.#release = resolve; });
        }
        yield { type: 'result', subtype: 'success', session_id: 'claude-thread', result: 'done' };
      }
    })();
    return Object.assign(generator, {
      interrupt: async () => {
        this.interrupts += 1;
        setTimeout(() => this.#release?.(), this.resultDelayMs);
      },
      close: () => { void generator.return(); },
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
    });
  }
}

async function openSession(sdk: ClaudeAgentSdk, reconcile?: () => Promise<ControlSessionState>) {
  const adapter: ExecAdapter = {
    id: 'claude', detect: async () => ({ installed: true }),
    auth: async () => ({ authenticated: true, source: 'subscription' }),
    models: async () => [], execute: async () => { throw new Error('Unexpected exec'); },
  };
  const registration = createClaudeControlRegistration({ sdk });
  if (reconcile) {
    const createSession = registration.createSession!;
    registration.createSession = async request => Object.assign(await createSession(request), { reconcile });
  }
  const runtime = new Runtime({ adapters: [adapter], controlAdapters: [registration] });
  return new Agent({
    model: 'opus-5', transport: 'control', providerOptions: { experimentalControl: true },
  }, runtime).openSession();
}

describe('Claude control reconcile after a late interrupt terminal (R8)', () => {
  it('keeps a healthy running turn interruptible when reconciliation is requested', async () => {
    const sdk = new SlowInterruptSdk(0), session = await openSession(sdk);
    const handle = session.start('still working');
    try {
      await sdk.firstPrompt;
      const observed = await session.reconcile();
      const receipt = await handle.interrupt();
      expect(observed).toBe('running');
      expect(receipt.requested).toBe(true);
      expect(sdk.interrupts).toBe(1);
    } finally {
      sdk.finishFirstTurn();
      await handle.result.catch(() => undefined);
      await session.close();
    }
  }, 10_000);

  it('does not replace ownership when an earlier reconciliation resolves during a new turn', async () => {
    let finish!: (state: ControlSessionState) => void;
    const sdk = new SlowInterruptSdk(0);
    const session = await openSession(sdk, () => new Promise(resolve => { finish = resolve; }));
    const reconciling = session.reconcile();
    const handle = session.start('new turn');
    try {
      await sdk.firstPrompt;
      finish('unknown');
      expect(await reconciling).toBe('running');
      expect(session.state).toBe('running');
      expect((await handle.interrupt()).requested).toBe(true);
      expect(sdk.interrupts).toBe(1);
    } finally {
      sdk.finishFirstTurn();
      await handle.result.catch(() => undefined);
      await session.close();
    }
  });

  it('does not reopen a closed session when an earlier reconciliation resolves active', async () => {
    let finish!: (state: ControlSessionState) => void;
    const session = await openSession(new SlowInterruptSdk(0), () => new Promise(resolve => { finish = resolve; }));
    const reconciling = session.reconcile();
    await session.close(); finish('active');
    expect(await reconciling).toBe('closed');
    expect(session.state).toBe('closed');
    await expect(session.send('cannot reopen')).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
  });

  it('does not replace a completed turn with an older reconciliation result', async () => {
    let finish!: (state: ControlSessionState) => void;
    const sdk = new SlowInterruptSdk(0);
    const session = await openSession(sdk, () => new Promise(resolve => { finish = resolve; }));
    const reconciling = session.reconcile();
    const turn = session.send('completed while reconciliation was pending');
    await sdk.firstPrompt; sdk.finishFirstTurn(); await turn;
    finish('unknown');
    expect(await reconciling).toBe('idle');
    expect((await session.send('next turn')).status).toBe('completed');
    await session.close();
  });

  it('returns to idle once the interrupted turn drains, instead of staying unknown forever', async () => {
    const sdk = new SlowInterruptSdk(1_300);
    const session = await openSession(sdk);
    const controller = new AbortController();
    const pending = session.send('hello', { signal: controller.signal });
    void pending.catch(() => undefined);
    await sdk.firstPrompt;

    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    // The SDK acknowledged the interrupt but its result came after the grace.
    expect(sdk.interrupts).toBe(1);
    expect(session.state).toBe('unknown');

    await expect(session.reconcile()).resolves.toBe('idle');
    await expect(session.send('again')).resolves.toMatchObject({ text: 'done' });
    expect(sdk.prompts).toEqual(['hello', 'again']);
    await session.close();
  }, 10_000);
});
