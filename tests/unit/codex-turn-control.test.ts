import { afterEach, describe, expect, it, vi } from 'vitest';

import { TwoLaneDelivery } from '../../src/control/bounded-lanes.js';
import { CodexThreadRegistry } from '../../src/adapters/codex-control/identity.js';
import { CodexControlProjector, type CodexDelivery } from '../../src/adapters/codex-control/projector.js';
import { CODEX_INTERRUPT_GRACE_MS, CodexTurnControl } from '../../src/adapters/codex-control/turn-control.js';
import type { CodexRequester } from '../../src/adapters/codex-control/requester.js';

interface RecordedCall {
  method: string;
  params: unknown;
}

function harness(results: Record<string, unknown> = {}, hang: readonly string[] = [], fail: readonly string[] = []) {
  const calls: RecordedCall[] = [];
  const requester: CodexRequester = {
    async request(method, params) {
      calls.push({ method, params });
      if (hang.includes(method)) return new Promise<never>(() => {});
      if (fail.includes(method)) throw new Error(`${method} refused`);
      return results[method] ?? {};
    },
  };
  const registry = new CodexThreadRegistry({ epoch: 'epoch-1' });
  registry.register({ threadId: 'th-1', persistence: 'provider', cwd: '/tmp/w' });
  const projector = new CodexControlProjector({ registry });
  const delivery: CodexDelivery = new TwoLaneDelivery();
  projector.subscribe('th-1', delivery);
  const turns = new CodexTurnControl({ requester, registry, projector });
  return { turns, projector, registry, calls, delivery };
}

describe('CodexTurnControl', () => {
  it('starts a turn with normalized text input and records the turn id', async () => {
    const { turns, calls } = harness({ 'turn/start': { turn: { id: 'turn-1' } } });
    const receipt = await turns.startTurn('th-1', 'hola');
    expect(receipt.turnId).toBe('turn-1');
    expect(calls[0]).toEqual({
      method: 'turn/start',
      params: { threadId: 'th-1', input: [{ type: 'text', text: 'hola' }] },
    });
  });

  it('refuses unsupported input item types instead of dropping them', async () => {
    const { turns, calls } = harness();
    await expect(turns.startTurn('th-1', [{ type: 'image', path: '/tmp/x.png' }]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls).toHaveLength(0);
  });

  it('steers the active turn', async () => {
    const { turns, calls } = harness({ 'turn/start': { turnId: 'turn-1' }, 'turn/steer': {} });
    await turns.startTurn('th-1', 'hola');
    const receipt = await turns.steer('th-1', 'mejor en inglés');
    expect(receipt).toEqual({ accepted: true, turnId: 'turn-1' });
    expect(calls[1]).toMatchObject({
      method: 'turn/steer',
      params: { threadId: 'th-1', turnId: 'turn-1', input: [{ type: 'text', text: 'mejor en inglés' }] },
    });
  });

  it('completes interrupt only on the terminal notification, never on the RPC ack', async () => {
    const { turns, projector } = harness({ 'turn/start': { turnId: 'turn-1' }, 'turn/interrupt': { ok: true } });
    await turns.startTurn('th-1', 'trabajo largo');

    const interrupt = turns.interrupt('th-1');
    let settled = false;
    void interrupt.then(() => { settled = true; });
    // Give the RPC ack every chance to (wrongly) settle the receipt.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    projector.handleNotification('turn/interrupted', { threadId: 'th-1', turnId: 'turn-1' });
    await expect(interrupt).resolves.toEqual({ requested: true, terminal: 'interrupted' });
  });

  it('reports completed when the turn finished before the interrupt landed', async () => {
    const { turns, projector } = harness({ 'turn/start': {}, 'turn/interrupt': {} });
    await turns.startTurn('th-1', 'rápido');
    const interrupt = turns.interrupt('th-1');
    projector.handleNotification('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1' } });
    await expect(interrupt).resolves.toEqual({ requested: true, terminal: 'completed' });
  });

  it('never replays turns after transport death: new turns are refused, nothing is resent', async () => {
    const { turns, projector, calls } = harness({ 'turn/start': {} });
    await turns.startTurn('th-1', 'primero');
    projector.handleTransportDeath('crash');

    await expect(turns.startTurn('th-1', 'otra vez')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(turns.steer('th-1', 'steer')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  describe('interrupt deadline', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('settles as terminal unknown when no terminal notification arrives within the grace', async () => {
      vi.useFakeTimers();
      const { turns, projector } = harness({ 'turn/start': { turnId: 'turn-1' }, 'turn/interrupt': {} });
      await turns.startTurn('th-1', 'colgado');
      let receipt: unknown;
      void turns.interrupt('th-1').then((value) => { receipt = value; });

      await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS - 1);
      expect(receipt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(receipt).toEqual({ requested: true, terminal: 'unknown' });
      expect(vi.getTimerCount()).toBe(0);
      // The interrupt's own terminal waiter was withdrawn, not left queued until the next terminal.
      expect(projector.pendingTerminalWaiters('th-1')).toBe(0);

      // A terminal that arrives late is still observable through the projector.
      projector.handleNotification('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1' } });
      await expect(turns.waitForTerminal('th-1')).resolves.toMatchObject({ status: 'completed' });
    });

    it('keeps naming the turn after an unknown interrupt, so a retry or a steer still targets it', async () => {
      vi.useFakeTimers();
      const { turns, calls } = harness({ 'turn/start': { turnId: 'turn-1' }, 'turn/interrupt': {}, 'turn/steer': {} });
      await turns.startTurn('th-1', 'colgado');
      const first = turns.interrupt('th-1');
      await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS);
      await expect(first).resolves.toEqual({ requested: true, terminal: 'unknown' });

      const retry = turns.interrupt('th-1');
      await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS);
      await retry;
      await expect(turns.steer('th-1', 'sigue')).resolves.toEqual({ accepted: true, turnId: 'turn-1' });
      expect(calls.filter((call) => call.method !== 'turn/start').map((call) => call.params))
        .toEqual([
          { threadId: 'th-1', turnId: 'turn-1' },
          { threadId: 'th-1', turnId: 'turn-1' },
          { threadId: 'th-1', turnId: 'turn-1', input: [{ type: 'text', text: 'sigue' }] },
        ]);
    });

    it('bounds an interrupt RPC the server never answers', async () => {
      vi.useFakeTimers();
      const { turns, projector } = harness({ 'turn/start': { turnId: 'turn-1' } }, ['turn/interrupt']);
      await turns.startTurn('th-1', 'colgado');
      const interrupt = turns.interrupt('th-1');
      await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS);
      await expect(interrupt).resolves.toEqual({ requested: true, terminal: 'unknown' });
      expect(projector.pendingTerminalWaiters('th-1')).toBe(0);
    });

    it('does not accumulate waiters across repeated unknown interrupts', async () => {
      vi.useFakeTimers();
      const { turns, projector } = harness({ 'turn/start': { turnId: 'turn-1' }, 'turn/interrupt': {} });
      await turns.startTurn('th-1', 'colgado');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const interrupt = turns.interrupt('th-1');
        await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS);
        await expect(interrupt).resolves.toEqual({ requested: true, terminal: 'unknown' });
      }
      expect(projector.pendingTerminalWaiters('th-1')).toBe(0);
    });
  });

  describe('waitForTurnTerminal withdrawal', () => {
    it('withdraws an aborted waiter and still resolves the others on the terminal', async () => {
      const { turns, projector } = harness({ 'turn/start': { turnId: 'turn-1' } });
      await turns.startTurn('th-1', 'x');
      const stop = new AbortController();
      const withdrawn = projector.waitForTurnTerminal('th-1', stop.signal);
      const kept = projector.waitForTurnTerminal('th-1');
      expect(projector.pendingTerminalWaiters('th-1')).toBe(2);

      stop.abort(new Error('caller gave up'));
      await expect(withdrawn).rejects.toThrow('caller gave up');
      expect(projector.pendingTerminalWaiters('th-1')).toBe(1);

      projector.handleNotification('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1' } });
      await expect(kept).resolves.toMatchObject({ status: 'completed' });
    });

    it('rejects at once for a signal that is already aborted', async () => {
      const { turns, projector } = harness({ 'turn/start': { turnId: 'turn-1' } });
      await turns.startTurn('th-1', 'x');
      const stop = new AbortController();
      stop.abort(new Error('already gone'));
      await expect(projector.waitForTurnTerminal('th-1', stop.signal)).rejects.toThrow('already gone');
      expect(projector.pendingTerminalWaiters('th-1')).toBe(0);
    });

    it('still propagates an interrupt RPC failure that lands inside the grace', async () => {
      const { turns } = harness({ 'turn/start': { turnId: 'turn-1' } }, [], ['turn/interrupt']);
      await turns.startTurn('th-1', 'x');
      await expect(turns.interrupt('th-1')).rejects.toThrow('turn/interrupt refused');
    });
  });
});
