import { describe, expect, it, vi } from 'vitest';

import {
  createCodexControlRegistration,
  type CodexControlTransport,
  type CodexTransportStartOptions,
} from '../../src/adapters/codex-control/factory.js';
import { Runtime } from '../../src/core/runtime.js';
import { agentRunner } from '../../src/orchestration/dynamic/agent-runner.js';
import { Agent } from '../../src/public/agent.js';
import type { AgentEvent, AgentOptions } from '../../src/public/types.js';
import { FakeExecAdapter } from './control-factories.fixture.js';

class FakeCodexTransport implements CodexControlTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly wire: unknown[] = [];
  hooks: CodexTransportStartOptions | undefined;
  closed = false;
  approvalOnTurn = false;
  hangTurn = false;
  /** Emit an agent-message delta on the wire just before the approval request. */
  deltaBeforeApproval = false;

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { threadId: 'thread-1' };
    if (method === 'thread/resume') return { threadId: 'thread-1' };
    if (method === 'thread/fork') return { threadId: 'thread-1-fork' };
    const threadId = (params as { threadId?: string }).threadId ?? 'thread-1';
    if (method === 'turn/start') {
      queueMicrotask(() => void this.#runTurn(threadId));
      return { turnId: 'turn-1' };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.notify('turn/interrupted', { threadId, turnId: 'turn-1' }));
      return {};
    }
    return {};
  }

  notify(method: string, params: unknown): void {
    this.hooks?.onNotification(method, params);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async #runTurn(threadId: string): Promise<void> {
    this.notify('turn/started', { threadId, turnId: 'turn-1' });
    if (this.deltaBeforeApproval) {
      this.notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'item-0', delta: 'd1' });
    }
    if (this.approvalOnTurn) {
      this.wire.push(await this.hooks?.onServerRequest(
        'item/commandExecution/requestApproval',
        { threadId, turnId: 'turn-1', itemId: 'item-1', command: ['ls'], cwd: '/tmp' },
        1,
      ).catch((error: unknown) => ({ error: (error as Error).message })));
    }
    this.notify('item/completed', {
      threadId,
      item: { id: 'item-2', type: 'agent_message', text: 'done' },
    });
    if (this.hangTurn) return;
    this.notify('turn/completed', {
      threadId,
      turn: { id: 'turn-1', usage: { input_tokens: 3, output_tokens: 4 } },
    });
  }
}

function codexRuntime(transport: FakeCodexTransport) {
  return new Runtime({
    adapters: [new FakeExecAdapter('codex')],
    controlAdapters: [createCodexControlRegistration({
      startTransport: async (options) => {
        transport.hooks = options;
        return transport;
      },
    })],
  });
}
function codexAgent(transport: FakeCodexTransport, overrides: Partial<AgentOptions> = {}) {
  return new Agent({
    model: 'gpt-5.2-codex',
    transport: 'control',
    providerOptions: { experimentalControl: true },
    ...overrides,
  }, codexRuntime(transport));
}

describe('Codex control factory', () => {
  it('fails closed for permission grants whose wire response is not implemented', async () => {
    const transport = new FakeCodexTransport();
    const session = await codexAgent(transport).openSession();
    try {
      await expect(transport.hooks!.onServerRequest('item/permissions/requestApproval', {}, 1))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    } finally { await session.close(); }
  });
  it('reports control capabilities instead of exec capabilities', async () => {
    const capabilities = await codexAgent(new FakeCodexTransport()).capabilities();
    expect(capabilities.features).toMatchObject({
      interactiveApprovals: 'partial', steering: 'supported', processPersistence: 'supported',
      resume: 'supported', tokenDeltas: 'supported',
    });
    expect(capabilities.enforcement?.effective.approvals).toMatch(/^interactive; decline-only for command and file-change escalations/);
  });

  it('opens control even when the installed exec flags cannot execute or resume', async () => {
    const adapter = new FakeExecAdapter('codex');
    adapter.assessment = {
      provider: 'codex', cliVersion: '1.0.0', transport: 'exec', evidence: 'help-probe',
      features: { turns: 'unsupported', resume: 'unsupported' }, missingFlags: ['--json'], knownIssues: [],
    };
    const transport = new FakeCodexTransport();
    const runtime = new Runtime({ adapters: [adapter], controlAdapters: [createCodexControlRegistration({
      startTransport: async options => { transport.hooks = options; return transport; },
    })] });
    const agent = new Agent({ model: 'gpt-5.2-codex', transport: 'control',
      providerOptions: { experimentalControl: true } }, runtime);
    const session = await agent.openSession();
    const ref = session.export();
    await session.close();
    const resumed = await agent.openSession({ resume: ref });
    await resumed.close();
    expect(transport.calls.map(call => call.method)).toEqual(['thread/start', 'thread/resume']);
  });

  it.each([
    ['analyze', 'read-only', 'on-request'],
    ['edit', 'workspace-write', 'on-request'],
    ['unrestricted', 'danger-full-access', 'never'],
  ] as const)('enforces %s permissions on thread/start', async (mode, sandbox, approvalPolicy) => {
    const transport = new FakeCodexTransport();
    const session = await codexAgent(transport, { permissions: { mode } }).openSession();
    try { expect(transport.calls[0]?.params).toMatchObject({ sandbox, approvalPolicy }); }
    finally { await session.close(); }
  });

  it('exposes an immutable readiness snapshot and opens Control with the validated permissions', async () => {
    const transport = new FakeCodexTransport();
    const agent = codexAgent(transport, { permissions: { mode: 'analyze' } });
    const ready = await agent.ready();
    expect(await agent.ready()).toBe(ready);
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready.plan.envelope.filesystem.writableRoots)).toBe(true);
    expect(Object.isFrozen(ready.plan.fingerprint)).toBe(true);
    expect(Object.isFrozen(ready.plan.capabilities.resume?.evidence)).toBe(true);
    agent.model.aliases.push('display-only-alias');
    const fresh = await agent.ready({});
    expect(fresh.model.aliases).not.toContain('display-only-alias');
    expect(Object.isFrozen(fresh.plan.envelope.modelAllowlist)).toBe(true);
    expect(Reflect.set(ready.plan.envelope, 'permissionModeCeiling', 'acceptEdits')).toBe(false);
    const session = await agent.openSession();
    try {
      expect(transport.calls[0]?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' });
    } finally { await session.close(); }
  });

  it('lets the dynamic runner use Control when auto selects it for a required capability', async () => {
    const transport = new FakeCodexTransport();
    const runner = agentRunner({ runtime: codexRuntime(transport), agent: {
      model: 'gpt-5.2-codex', transport: 'auto', capabilities: { steering: 'required' },
      providerOptions: { experimentalControl: true },
    } });
    await expect(runner.run({
      runId: 'dynamic-control', key: 'one', prompt: 'reply', options: { permissions: 'analyze' },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ text: 'done' });
    expect(transport.closed).toBe(true);
  });

  it('applies instructions, effort and ephemeral persistence to the native thread', async () => {
    const transport = new FakeCodexTransport();
    const session = await codexAgent(transport, {
      context: { profile: 'native', memory: 'off' },
      instructions: 'Reply briefly.', effort: 'low',
    }).openSession({ persistence: 'process' });
    try {
      expect(transport.hooks?.args).toEqual(['--disable', 'memories', 'app-server', '--stdio']);
      expect(transport.calls[0]?.params).toMatchObject({
        ephemeral: true, developerInstructions: 'Reply briefly.', config: { model_reasoning_effort: 'low' },
      });
    } finally { await session.close(); }
  });

  it.each(['project', 'clean'] as const)('rejects unverified %s context before launching Codex control', async (profile) => {
    const transport = new FakeCodexTransport();
    await expect(codexAgent(transport, { context: { profile }, permissions: { mode: 'analyze', strict: false } })
      .openSession()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(transport.hooks).toBeUndefined();
  });

  it('rejects additional Codex roots without a verified control mapping', async () => {
    const transport = new FakeCodexTransport();
    await expect(codexAgent(transport, { permissions: { mode: 'edit', additionalDirectories: ['/private/tmp'] } })
      .openSession()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(transport.hooks).toBeUndefined();
  });

  it('refuses provider config that would bypass the negotiated permission ceiling', async () => {
    const transport = new FakeCodexTransport();
    await expect(codexAgent(transport, { providerOptions: {
      experimentalControl: true, codex: { config: { sandbox_mode: 'danger-full-access' } },
    } }).openSession()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(transport.hooks).toBeUndefined();
  });
  it('starts a thread eagerly and projects a turn into events and a terminal result', async () => {
    const transport = new FakeCodexTransport();
    const session = await codexAgent(transport).openSession();
    expect(session.ref).toMatchObject({ id: 'thread-1', transport: 'control' });

    const seen: AgentEvent[] = [];
    for await (const event of session.stream('hello')) seen.push(event);

    expect(transport.calls.map(({ method }) => method)).toEqual(['thread/start', 'turn/start']);
    expect(seen.map((event) => event.type))
      .toEqual(['turn.started', 'message.completed', 'turn.completed']);
    const turn = seen.at(-1);
    expect(turn?.type === 'turn.completed' && turn.turn).toMatchObject({
      id: 'turn-1',
      text: 'done',
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });

  it('exposes steer because the adapter verdict is full, and sends turn/steer', async () => {
    const transport = new FakeCodexTransport();
    transport.hangTurn = true;
    const session = await codexAgent(transport).openSession();
    const handle = session.start('hello');

    await expect(handle.steer?.('also this')).resolves.toMatchObject({ accepted: true });
    expect(transport.calls.at(-1)).toMatchObject({
      method: 'turn/steer',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'also this' }] },
    });

    await expect(handle.interrupt()).resolves.toEqual({ requested: true, terminal: 'interrupted' });
    await expect(handle.result).rejects.toThrow(/interrupted/);
    expect(session.state).toBe('interrupted');
  });

  it('settles an approval on the wire from TurnOptions.onInteraction', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const session = await codexAgent(transport, { permissions: { mode: 'unrestricted' } }).openSession();

    let advertised: readonly string[] = [];
    await session.send('run ls', {
      onInteraction: async (request) => {
        advertised = request.availableDecisions;
        return { kind: 'approval', decision: 'accept' };
      },
    });

    expect(advertised).toContain('accept');
    expect(transport.wire).toEqual([{ decision: 'accept' }]);
  });

  it('declines an approval on the wire when the turn registered no handler', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const session = await codexAgent(transport).openSession();

    await session.send('run ls');

    expect(transport.wire).toEqual([{ decision: 'decline' }]);
  });

  it('declines on the wire and fails the turn typed when the interaction handler throws (R7)', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const session = await codexAgent(transport).openSession();
    const started = Date.now();

    const pending = session.send('run ls', {
      onInteraction: async () => { throw new Error('UI crashed'); },
    });

    await expect(pending).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', message: expect.stringContaining('UI crashed') });
    expect(transport.wire).toEqual([{ decision: 'decline' }]);
    expect(Date.now() - started).toBeLessThan(500);
    // Same semantics as a missing handler: a typed turn failure fails the session.
    expect(session.state).toBe('failed');
    await session.close();
  });

  it('declines on the wire when the handler answers with a decision the provider never advertised (R7)', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const session = await codexAgent(transport).openSession();

    await expect(session.send('run ls', {
      onInteraction: async () => ({ kind: 'approval', decision: 'maybe' }),
    })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(transport.wire).toEqual([{ decision: 'decline' }]);
    await session.close();
  });

  it('keeps a stale handler failure from the previous turn out of the running one (R11)', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const session = await codexAgent(transport).openSession();
    let failStale!: (error: Error) => void;
    let markDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });

    // Turn one: the approval reaches a slow handler, then the turn is interrupted.
    const first = session.start('one', {
      onInteraction: () => { markDelivered(); return new Promise((_, reject) => { failStale = reject; }); },
    });
    await delivered;
    await expect(first.interrupt()).resolves.toMatchObject({ terminal: 'interrupted' });
    await expect(first.result).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(session.reconcile()).resolves.toBe('idle');

    // Turn two runs with a perfectly good handler; the old dialog fails mid-turn.
    transport.approvalOnTurn = false;
    transport.hangTurn = true;
    const second = session.start('two', { onInteraction: async () => ({ kind: 'approval', decision: 'accept' }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    failStale(new Error('old dialog closed'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    transport.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2' } });

    await expect(second.result).resolves.toMatchObject({ status: 'completed' });
    // The stale interaction was still declined on the wire.
    expect(transport.wire).toEqual([{ decision: 'decline' }]);
    await session.close();
  });

  it('delivers an interaction request after the events that preceded it on the wire', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    transport.deltaBeforeApproval = true;
    const session = await codexAgent(transport, { permissions: { mode: 'unrestricted' } }).openSession();

    const turn = await session.send('run ls', {
      onInteraction: async () => ({ kind: 'approval', decision: 'accept' }),
    });

    const types = turn.events.map((event) => event.type);
    expect(types.indexOf('message.delta')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('message.delta')).toBeLessThan(types.indexOf('interaction.requested'));
    await session.close();
  });

  it('keeps the opened approval ceiling when a caller tries to mutate readiness', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const agent = codexAgent(transport);
    const readiness = await agent.ready();
    const session = await agent.openSession();
    try {
      expect(Reflect.set(readiness.plan.envelope, 'permissionModeCeiling', 'bypassPermissions')).toBe(false);
      // The opened ceiling (acceptEdits) still refuses the escalation: the provider gets a decline, and the
      // handler's refused acceptance fails the turn typed instead of disappearing.
      await expect(session.send('run ls', {
        onInteraction: async () => ({ kind: 'approval', decision: 'accept' }),
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      expect(transport.wire).toEqual([{ decision: 'decline' }]);
    } finally { await session.close(); }
  });

  it('declines an escalation accepted through TurnHandle.respond below unrestricted and rejects respond() typed', async () => {
    const transport = new FakeCodexTransport();
    transport.approvalOnTurn = true;
    const session = await codexAgent(transport).openSession();
    try {
      const handle = session.start('run ls', { onInteraction: () => new Promise(() => {}) });
      let interactionId: string | undefined;
      for await (const event of handle.events) {
        if (event.type === 'interaction.requested') { interactionId = event.request.binding.interactionId; break; }
      }
      await expect(handle.respond!(interactionId!, { kind: 'approval', decision: 'accept' })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('declined on the wire'),
        context: { sanitizedDiagnostics: { requestedDecision: 'accept', wireDecision: 'decline' } },
      });
      await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
      expect(transport.wire).toEqual([{ decision: 'decline' }]);
    } finally { await session.close(); }
  });

  it('marks a persisted thread unknown when the app-server exits unexpectedly', async () => {
    const transport = new FakeCodexTransport();
    transport.hangTurn = true;
    const session = await codexAgent(transport).openSession();
    const handle = session.start('hello');

    await vi.waitFor(() => expect(transport.calls.some(call => call.method === 'turn/start')).toBe(true));
    transport.hooks?.onUnexpectedExit();

    await expect(handle.result).rejects.toThrow(/outcome of the in-flight turn/);
    expect(session.state).toBe('unknown');
  });

  it.each([
    ['analyze', 'read-only', 'on-request'],
    ['edit', 'workspace-write', 'on-request'],
    ['unrestricted', 'danger-full-access', 'never'],
  ] as const)('forks with the parent configuration in %s mode', async (mode, sandbox, approvalPolicy) => {
    const transport = new FakeCodexTransport();
    const session = await codexAgent(transport, {
      permissions: { mode }, instructions: 'Only inspect files.', effort: 'low',
    }).openSession({ persistence: 'process' });
    await session.send('hello');

    const fork = await session.forkAndSend('branch');

    expect(transport.calls.find(({ method }) => method === 'thread/fork')?.params).toMatchObject({
      threadId: 'thread-1', cwd: session.ref!.cwd, model: 'gpt-5.2-codex',
      sandbox, approvalPolicy, ephemeral: true, developerInstructions: 'Only inspect files.',
      config: { model_reasoning_effort: 'low' },
    });
    expect(fork.session.ref?.id).toBe('thread-1-fork');
    await fork.session.close();
    await session.close();
  });
});
