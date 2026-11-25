import { describe, expect, it } from 'vitest';

import { InteractionBroker } from '../../src/control/interaction-broker.js';
import type { InteractionRequest } from '../../src/public/types.js';
import { CodexDynamicToolHost } from '../../src/adapters/codex-control/dynamic-tools.js';
import { CodexInteractionBridge } from '../../src/adapters/codex-control/interactions.js';
import type { AgentRuntimeError } from '../../src/public/errors.js';
import { assertCodexApproval } from '../../src/adapters/codex-control/approval-policy.js';

function harness(options: { deliver?: boolean; dynamicTools?: CodexDynamicToolHost } = {}) {
  const broker = new InteractionBroker({ provider: 'codex', epoch: 'epoch-1' });
  const delivered: InteractionRequest[] = [];
  const errors: AgentRuntimeError[] = [];
  const bridge = new CodexInteractionBridge({
    broker,
    ...(options.deliver === false ? {} : { deliver: (request) => delivered.push(request) }),
    ...(options.dynamicTools === undefined ? {} : { dynamicTools: options.dynamicTools }),
    onTypedError: (error) => errors.push(error),
  });
  return { broker, bridge, delivered, errors };
}

const COMMAND_PARAMS = {
  itemId: 'item-1',
  threadId: 'th-1',
  turnId: 'turn-1',
  startedAtMs: 1,
  command: 'rm -rf ./dist',
  cwd: '/tmp/w',
};

describe('CodexInteractionBridge approvals', () => {
  function ceilingHarness(ceiling: string) {
    const broker = new InteractionBroker({ provider: 'codex', epoch: 'test' });
    const delivered: InteractionRequest[] = [];
    const errors: AgentRuntimeError[] = [];
    const bridge = new CodexInteractionBridge({
      broker, deliver: (request) => { delivered.push(request); }, onTypedError: (error) => errors.push(error),
      validateResponse: (method, response) => assertCodexApproval(ceiling, method, response),
    });
    return { broker, bridge, delivered, errors };
  }

  it.each([
    ['item/commandExecution/requestApproval', 'accept', 'decline'],
    ['item/fileChange/requestApproval', 'accept', 'decline'],
    ['execCommandApproval', 'approved', 'denied'],
    ['applyPatchApproval', 'approved', 'denied'],
  ])('declines %s on the wire when acceptance would widen the ceiling, and rejects respond() with a typed error', async (method, accept, decline) => {
    const { broker, bridge, delivered, errors } = ceilingHarness('acceptEdits');
    const wire = bridge.handleServerRequest(method, { ...COMMAND_PARAMS, call_id: 'call-1' }, 1);
    const refused = broker.respond(delivered[0]!.binding.interactionId, { decision: accept });
    await expect(refused).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      context: { sanitizedDiagnostics: { requestedDecision: accept, wireDecision: decline } },
    });
    await expect(refused).rejects.toThrow(/SafetyEnvelope.*declined on the wire/);
    await expect(wire).resolves.toEqual({ decision: decline });
    // The wire was written once with a real decision: the interaction is resolved, not expired.
    await expect(broker.respond(delivered[0]!.binding.interactionId, { decision: decline }))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR', message: 'Interaction already resolved' });
    expect(broker.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('passes an application decline through unchanged below the ceiling', async () => {
    const { broker, bridge, delivered } = ceilingHarness('plan');
    const wire = bridge.handleServerRequest('item/commandExecution/requestApproval', COMMAND_PARAMS, 2);
    await broker.respond(delivered[0]!.binding.interactionId, { decision: 'decline' });
    await expect(wire).resolves.toEqual({ decision: 'decline' });
  });

  it('declines persistent approvals even at bypassPermissions', async () => {
    const { broker, bridge, delivered } = ceilingHarness('bypassPermissions');
    const wire = bridge.handleServerRequest('item/commandExecution/requestApproval', COMMAND_PARAMS, 3);
    await expect(broker.respond(delivered[0]!.binding.interactionId, { decision: 'acceptForSession' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(wire).resolves.toEqual({ decision: 'decline' });
  });

  it('keeps failing permission grants with a JSON-RPC error: their response has no pinned mapping', async () => {
    const { broker, bridge, delivered } = ceilingHarness('bypassPermissions');
    const wire = bridge.handleServerRequest('item/permissions/requestApproval', COMMAND_PARAMS, 4);
    const rejectedWire = expect(wire).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(broker.respond(delivered[0]!.binding.interactionId, { decision: 'accept' }))
      .rejects.toThrow(/permission grants/);
    await rejectedWire;
  });
  it('settles a command approval on the wire through the broker', async () => {
    const { broker, bridge, delivered } = harness();
    const wire = bridge.handleServerRequest('item/commandExecution/requestApproval', COMMAND_PARAMS, 'req-1');

    expect(delivered).toHaveLength(1);
    const request = delivered[0]!;
    expect(request.kind).toBe('command-approval');
    expect(request.binding.sessionId).toBe('th-1');
    expect(request.binding.turnId).toBe('turn-1');
    expect(request.binding.providerRequestId).toBe('req-1');
    expect(request.availableDecisions).toContain('accept');
    expect(request.availableDecisions).toContain('decline');

    await broker.respond(request.binding.interactionId, { decision: 'accept' });
    await expect(wire).resolves.toEqual({ decision: 'accept' });
  });

  it('honors natively advertised decisions when the request carries them', async () => {
    const { broker, bridge, delivered } = harness();
    void bridge.handleServerRequest('item/commandExecution/requestApproval', {
      ...COMMAND_PARAMS,
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: {} }, 'decline'],
    }, 'req-2');

    const request = delivered[0]!;
    expect([...request.availableDecisions]).toEqual(['accept', 'acceptWithExecpolicyAmendment', 'decline']);
    await expect(broker.respond(request.binding.interactionId, { decision: 'acceptForSession' }))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await broker.respond(request.binding.interactionId, {
      decision: 'acceptWithExecpolicyAmendment',
      payload: { execpolicy_amendment: ['allow rm'] },
    });
  });

  it('declines on the wire FIRST when no handler is registered, then surfaces the typed error', async () => {
    const { broker, bridge, delivered, errors } = harness({ deliver: false });
    const wire = bridge.handleServerRequest('item/commandExecution/requestApproval', COMMAND_PARAMS, 'req-3');

    await expect(wire).resolves.toEqual({ decision: 'decline' });
    expect(delivered).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(broker.respond('missing-id', { decision: 'accept' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('declines on the wire when the broker expires a delivered interaction before any response (R7)', async () => {
    const { broker, bridge, delivered, errors } = harness();
    const wire = bridge.handleServerRequest('item/commandExecution/requestApproval', COMMAND_PARAMS, 'req-7');
    const request = delivered[0]!;
    const started = Date.now();

    expect(broker.expire(request.binding.interactionId, 'Interaction handler failed')).toBe(true);

    await expect(wire).resolves.toEqual({ decision: 'decline' });
    expect(Date.now() - started).toBeLessThan(50);
    expect(errors[0]).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(errors[0]?.message).toMatch(/Interaction handler failed/);
    // Expiring again, or after a settled response, writes nothing more.
    expect(broker.expire(request.binding.interactionId)).toBe(false);
  });

  it('fails user input on the wire when its interaction expires, since it has no decline (R7)', async () => {
    const { broker, bridge, delivered, errors } = harness();
    const wire = bridge.handleServerRequest('item/tool/requestUserInput', {
      itemId: 'item-9', threadId: 'th-1', turnId: 'turn-1', questions: [{ id: 'q', question: 'Why?' }],
    }, 'req-9');
    broker.expire(delivered[0]!.binding.interactionId, 'Interaction handler failed');

    await expect(wire).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(errors).toHaveLength(1);
  });

  it('maps legacy execCommandApproval onto the v1 review decisions', async () => {
    const { bridge, delivered } = harness();
    void bridge.handleServerRequest('execCommandApproval', {
      call_id: 'call-1',
      conversation_id: 'conv-1',
      command: ['rm', '-rf'],
    }, 4);
    const request = delivered[0]!;
    expect(request.kind).toBe('command-approval');
    expect([...request.availableDecisions]).toEqual(['approved', 'approved_for_session', 'denied', 'abort']);
    expect(request.binding.sessionId).toBe('conv-1');
  });

  it('rejects a late response after wire settlement without writing more bytes', async () => {
    const { broker, bridge, delivered } = harness();
    const wire = bridge.handleServerRequest('item/fileChange/requestApproval', {
      itemId: 'item-2', threadId: 'th-1', turnId: 'turn-1', startedAtMs: 2,
    }, 'req-5');
    const request = delivered[0]!;
    await broker.respond(request.binding.interactionId, { decision: 'accept' });
    await expect(wire).resolves.toEqual({ decision: 'accept' });

    await expect(broker.respond(request.binding.interactionId, { decision: 'decline' }))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
});

describe('CodexInteractionBridge user input and elicitation', () => {
  it('maps native questions into portable UserQuestion shapes and returns answers on the wire', async () => {
    const { broker, bridge, delivered } = harness();
    const wire = bridge.handleServerRequest('item/tool/requestUserInput', {
      itemId: 'item-3',
      threadId: 'th-1',
      turnId: 'turn-1',
      isBlocking: true,
      questions: [{
        id: 'q1',
        header: 'Deploy',
        question: 'Which environment?',
        isSecret: false,
        isOther: true,
        options: [{ label: 'staging', description: 'safe' }, { label: 'prod', description: 'scary' }],
      }],
    }, 'req-6');

    const request = delivered[0]!;
    expect(request.kind).toBe('user-input');
    if (request.kind !== 'user-input') throw new Error('unreachable');
    expect(request.questions).toEqual([{
      id: 'q1',
      header: 'Deploy',
      question: 'Which environment?',
      allowOther: true,
      options: [
        { id: 'staging', label: 'staging', description: 'safe' },
        { id: 'prod', label: 'prod', description: 'scary' },
      ],
    }]);

    await broker.respond(request.binding.interactionId, { decision: 'respond', answers: { q1: ['staging'] } });
    await expect(wire).resolves.toEqual({ answers: { q1: ['staging'] } });
  });

  it('settles elicitation accept with content and declines when no handler exists', async () => {
    const { broker, bridge, delivered } = harness();
    const wire = bridge.handleServerRequest('mcpServer/elicitation/request', {
      serverName: 'files',
      threadId: 'th-1',
      message: 'Need a token',
      mode: 'form',
      requestedSchema: { type: 'object' },
    }, 'req-7');
    const request = delivered[0]!;
    expect(request.kind).toBe('elicitation');
    await broker.respond(request.binding.interactionId, { decision: 'accept', content: { token: 'abc' } });
    await expect(wire).resolves.toEqual({ action: 'accept', content: { token: 'abc' } });

    const { bridge: silent, errors } = harness({ deliver: false });
    const declined = silent.handleServerRequest('mcpServer/elicitation/request', {
      serverName: 'files', threadId: 'th-1', message: 'Need a token', mode: 'form', requestedSchema: {},
    }, 'req-8');
    await expect(declined).resolves.toEqual({ action: 'decline' });
    expect(errors[0]).toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('fails unsupported server request methods on the wire with a typed error', async () => {
    const { bridge, errors } = harness();
    await expect(bridge.handleServerRequest('attestation/generate', {}, 'req-9'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(errors[0]).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('CodexInteractionBridge dynamic tools', () => {
  const host = new CodexDynamicToolHost({
    experimentalApi: true,
    tools: [{
      name: 'lookup',
      description: 'lookup',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
      handler: async (input) => ({ value: `found:${(input as { key: string }).key}` }),
    }],
  });

  it('executes a registered dynamic tool and settles the wire with its result', async () => {
    const { bridge } = harness({ dynamicTools: host });
    const wire = bridge.handleServerRequest('item/tool/call', {
      tool: 'lookup', arguments: { key: 'alpha' }, callId: 'call-1', threadId: 'th-1', turnId: 'turn-1',
    }, 'req-10');
    await expect(wire).resolves.toEqual({
      success: true, contentItems: [{ type: 'inputText', text: '{"value":"found:alpha"}' }],
    });
  });

  it('fails invalid tool input on the wire instead of running the handler', async () => {
    const { bridge } = harness({ dynamicTools: host });
    const wire = bridge.handleServerRequest('item/tool/call', {
      tool: 'lookup', arguments: { wrong: 1 }, callId: 'call-2', threadId: 'th-1', turnId: 'turn-1',
    }, 'req-11');
    await expect(wire).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('fails an unregistered tool call on the wire and surfaces a typed error', async () => {
    const { bridge, errors } = harness({ dynamicTools: host });
    const wire = bridge.handleServerRequest('item/tool/call', {
      tool: 'ghost', arguments: {}, callId: 'call-3', threadId: 'th-1', turnId: 'turn-1',
    }, 'req-12');
    await expect(wire).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(errors[0]).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('fails on the wire when no host exists at all', async () => {
    const { bridge, errors } = harness();
    const wire = bridge.handleServerRequest('item/tool/call', {
      tool: 'lookup', arguments: { key: 'x' }, callId: 'call-4', threadId: 'th-1', turnId: 'turn-1',
    }, 'req-13');
    await expect(wire).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(errors).toHaveLength(1);
  });
});
