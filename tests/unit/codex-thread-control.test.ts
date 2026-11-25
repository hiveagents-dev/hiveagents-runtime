import { describe, expect, it } from 'vitest';

import { TwoLaneDelivery } from '../../src/control/bounded-lanes.js';
import { listModels, readAccount } from '../../src/adapters/codex-control/catalog.js';
import { CodexDynamicToolHost } from '../../src/adapters/codex-control/dynamic-tools.js';
import { CodexThreadRegistry } from '../../src/adapters/codex-control/identity.js';
import { CodexControlProjector, type CodexDelivery } from '../../src/adapters/codex-control/projector.js';
import { CodexThreadControl } from '../../src/adapters/codex-control/thread-control.js';
import type { CodexRequester } from '../../src/adapters/codex-control/requester.js';

interface RecordedCall {
  method: string;
  params: unknown;
}

function fakeRequester(results: Record<string, unknown>): { requester: CodexRequester; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    requester: {
      async request(method, params) {
        calls.push({ method, params });
        if (!(method in results)) throw new Error(`Unexpected RPC ${method}`);
        return results[method];
      },
    },
  };
}

function makeControl(results: Record<string, unknown>, dynamicTools?: CodexDynamicToolHost) {
  const { requester, calls } = fakeRequester(results);
  const registry = new CodexThreadRegistry({ epoch: 'epoch-7' });
  const projector = new CodexControlProjector({ registry });
  const control = new CodexThreadControl({
    requester,
    registry,
    projector,
    cwd: '/tmp/workspace',
    ...(dynamicTools === undefined ? {} : { dynamicTools }),
  });
  const delivery: CodexDelivery = new TwoLaneDelivery();
  return { control, registry, projector, calls, delivery };
}

const echoTool = new CodexDynamicToolHost({
  experimentalApi: true,
  tools: [{
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object' },
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    handler: async (input) => input,
  }],
});

describe('CodexThreadControl', () => {
  it('starts a thread and registers a full SessionIdentity', async () => {
    const { control, registry, calls, delivery } = makeControl({ 'thread/start': { threadId: 'th-1' } });
    const identity = await control.startThread({ delivery, model: 'gpt-5.6-sol' });

    expect(calls[0]).toMatchObject({ method: 'thread/start', params: { cwd: '/tmp/workspace', model: 'gpt-5.6-sol' } });
    expect(identity).toMatchObject({
      schemaVersion: 1,
      provider: 'codex',
      transport: 'control',
      transportEpoch: 'epoch-7',
      id: 'th-1',
      sessionId: 'th-1',
      persistence: 'provider',
      cwd: '/tmp/workspace',
      model: 'gpt-5.6-sol',
    });
    expect(typeof identity.createdAt).toBe('string');
    expect(registry.state('th-1')).toBe('active');
  });

  it('fails typed when the thread response carries no thread id', async () => {
    const { control, delivery } = makeControl({ 'thread/start': { ok: true } });
    await expect(control.startThread({ delivery })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('forks a thread and records lineage', async () => {
    const { control, delivery } = makeControl({
      'thread/start': { threadId: 'th-1' },
      'thread/fork': { threadId: 'th-2' },
    });
    await control.startThread({ delivery });
    const fork = await control.forkThread('th-1', { delivery: new TwoLaneDelivery() });
    expect(fork.id).toBe('th-2');
    expect(fork.forkedFromId).toBe('th-1');
  });

  it('resumes with provider persistence and passes the thread through', async () => {
    const { control, calls, delivery } = makeControl({ 'thread/resume': {} });
    const identity = await control.resumeThread({ threadId: 'th-9', delivery });
    expect(calls[0]).toMatchObject({ method: 'thread/resume', params: { threadId: 'th-9' } });
    expect(identity.persistence).toBe('provider');
    expect(identity.id).toBe('th-9');
  });

  it('declares dynamic tools on thread/start and refuses hash-mismatched rebind on resume', async () => {
    const { control, calls, delivery } = makeControl(
      { 'thread/start': { threadId: 'th-1' }, 'thread/resume': {} },
      echoTool,
    );
    await control.startThread({ delivery });
    const startParams = calls[0]?.params as { dynamicTools?: unknown };
    expect(Array.isArray(startParams.dynamicTools)).toBe(true);

    await expect(control.resumeThread({
      threadId: 'th-1',
      delivery,
      toolRegistryHash: 'deadbeef',
    })).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    // The mismatch is detected before any RPC: no thread/resume was sent.
    expect(calls.filter((call) => call.method === 'thread/resume')).toHaveLength(0);

    await expect(control.resumeThread({
      threadId: 'th-1',
      delivery,
      toolRegistryHash: echoTool.registryHash(),
    })).resolves.toMatchObject({ id: 'th-1' });
  });

  it('reads threads verbatim', async () => {
    const { control } = makeControl({ 'thread/read': { items: [1, 2] } });
    await expect(control.readThread('th-1')).resolves.toEqual({ items: [1, 2] });
  });
});

describe('codex model/list and account/read wrappers', () => {
  it('maps the advertised catalog without claiming entitlement', async () => {
    const { requester } = fakeRequester({
      'model/list': {
        data: [
          { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'high'] },
          { id: 'gpt-5.6-mini' },
          { notAnId: true },
        ],
      },
    });
    const catalog = await listModels(requester);
    expect(catalog.provider).toBe('codex');
    expect(catalog.source).toBe('app-server');
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]).toMatchObject({
      id: 'gpt-5.6-sol',
      availability: 'unverified',
      displayName: 'GPT-5.6 Sol',
      supportedEffort: ['low', 'high'],
    });
  });

  it('preserves official structured reasoning efforts without exposing descriptions', async () => {
    const { requester, calls } = fakeRequester({
      'model/list': { data: [{ id: 'advertised-model', supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Quick response' },
        { reasoningEffort: 'high', description: 'More reasoning' },
        null, { reasoningEffort: 42 }, { description: 'missing effort' },
      ] }], nextCursor: null },
    });
    const catalog = await listModels(requester);
    expect(catalog.models[0]).toMatchObject({ supportedEffort: ['low', 'high'], availability: 'unverified' });
    expect(JSON.stringify(catalog)).not.toContain('Quick response');
    expect(calls).toEqual([{ method: 'model/list', params: {} }]);
  });

  it('fails typed on a malformed model/list response', async () => {
    const { requester } = fakeRequester({ 'model/list': { nope: true } });
    await expect(listModels(requester)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('redacts account/read down to plan-level information', async () => {
    const { requester } = fakeRequester({
      'account/read': {
        account: {
          email: 'person@example.com',
          organizationId: 'org-123456',
          accountId: 'acct-9',
          planType: 'pro',
          authMode: 'chatgpt',
          tokens: { access: 'secret-token' },
        },
      },
    });
    const account = await readAccount(requester);
    expect(account).toEqual({ plan: 'pro', authMethod: 'chatgpt' });
    const serialized = JSON.stringify(account);
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('org-123456');
    expect(serialized).not.toContain('secret-token');
  });

  it('returns an empty redacted account when no plan fields exist', async () => {
    const { requester } = fakeRequester({ 'account/read': { email: 'p@example.com' } });
    await expect(readAccount(requester)).resolves.toEqual({});
  });
});
