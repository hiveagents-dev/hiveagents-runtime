import { describe, expect, it, vi } from 'vitest';

import { createClaudeControlRegistration } from '../../src/adapters/claude-control/factory.js';
import type {
  ClaudeAgentSdk,
  SdkCanUseTool,
  SdkPermissionResult,
  SdkQuery,
  SdkQueryOptions,
  SdkUserMessage,
} from '../../src/adapters/claude-control/sdk.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { ApprovalRequiredError } from '../../src/public/errors.js';
import type { AgentEvent, AgentOptions, InteractionRequest } from '../../src/public/types.js';
import { FakeExecAdapter } from './control-factories.fixture.js';

class FakeSdk implements ClaudeAgentSdk {
  canUseTool: SdkCanUseTool | undefined;
  options: SdkQueryOptions | undefined;
  requestApproval = false;
  failure: Error | undefined;
  interrupts = 0;
  wireVerdict: SdkPermissionResult | undefined;

  query(input: { prompt: AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }): SdkQuery {
    this.canUseTool = input.options?.canUseTool;
    this.options = input.options;
    let turns = 0;
    const emit = async function* (this: FakeSdk): AsyncGenerator<Record<string, unknown>> {
      for await (const _message of input.prompt) {
        turns += 1;
        if (turns === 1) {
          yield { type: 'system', subtype: 'init', session_id: 'claude-thread' };
        }
        if (this.failure) throw this.failure;
        if (this.requestApproval && this.canUseTool) {
          this.wireVerdict = await this.canUseTool(
            'Bash',
            { command: 'ls' },
            { signal: new AbortController().signal },
          );
        }
        yield { type: 'result', subtype: 'success', result: 'ok', session_id: 'claude-thread' };
      }
    }.bind(this);
    const iterable = emit();
    return {
      [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
      interrupt: async () => { this.interrupts += 1; },
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
    };
  }
}

function claudeAgent(sdk: FakeSdk, overrides: Partial<AgentOptions> = {}) {
  const runtime = new Runtime({
    adapters: [new FakeExecAdapter('claude')],
    controlAdapters: [createClaudeControlRegistration({ sdk, sdkVersion: '0.3.252' })],
  });
  return new Agent({
    model: 'opus-5',
    transport: 'control',
    providerOptions: { experimentalControl: true },
    ...overrides,
  }, runtime);
}

describe('Claude control factory', () => {
  it('keeps additional read roots in analyze mode', async () => {
    const sdk = new FakeSdk();
    const session = await claudeAgent(sdk, {
      permissions: { mode: 'analyze', additionalDirectories: ['/private/tmp'] },
    }).openSession();
    try {
      await session.send('hello');
      expect(sdk.options?.additionalDirectories).toEqual(['/private/tmp']);
    } finally { await session.close(); }
  });
  it('passes project context, instructions and effort to the native SDK', async () => {
    const sdk = new FakeSdk();
    const session = await claudeAgent(sdk, {
      context: { profile: 'project' }, instructions: 'Reply briefly.', effort: 'low',
    }).openSession();
    try {
      await session.send('hello');
      expect(sdk.options).toMatchObject({
        settingSources: ['project', 'local'], effort: 'low',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Reply briefly.' },
      });
    } finally { await session.close(); }
  });

  it('applies clean context to the actual CLI, retaining subscription authentication', async () => {
    const sdk = new FakeSdk();
    const session = await claudeAgent(sdk, { context: { profile: 'clean', memory: 'off' } }).openSession();
    try {
      await session.send('hello');
      expect(sdk.options).toMatchObject({ extraArgs: { 'safe-mode': null } });
    } finally { await session.close(); }
  });

  it('rejects unsupported structured output before asking the SDK for a turn', async () => {
    const sdk = new FakeSdk();
    const session = await claudeAgent(sdk).openSession();
    try {
      await expect(session.send('hello', { outputSchema: { type: 'object' } }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      expect(sdk.options).toBeUndefined();
    } finally { await session.close(); }
  });
  it('runs a turn through the injected SDK and adopts the native session id', async () => {
    const sdk = new FakeSdk();
    const session = await claudeAgent(sdk).openSession();

    const turn = await session.send('hello');

    expect(turn).toMatchObject({ status: 'completed', text: 'ok' });
    expect(session.ref).toMatchObject({ id: 'claude-thread', transport: 'control' });
    expect(sdk.options).toMatchObject({ permissionMode: 'plan', model: 'claude-opus-5' });
    await session.close();
  });

  it('reaches the broker with a TurnOptions.onInteraction approval', async () => {
    const sdk = new FakeSdk();
    sdk.requestApproval = true;
    const session = await claudeAgent(sdk).openSession();

    const seen: InteractionRequest[] = [];
    await session.send('run ls', {
      onInteraction: async (request) => {
        seen.push(request);
        return { kind: 'approval', decision: 'allow' };
      },
    });

    expect(seen[0]).toMatchObject({ kind: 'tool-approval', toolName: 'Bash' });
    expect(sdk.wireVerdict).toMatchObject({ behavior: 'allow' });
  });

  it('settles the wire with a deny before raising the typed missing-handler error', async () => {
    const sdk = new FakeSdk();
    sdk.requestApproval = true;
    const session = await claudeAgent(sdk).openSession();

    await expect(session.send('run ls')).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(sdk.wireVerdict).toMatchObject({ behavior: 'deny' });
    expect(sdk.interrupts).toBe(1);
  });

  it('never exposes steer, matching the adapter verdict of none', async () => {
    const sdk = new FakeSdk();
    const session = await claudeAgent(sdk).openSession();
    const handle = session.start('hello');

    expect(handle.steer).toBeUndefined();
    await handle.result;
  });

  it('leaves a persisted session unknown when the SDK query dies', async () => {
    const sdk = new FakeSdk();
    sdk.failure = new Error('query died');
    const session = await claudeAgent(sdk).openSession();

    await expect(session.send('hello')).rejects.toThrow(/query died/);
    expect(session.state).toBe('unknown');
  });
});
