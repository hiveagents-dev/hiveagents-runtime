import { describe, expect, it, vi } from 'vitest';

// The absence contract must remain deterministic when live validation installs the optional peer.
vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('Optional SDK absent in this fixture'); });

import {
  ClaudeControlSession,
  CLAUDE_CONTROL_CAPABILITY_VERDICTS,
  type ClaudeControlSessionOptions,
} from '../../src/adapters/claude-control/session.js';
import {
  loadClaudeAgentSdk,
  type ClaudeAgentSdk,
  type SdkPermissionMode,
  type SdkPermissionResult,
  type SdkQuery,
  type SdkQueryOptions,
  type SdkUserMessage,
} from '../../src/adapters/claude-control/sdk.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
import {
  ApprovalRequiredError,
  InteractionExpiredError,
  RequiredTransportUnavailableError,
  SessionBusyError,
  UnsupportedCapabilityError,
} from '../../src/public/errors.js';
import type { AdapterStreamItem } from '../../src/adapters/provider.js';
import type { InteractionRequest } from '../../src/public/types.js';

type ScriptMessage = Record<string, unknown>;

interface FakeState {
  queryCalls: number;
  options: SdkQueryOptions[];
  users: SdkUserMessage[];
  wireResults: SdkPermissionResult[];
  interrupts: number;
  modes: SdkPermissionMode[];
  models: Array<string | undefined>;
  interruptReady: Promise<void>;
}

function createFakeSdk(script: ScriptMessage[][]): { sdk: ClaudeAgentSdk; state: FakeState } {
  let markInterruptReady: (() => void) | undefined;
  const state: FakeState = {
    queryCalls: 0,
    options: [],
    users: [],
    wireResults: [],
    interrupts: 0,
    modes: [],
    models: [],
    interruptReady: new Promise((resolve) => { markInterruptReady = resolve; }),
  };
  const sdk: ClaudeAgentSdk = {
    query({ prompt, options }) {
      state.queryCalls += 1;
      state.options.push(options ?? {});
      let interrupted = false;
      let releaseInterrupt: (() => void) | undefined;
      const generator = (async function* (): AsyncGenerator<Record<string, unknown>> {
        let turn = 0;
        for await (const user of prompt) {
          state.users.push(user);
          interrupted = false;
          for (const message of script[turn] ?? []) {
            if (interrupted && message.type !== 'result') continue;
            if ('__tool' in message) {
              const tool = message.__tool as { name: string; input: Record<string, unknown> };
              const decide = options?.canUseTool;
              if (decide !== undefined) {
                state.wireResults.push(
                  await decide(tool.name, tool.input, { signal: new AbortController().signal }),
                );
              }
              continue;
            }
            if ('__toolDetached' in message) {
              // The SDK moved on (an interrupt abandoned the tool) and the
              // decision settles whenever the application gets round to it.
              const tool = message.__toolDetached as { name: string; input: Record<string, unknown> };
              const decide = options?.canUseTool;
              if (decide !== undefined) {
                void decide(tool.name, tool.input, { signal: new AbortController().signal })
                  .then((verdict) => { state.wireResults.push(verdict); });
              }
              continue;
            }
            if ('__awaitInterrupt' in message) {
              markInterruptReady?.();
              await new Promise<void>((resolve) => { releaseInterrupt = resolve; });
              continue;
            }
            yield message;
          }
          turn += 1;
        }
      })();
      return Object.assign(generator, {
        interrupt: async () => {
          state.interrupts += 1;
          interrupted = true;
          releaseInterrupt?.();
        },
        setPermissionMode: async (mode: SdkPermissionMode) => { state.modes.push(mode); },
        setModel: async (model?: string) => { state.models.push(model); },
      }) as SdkQuery;
    },
  };
  return { sdk, state };
}

function makeSession(
  sdk: ClaudeAgentSdk,
  overrides: Partial<ClaudeControlSessionOptions> = {},
): ClaudeControlSession {
  return new ClaudeControlSession({
    sessionId: 'session-1',
    cwd: '/tmp/project',
    persistence: 'process',
    broker: new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' }),
    sdk,
    ...overrides,
  });
}

const init: ScriptMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'native-1',
  account: { plan: 'max', email: 'secret@example.com' },
};

function delta(text: string): ScriptMessage {
  return { type: 'stream_event', event: { delta: { text } } };
}

function result(text: string, extra: ScriptMessage = {}): ScriptMessage {
  return { type: 'result', subtype: 'success', session_id: 'native-1', result: text, ...extra };
}

async function collect(items: AsyncIterable<AdapterStreamItem>): Promise<AdapterStreamItem[]> {
  const collected: AdapterStreamItem[] = [];
  for await (const item of items) collected.push(item);
  return collected;
}

describe('ClaudeControlSession', () => {
  it('keeps one long-lived query across turns', async () => {
    const { sdk, state } = createFakeSdk([
      [init, delta('a'), result('one')],
      [delta('b'), result('two')],
    ]);
    const session = makeSession(sdk);

    const first = await session.send('hello');
    const second = await session.send('again');

    expect(state.queryCalls).toBe(1);
    expect(state.users).toHaveLength(2);
    expect(first.text).toBe('one');
    expect(second.text).toBe('two');
    await session.close();
  });

  it('translates SDK messages into runtime events and redacts account info', async () => {
    const { sdk } = createFakeSdk([[
      init,
      delta('Hel'),
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'ignored' },
          ],
        },
      },
      { type: 'compact_boundary', detail: 'unmapped' },
      result('Hello'),
    ]]);
    const session = makeSession(sdk);

    const items = await collect(session.stream('hi'));

    expect(items[0]).toEqual({ kind: 'session', sessionId: 'native-1' });
    const events = items
      .filter((item): item is Extract<AdapterStreamItem, { kind: 'event' }> => item.kind === 'event')
      .map((item) => item.event);
    expect(events).toEqual([
      { type: 'message.delta', text: 'Hel' },
      { type: 'tool.started', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      {
        type: 'provider.event',
        provider: 'claude',
        event: { type: 'compact_boundary', detail: 'unmapped' },
      },
      { type: 'message.completed', text: 'Hello' },
    ]);
    const terminal = items.at(-1);
    expect(terminal?.kind).toBe('result');
    if (terminal?.kind === 'result') {
      expect(terminal.result.completed).toBe(true);
      expect(terminal.result.text).toBe('Hello');
      expect(terminal.result.sessionId).toBe('native-1');
      expect(terminal.result.nativeEvents).toHaveLength(5);
    }
    expect(session.account()).toEqual({ plan: 'max' });
    await session.close();
  });

  it('passes persistSession:false for process persistence and nothing to resume', async () => {
    const { sdk, state } = createFakeSdk([[result('ok')]]);
    const session = makeSession(sdk, { persistence: 'process' });
    await session.send('hi');
    expect(state.options[0]?.persistSession).toBe(false);
    expect(state.options[0]?.resume).toBeUndefined();
    await session.close();
  });

  it('resumes provider-persisted sessions via options.resume', async () => {
    const { sdk, state } = createFakeSdk([[result('ok')]]);
    const session = makeSession(sdk, { persistence: 'provider', resume: 'native-9' });
    await session.send('hi');
    expect(state.options[0]?.resume).toBe('native-9');
    expect(state.options[0]).not.toHaveProperty('persistSession');
    await session.close();
  });

  it('rejects resume with process persistence', () => {
    const { sdk } = createFakeSdk([]);
    expect(() => makeSession(sdk, { persistence: 'process', resume: 'native-9' }))
      .toThrow(UnsupportedCapabilityError);
  });

  it('routes canUseTool approvals through the broker and allows at the wire', async () => {
    const { sdk, state } = createFakeSdk([[
      { __tool: { name: 'Bash', input: { command: 'ls' } } },
      result('done'),
    ]]);
    const session = makeSession(sdk);

    const turn = await session.send('hi', {
      onInteraction: async (request) => {
        expect(request.kind).toBe('tool-approval');
        if (request.kind === 'tool-approval') {
          expect(request.toolName).toBe('Bash');
          expect(request.input).toEqual({ command: 'ls' });
        }
        expect(request.availableDecisions).toEqual(['allow', 'deny']);
        return { kind: 'approval', decision: 'allow' };
      },
    });

    expect(state.wireResults).toEqual([
      { behavior: 'allow', updatedInput: { command: 'ls' } },
    ]);
    expect(turn.completed).toBe(true);
    expect(turn.events.some((event) => event.type === 'interaction.requested')).toBe(true);
    await session.close();
  });

  it('denies at the wire when the application declines', async () => {
    const { sdk, state } = createFakeSdk([[
      { __tool: { name: 'Bash', input: { command: 'rm -rf /' } } },
      result('declined'),
    ]]);
    const session = makeSession(sdk, {
      onInteraction: async () => ({ kind: 'approval', decision: 'deny', reason: 'nope' }),
    });

    const turn = await session.send('hi');

    expect(state.wireResults).toEqual([{ behavior: 'deny', message: 'nope' }]);
    expect(turn.completed).toBe(true);
    await session.close();
  });

  it('denies at the wire and fails the turn when no handler is registered', async () => {
    const { sdk, state } = createFakeSdk([[
      { __tool: { name: 'Bash', input: { command: 'ls' } } },
      delta('should be skipped'),
      result('never surfaced'),
    ]]);
    const session = makeSession(sdk);

    await expect(session.send('hi')).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(state.wireResults).toEqual([
      { behavior: 'deny', message: 'No interaction handler is registered' },
    ]);
    expect(state.interrupts).toBe(1);
    await session.close();
  });

  it('expires the broker entry after denying a tool with no handler, so a late answer is refused (R11)', async () => {
    const { sdk } = createFakeSdk([[
      { __tool: { name: 'Bash', input: { command: 'ls' } } },
      result('never surfaced'),
    ]]);
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const session = makeSession(sdk, { broker });

    const requests: InteractionRequest[] = [];
    await expect((async () => {
      for await (const item of session.stream('hi')) {
        if (item.kind === 'event' && item.event.type === 'interaction.requested') requests.push(item.event.request);
      }
    })()).rejects.toBeInstanceOf(ApprovalRequiredError);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    await expect(broker.respond(requests[0]!.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
    await session.close();
  });

  it('expires the broker entry after denying a tool whose handler failed (R11)', async () => {
    const { sdk, state } = createFakeSdk([[
      { __tool: { name: 'Bash', input: { command: 'ls' } } },
      result('never surfaced'),
    ]]);
    const broker = new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' });
    const session = makeSession(sdk, { broker });
    let request: InteractionRequest | undefined;

    await expect(session.send('hi', {
      onInteraction: async (incoming) => { request = incoming; throw new Error('UI crashed'); },
    })).rejects.toThrow('UI crashed');

    expect(state.wireResults).toEqual([{ behavior: 'deny', message: 'Interaction handler failed' }]);
    expect(request?.signal.aborted).toBe(true);
    await expect(broker.respond(request!.binding.interactionId, { decision: 'allow' }))
      .rejects.toBeInstanceOf(InteractionExpiredError);
    await session.close();
  });

  it('keeps a stale handler failure from the previous turn out of the running one (R11)', async () => {
    const { sdk, state } = createFakeSdk([
      [{ __toolDetached: { name: 'Bash', input: { command: 'ls' } } }, result('one')],
      [delta('working'), { __awaitInterrupt: true }, result('two')],
    ]);
    const session = makeSession(sdk);
    let failFirstHandler!: (error: Error) => void;

    const first = await session.send('first', {
      onInteraction: () => new Promise((_, reject) => { failFirstHandler = reject; }),
    });
    expect(first.text).toBe('one');

    const second = collect(session.stream('second'));
    await state.interruptReady;
    failFirstHandler(new Error('late failure from turn one'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.interrupt();

    const items = await second;
    const terminal = items.at(-1);
    expect(terminal?.kind).toBe('result');
    if (terminal?.kind === 'result') expect(terminal.result.text).toBe('two');
    expect(state.wireResults).toEqual([{ behavior: 'deny', message: 'Native turn retired' }]);
    await session.close();
  });

  it('interrupts a running turn through the single query', async () => {
    const { sdk, state } = createFakeSdk([[
      init,
      delta('start'),
      { __awaitInterrupt: true },
      result('stopped'),
    ]]);
    const session = makeSession(sdk);

    const pending = collect(session.stream('go'));
    await state.interruptReady;
    const receipt = await session.interrupt();
    const items = await pending;

    expect(receipt).toEqual({ requested: true, terminal: 'unknown' });
    expect(state.interrupts).toBe(1);
    const terminal = items.at(-1);
    expect(terminal?.kind).toBe('result');
    if (terminal?.kind === 'result') expect(terminal.result.text).toBe('stopped');
    await session.close();
  });

  it('rejects a second concurrent turn as busy', async () => {
    const { sdk, state } = createFakeSdk([[
      { __awaitInterrupt: true },
      result('later'),
    ]]);
    const session = makeSession(sdk);

    const pending = collect(session.stream('first'));
    await expect(session.send('second')).rejects.toBeInstanceOf(SessionBusyError);
    await state.interruptReady; // Private storage is prepared before the native prompt.
    await session.interrupt();
    await pending;
    await session.close();
  });

  it('narrows the permission mode but rejects widening beyond the initial authority', async () => {
    const { sdk, state } = createFakeSdk([[result('ok')], [result('ok')]]);
    const session = makeSession(sdk, { permissionMode: 'acceptEdits' });

    await session.setPermissionMode('default');
    await session.send('hi');
    expect(state.options[0]?.permissionMode).toBe('default');

    await session.setPermissionMode('plan');
    expect(state.modes).toEqual(['plan']);

    await expect(session.setPermissionMode('bypassPermissions'))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(state.modes).toEqual(['plan']);
    await session.close();
  });

  it('constrains setModel to the negotiated allowlist', async () => {
    const { sdk, state } = createFakeSdk([[result('ok')]]);
    const session = makeSession(sdk, { allowedModels: ['claude-sonnet-5'] });
    await session.send('hi');

    await session.setModel('claude-sonnet-5');
    expect(state.models).toEqual(['claude-sonnet-5']);

    await expect(session.setModel('claude-opus-5'))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(state.models).toEqual(['claude-sonnet-5']);
    await session.close();
  });

  it('diffs cumulative session usage into per-turn usage', async () => {
    const { sdk } = createFakeSdk([
      [result('one', {
        modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } },
        total_cost_usd: 0.01,
      })],
      [result('two', {
        modelUsage: { 'claude-sonnet-5': { inputTokens: 25, outputTokens: 9, costUSD: 0.03 } },
        total_cost_usd: 0.03,
      })],
    ]);
    const session = makeSession(sdk);

    const first = await session.send('hi');
    const second = await session.send('more');

    expect(first.usage?.inputTokens).toBe(10);
    expect(first.usage?.costMeaning).toBe('api-equivalent');
    expect(second.usage?.inputTokens).toBe(15);
    expect(second.usage?.outputTokens).toBe(4);
    expect(second.usage?.reportedCostUsd).toBeCloseTo(0.02);
    expect(second.usage?.costMeaning).toBe('api-equivalent');
    await session.close();
  });

  it('declares steering unsupported', () => {
    expect(CLAUDE_CONTROL_CAPABILITY_VERDICTS.steering).toBe('none');
    const { sdk } = createFakeSdk([]);
    const session = makeSession(sdk);
    expect('steer' in session).toBe(false);
  });

  it('raises RequiredTransportUnavailableError when the Agent SDK is absent', async () => {
    await expect(loadClaudeAgentSdk()).rejects.toMatchObject({
      code: 'REQUIRED_TRANSPORT_UNAVAILABLE',
      message: expect.stringContaining('@anthropic-ai/claude-agent-sdk'),
    });

    const session = new ClaudeControlSession({
      sessionId: 'session-1',
      cwd: '/tmp/project',
      persistence: 'process',
      broker: new InteractionBroker({ provider: 'claude', epoch: 'epoch-1' }),
    });
    await expect(session.send('hi')).rejects.toBeInstanceOf(RequiredTransportUnavailableError);
  });
});
