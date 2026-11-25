import { describe, expect, it } from 'vitest';

import { TwoLaneDelivery } from '../../src/control/bounded-lanes.js';
import type { AgentEvent } from '../../src/public/types.js';
import { CodexThreadRegistry } from '../../src/adapters/codex-control/identity.js';
import {
  CodexControlProjector,
  type CodexCriticalEvent,
  type CodexDelivery,
} from '../../src/adapters/codex-control/projector.js';

function makeProjector(persistence: 'provider' | 'process' = 'provider') {
  const registry = new CodexThreadRegistry({ epoch: 'epoch-1' });
  registry.register({ threadId: 'thread-1', persistence, cwd: '/tmp/w' });
  const projector = new CodexControlProjector({ registry });
  const delivery: CodexDelivery = new TwoLaneDelivery();
  projector.subscribe('thread-1', delivery);
  return { registry, projector, delivery };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('CodexControlProjector', () => {
  it('projects agent message deltas and treats the completed item text as authoritative', async () => {
    const { projector, delivery } = makeProjector();
    projector.noteTurnStarted('thread-1');
    projector.handleNotification('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'item-1', delta: 'Hel' });
    projector.handleNotification('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'item-1', delta: 'lo' });
    // The completed item disagrees with the accumulated deltas; it wins.
    projector.handleNotification('item/completed', {
      threadId: 'thread-1',
      item: { id: 'item-1', type: 'agentMessage', text: 'Hello, world' },
    });
    delivery.close();

    const events = await collect(delivery.publicLane);
    expect(events).toEqual([
      { type: 'message.delta', text: 'Hel' },
      { type: 'message.delta', text: 'lo' },
      { type: 'message.completed', text: 'Hello, world' },
    ]);
  });

  it('projects tool items through started/updated/completed', async () => {
    const { projector, delivery } = makeProjector();
    const item = { id: 'call-1', type: 'commandExecution', command: 'ls' };
    projector.handleNotification('item/started', { threadId: 'thread-1', item });
    projector.handleNotification('item/updated', { threadId: 'thread-1', item: { ...item, output: 'a' } });
    projector.handleNotification('item/completed', { threadId: 'thread-1', item: { ...item, exitCode: 0 } });
    delivery.close();

    const events = await collect(delivery.publicLane);
    expect(events.map((event) => event.type)).toEqual(['tool.started', 'tool.updated', 'tool.completed']);
    expect(events[0]).toMatchObject({ id: 'call-1', name: 'shell' });
  });

  it('preserves unknown notifications and unknown item types as provider events', async () => {
    const { projector, delivery } = makeProjector();
    projector.handleNotification('thread/experimentalTelemetry', { threadId: 'thread-1', blob: 42 });
    projector.handleNotification('item/completed', {
      threadId: 'thread-1',
      item: { id: 'x-1', type: 'quantum_widget', payload: true },
    });
    delivery.close();

    const events = await collect(delivery.publicLane);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === 'provider.event')).toBe(true);
    expect((events[0] as Extract<AgentEvent, { type: 'provider.event' }>).event).toMatchObject({
      method: 'thread/experimentalTelemetry',
    });
  });

  it('resolves terminal waits only from the terminal notification and rides the critical lane', async () => {
    const { projector, delivery } = makeProjector();
    projector.noteTurnStarted('thread-1');
    const wait = projector.waitForTurnTerminal('thread-1');
    let settled = false;
    void wait.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    projector.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-9', usage: { input_tokens: 10, output_tokens: 3 } },
    });
    const terminal = await wait;
    expect(terminal.status).toBe('completed');
    expect(terminal.turnId).toBe('turn-9');
    expect(terminal.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });

    delivery.close();
    const critical = await collect(delivery.criticalLane);
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ kind: 'turn-terminal', threadId: 'thread-1' });
  });

  it('maps turn/failed and turn/interrupted terminals', async () => {
    const { projector, delivery } = makeProjector();
    projector.noteTurnStarted('thread-1');
    projector.handleNotification('turn/failed', { threadId: 'thread-1', error: { message: 'boom' } });
    await expect(projector.waitForTurnTerminal('thread-1')).resolves.toMatchObject({
      status: 'failed',
      failureMessage: 'boom',
    });

    projector.noteTurnStarted('thread-1');
    projector.handleNotification('turn/completed', { threadId: 'thread-1', turn: { id: 't2', status: 'interrupted' } });
    await expect(projector.waitForTurnTerminal('thread-1')).resolves.toMatchObject({ status: 'interrupted' });
    delivery.close();
  });

  it.each([
    [{ message: 'nested failure' }, { message: 'outer diagnostic' }, 'nested failure'],
    [null, { message: 'outer failure' }, 'outer failure'],
    [null, undefined, 'Codex turn failed'],
  ])('maps failed status on turn/completed and preserves evidence (%s)', async (error, outerError, message) => {
    const { projector, delivery } = makeProjector();
    projector.noteTurnStarted('thread-1');
    const payload = {
      threadId: 'thread-1', error: outerError,
      turn: { id: 'failed-turn', status: 'failed', error, usage: { input_tokens: 11, output_tokens: 2 } },
    };
    projector.handleNotification('turn/completed', payload);
    await expect(projector.waitForTurnTerminal('thread-1')).resolves.toMatchObject({
      status: 'failed', turnId: 'failed-turn', failureMessage: message,
      usage: { inputTokens: 11, outputTokens: 2 }, raw: payload,
    });
    delivery.close();
    expect(await collect(delivery.criticalLane)).toMatchObject([
      { kind: 'turn-terminal', terminal: { status: 'failed' } },
    ]);
  });

  it('surfaces persisted-thread transport death as state unknown requiring reconcile', async () => {
    const { registry, projector, delivery } = makeProjector('provider');
    projector.noteTurnStarted('thread-1');
    const wait = projector.waitForTurnTerminal('thread-1');
    wait.catch(() => undefined);

    projector.handleTransportDeath('app-server crashed');

    expect(registry.state('thread-1')).toBe('unknown');
    await expect(wait).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const critical = await collect(delivery.criticalLane);
    const state = critical.find((event): event is Extract<CodexCriticalEvent, { kind: 'thread-state' }> => event.kind === 'thread-state');
    expect(state).toMatchObject({ state: 'unknown' });
    expect(state?.info.message).toContain('reconcile');
  });

  it('surfaces ephemeral-thread transport death as a terminal failure', async () => {
    const { registry, projector, delivery } = makeProjector('process');
    projector.noteTurnStarted('thread-1');
    const wait = projector.waitForTurnTerminal('thread-1');

    projector.handleTransportDeath('app-server crashed');

    expect(registry.state('thread-1')).toBe('failed');
    await expect(wait).resolves.toMatchObject({ status: 'failed' });
    const critical = await collect(delivery.criticalLane);
    expect(critical.map((event) => event.kind)).toEqual(['turn-terminal', 'thread-state']);
    expect(critical[1]).toMatchObject({ state: 'failed' });
  });
});

describe('CodexControlProjector stdout noise (R3)', () => {
  it('surfaces tolerated non-JSON stdout lines as provider events on active turns only', async () => {
    const { projector, delivery } = makeProjector();
    projector.noteNoise('ignored: no turn is active');
    projector.noteTurnStarted('thread-1');
    projector.noteNoise('WARN: plain text on stdout');
    delivery.close();

    const events = await collect(delivery.publicLane);
    expect(events).toEqual([{
      type: 'provider.event',
      provider: 'codex',
      event: { method: 'stdout/noise', line: 'WARN: plain text on stdout' },
    }]);
  });
});
