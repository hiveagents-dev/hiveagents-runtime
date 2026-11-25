import { expect, it } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import type { AdapterStreamItem, ExecAdapter, ProtocolResult } from '../../src/adapters/provider.js';

const result = (sessionId: string): ProtocolResult => ({ completed: true, failed: false, refused: false,
  sessionId, text: 'synthetic', events: [], nativeEvents: [], usage: { inputTokens: 5, costMeaning: 'unavailable' } });
function fixture() {
  const state = { next: result('original'), announcement: undefined as string | undefined };
  const adapter: ExecAdapter = { id: 'claude', detect: async () => ({ installed: true }),
    auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [],
    execute: async () => state.next,
    async *stream(): AsyncIterable<AdapterStreamItem> {
      if (state.announcement !== undefined) yield { kind: 'session', sessionId: state.announcement };
      yield { kind: 'result', result: state.next };
    } };
  return { state, agent: new Agent({ model: 'claude/opus-5', transport: 'exec' }, new Runtime({ adapters: [adapter] })) };
}

it.each(['send', 'start', 'stream'] as const)('%s refuses a changed terminal native id and keeps the original identity and usage', async mode => {
  const { state, agent } = fixture(), session = await agent.openSession(); await session.send('seed');
  state.next = result('foreign'); let error: unknown;
  try {
    if (mode === 'send') await session.send('next');
    else if (mode === 'start') await session.start('next').result;
    else for await (const _ of session.stream('next')) { /* drain */ }
  } catch (failure) { error = failure; }
  expect(error).toMatchObject({ code: 'PROTOCOL_ERROR', context: { retryable: false, observedUsage: { inputTokens: 5 } } });
  expect(session.ref?.id).toBe('original'); expect(session.export().id).toBe('original'); expect(session.state).toBe('failed');
  await session.close();
});

it('rejects an initialization/terminal id disagreement on the first stream', async () => {
  const { state, agent } = fixture(), session = await agent.openSession(); state.announcement = 'first'; state.next = result('other');
  await expect((async () => { for await (const _ of session.stream('first')) { /* drain */ } })()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  expect(session.ref?.id).toBe('first'); expect(session.state).toBe('failed'); await session.close();
});

it.each(['--latest', '../foreign', 'https://private.invalid/session', 'private.jsonl'])('refuses unsafe terminal ids at the SDK boundary: %s', async id => {
  const { state, agent } = fixture(), session = await agent.openSession(); state.next = result(id);
  await expect(session.send('first')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', context: { retryable: false, observedUsage: { inputTokens: 5 } } });
  expect(session.ref).toBeUndefined(); expect(session.state).toBe('failed'); await session.close();
});

it('validates identity before projecting a failed terminal', async () => {
  const { state, agent } = fixture(), session = await agent.openSession(); await session.send('seed');
  state.next = { ...result('foreign'), completed: false, failed: true, failure: { kind: 'usage-limit', message: 'synthetic limit' } };
  await expect(session.send('next')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', context: { observedUsage: { inputTokens: 5 } } });
  expect(session.ref?.id).toBe('original'); expect(session.state).toBe('failed'); await session.close();
});

it('retains a valid confirmed identity on an initial failed execute turn, like stream initialization', async () => {
  const { state, agent } = fixture(), session = await agent.openSession();
  state.next = { ...result('confirmed'), completed: false, failed: true, failure: { kind: 'usage-limit', message: 'synthetic limit' } };
  await expect(session.send('first')).rejects.toMatchObject({ code: 'USAGE_LIMIT', context: { session: { id: 'confirmed' } } });
  expect(session.ref?.id).toBe('confirmed'); expect(session.export().id).toBe('confirmed'); await session.close();
});

it('adopts a valid first terminal exactly once and retains the same identity on a later turn', async () => {
  const { agent } = fixture(), session = await agent.openSession(); const first = await session.send('first'), second = await session.send('second');
  expect(first.events.filter(event => event.type === 'session.started')).toHaveLength(1);
  expect(second.events.filter(event => event.type === 'session.started')).toHaveLength(0);
  expect(second.session).toEqual(first.session); await session.close();
});
