import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRecoveryCoordinator } from '../../src/adapters/codex-control/recovery.js';
import { CodexThreadRegistry } from '../../src/adapters/codex-control/identity.js';
import { CodexControlProjector } from '../../src/adapters/codex-control/projector.js';
import { CodexThreadControl } from '../../src/adapters/codex-control/thread-control.js';
import { ControlBuffer } from '../../src/control/event-spool.js';
import { TwoLaneDelivery } from '../../src/control/bounded-lanes.js';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('Codex recovery attempt lifetime', () => {
  it('shares one owned attempt and candidate epoch between concurrent callers', async () => {
    const recovery = new CodexRecoveryCoordinator(), gate = deferred<'active'>(), epochs: string[] = [];
    const work = vi.fn(async attempt => { epochs.push(attempt.epoch); await gate.promise; return attempt.commit(() => {}) ? 'active' as const : 'unknown' as const; });
    const first = recovery.reconcile(work), second = recovery.reconcile(work); await flush();
    expect(work).toHaveBeenCalledTimes(1); expect(first).toBe(second); expect(epochs[0]).toMatch(/^[a-f0-9-]{36}$/u);
    gate.resolve('active'); await expect(first).resolves.toBe('active');
  });
  it('times out at 5000ms and quarantines a late starter until observed cleanup settles', async () => {
    vi.useFakeTimers(); const recovery = new CodexRecoveryCoordinator(), starter = deferred<void>(), close = vi.fn(async () => {});
    const work = vi.fn(async attempt => { await starter.promise; attempt.onInvalidate(close); return 'active' as const; });
    const first = recovery.reconcile(work); await flush(); await vi.advanceTimersByTimeAsync(5000);
    await expect(first).resolves.toBe('unknown'); await expect(recovery.reconcile(work)).resolves.toBe('unknown');
    expect(work).toHaveBeenCalledTimes(1); starter.resolve(); await flush(); await recovery.drainKnownCleanup();
    expect(close).toHaveBeenCalledTimes(1); await flush();
    await expect(recovery.reconcile(async attempt => attempt.commit(() => {}) ? 'active' : 'unknown')).resolves.toBe('active');
  });
  it('cannot adopt after its deadline even before an overdue timer callback runs', async () => {
    vi.useFakeTimers(); const recovery = new CodexRecoveryCoordinator(), gate = deferred<void>(), close = vi.fn(async () => {});
    const work = recovery.reconcile(async attempt => { attempt.onInvalidate(close); await gate.promise; return attempt.isCurrent() ? 'active' : 'unknown'; });
    await flush(); vi.setSystemTime(Date.now() + 5001); gate.resolve();
    await expect(work).resolves.toBe('unknown'); expect(close).toHaveBeenCalledTimes(1);
  });
  it('refuses a claimed active result when no adoption commit occurred', async () => {
    const recovery = new CodexRecoveryCoordinator(), close = vi.fn(async () => {});
    await expect(recovery.reconcile(async attempt => { attempt.onInvalidate(close); return 'active'; })).resolves.toBe('unknown');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('fences close immediately, observes a late rejection and never starts another attempt', async () => {
    const recovery = new CodexRecoveryCoordinator(), gate = deferred<void>();
    const first = recovery.reconcile(async () => { await gate.promise; return 'active'; }); await flush();
    recovery.invalidate(); await expect(first).resolves.toBe('closed');
    gate.reject(new Error('late native failure')); await flush();
    const next = vi.fn(async () => 'active' as const); await expect(recovery.reconcile(next)).resolves.toBe('closed'); expect(next).not.toHaveBeenCalled();
  });
  it('awaits already-known cleanup and retains single flight while cleanup is pending', async () => {
    const recovery = new CodexRecoveryCoordinator(), workGate = deferred<void>(), closeGate = deferred<void>();
    const close = vi.fn(() => closeGate.promise);
    const first = recovery.reconcile(async attempt => { attempt.onInvalidate(close); await workGate.promise; return 'active'; }); await flush();
    recovery.invalidate(); await expect(first).resolves.toBe('closed'); expect(close).toHaveBeenCalledTimes(1);
    let settled = false; const cleanup = recovery.drainKnownCleanup().then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
    workGate.resolve(); closeGate.resolve(); await cleanup; expect(close).toHaveBeenCalledTimes(1);
  });
});

// Metadata projection: official App Server docs, retrieved 2026-11-09 (read summary + newest turns page).
// Synthetic fixture IDs/status variants below are not generated 0.149.0 response schemas.
function inspection(read: unknown = { thread: { id: 'thread-1', status: { type: 'idle' }, cwd: '/fixture', model: 'fixture-model' } },
  page: unknown = { data: [{ id: 'turn-1', status: 'completed' }], nextCursor: 'older', backwardsCursor: null }) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const registry = new CodexThreadRegistry({ epoch: 'new-epoch' }), projector = new CodexControlProjector({ registry });
  const control = new CodexThreadControl({ registry, projector, cwd: '/fixture', requester: { request: async (method, params) => {
    calls.push({ method, params }); if (method === 'thread/read') return read; if (method === 'thread/turns/list') return page;
    if (method === 'thread/resume') return read; throw new Error(`Unplanned RPC ${method}`);
  } } });
  return { control, registry, calls };
}
describe('bounded Codex recovery inspection', () => {
  it('reads explicit idle metadata and exactly one newest turn without full history', async () => {
    const f = inspection();
    await expect(f.control.readForRecovery('thread-1')).resolves.toEqual({ threadId: 'thread-1', status: 'idle', cwd: '/fixture', model: 'fixture-model', latestTurn: { id: 'turn-1', status: 'completed' } });
    expect(f.calls).toEqual([{ method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } },
      { method: 'thread/turns/list', params: { threadId: 'thread-1', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' } }]);
  });
  it.each(['active', 'notLoaded', 'systemError', 'future', undefined])('rejects status %s even when summary turns is empty', async type => {
    const f = inspection({ thread: { id: 'thread-1', status: { type }, turns: [] } });
    await expect(f.control.readForRecovery('thread-1')).resolves.toBeUndefined(); expect(f.calls).toHaveLength(1);
  });
  it.each([
    { data: [{ id: 'turn-1', status: 'inProgress' }], nextCursor: null, backwardsCursor: null },
    { data: [{ id: 'turn-1', status: 'unknown' }], nextCursor: null, backwardsCursor: null },
    { data: [{ id: 'turn-1', status: 'completed' }, { id: 'turn-2', status: 'completed' }], nextCursor: null, backwardsCursor: null },
    { data: [], nextCursor: 'contradiction', backwardsCursor: null }, { data: [], nextCursor: null },
  ])('rejects indeterminate or contradictory latest-page data %j', async page => {
    const f = inspection(undefined, page); await expect(f.control.readForRecovery('thread-1')).resolves.toBeUndefined();
  });
  it('accepts empty latest history only as a bounded explicit-empty view for the caller to check', async () => {
    await expect(inspection(undefined, { data: [], nextCursor: null, backwardsCursor: null }).control.readForRecovery('thread-1')).resolves.toMatchObject({ threadId: 'thread-1', status: 'idle' });
  });
  it('rejects foreign and conflicting thread IDs without reading history', async () => {
    for (const read of [{ thread: { id: 'foreign', status: { type: 'idle' } } },
      { threadId: 'foreign', thread: { id: 'thread-1', status: { type: 'idle' } } }]) {
      const f = inspection(read); await expect(f.control.readForRecovery('thread-1')).resolves.toBeUndefined(); expect(f.calls).toHaveLength(1);
    }
  });
  it('does not execute accessors or retain transcript fields', async () => {
    const getter = vi.fn(), read = { thread: { id: 'thread-1', status: { type: 'idle' }, get cwd() { getter(); return '/fixture'; } } };
    await expect(inspection(read).control.readForRecovery('thread-1')).resolves.toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  });
  it('keeps a recovery resume unwritable until exact-epoch activation and rejects foreign IDs', async () => {
    const f = inspection(); const identity = await f.control.resumeThread({ threadId: 'thread-1', delivery: new TwoLaneDelivery(), recovering: true });
    expect(f.registry.state('thread-1')).toBe('unknown'); expect(() => f.registry.assertWritable('thread-1')).toThrow();
    const activated = f.registry.activateRecovered('thread-1', identity, undefined);
    expect(activated.transportEpoch).toBe('new-epoch'); expect(Object.isFrozen(activated)).toBe(true); expect(f.registry.state('thread-1')).toBe('active');
    const foreign = inspection({ thread: { id: 'foreign' } });
    await expect(foreign.control.resumeThread({ threadId: 'thread-1', delivery: new TwoLaneDelivery(), recovering: true })).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
  });
});

import { openCodexControlSession, type CodexControlFactoryOptions, type CodexControlTransport, type CodexTransportStartOptions } from '../../src/adapters/codex-control/factory.js';
import type { ControlSessionHandle, ControlSessionRequest } from '../../src/session/control-session.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
import type { InteractionRequest } from '../../src/public/types.js';
import { CodexDynamicToolHost } from '../../src/adapters/codex-control/dynamic-tools.js';

function sessionRequest(): ControlSessionRequest {
  return { model: { provider: 'codex', id: 'fixture-model', aliases: [], source: 'explicit', availability: 'unverified' },
    cwd: '/fixture', persistence: 'provider', env: { FIXTURE: 'original' }, experimentalApi: true, capabilities: {},
    envelope: { filesystem: { readonlyRoots: ['/fixture'], writableRoots: [] }, authorityEpoch: 'original-authority',
      network: [], tools: [], executables: [], mcpServers: [], environmentVariables: [], settingsPersistence: 'none', enforcedBy: ['sandbox'], permissionModeCeiling: 'plan' } };
}
type History = Map<string, { id: string; status: string }>;
class RecoveryTransport implements CodexControlTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly gates = new Map<string, Promise<void>>(); readonly overrides = new Map<string, unknown>();
  closes = 0; hangTurn = false;
  constructor(readonly hooks: CodexTransportStartOptions, readonly history: History, readonly counter: { value: number }) {}
  async request(method: string, input: unknown): Promise<unknown> {
    const params = input as Record<string, unknown>; this.calls.push({ method, params });
    const threadId = typeof params.threadId === 'string' ? params.threadId : 'thread-1';
    if (method === 'turn/start') {
      const id = `turn-${++this.counter.value}`; this.history.set(threadId, { id, status: 'inProgress' });
      queueMicrotask(() => {
        this.hooks.onNotification('turn/started', { threadId, turnId: id });
        this.hooks.onNotification('item/completed', { threadId, item: { id: 'message', type: 'agentMessage', text: 'done' } });
        if (!this.hangTurn) this.complete(threadId);
      });
    }
    await this.gates.get(method);
    if (this.overrides.has(method)) { const value = this.overrides.get(method); if (value instanceof Error) throw value; return value; }
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'thread/fork') return { thread: { id: 'sibling' } };
    if (method === 'thread/resume') return { thread: { id: threadId } };
    if (method === 'thread/read') return { thread: { id: threadId, cwd: '/fixture', model: 'fixture-model', status: { type: 'idle' } } };
    if (method === 'thread/turns/list') return { data: this.history.has(threadId) ? [this.history.get(threadId)] : [], nextCursor: null, backwardsCursor: null };
    if (method === 'turn/start') return { turnId: this.history.get(threadId)!.id };
    if (method === 'turn/interrupt') { this.complete(threadId, 'interrupted'); return {}; }
    return {};
  }
  complete(threadId = 'thread-1', status = 'completed'): void {
    const turn = this.history.get(threadId); if (!turn) return;
    this.history.set(threadId, { ...turn, status });
    this.hooks.onNotification('turn/completed', { threadId, turn: { ...turn, status } });
  }
  async close(): Promise<void> { this.closes++; }
}
const controls: ControlSessionHandle[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const control of controls.splice(0)) await control.close(); });
async function controlFixture(options: CodexControlFactoryOptions = {}, request = sessionRequest()) {
  const history: History = new Map(), transports: RecoveryTransport[] = [], counter = { value: 0 };
  let configure: ((transport: RecoveryTransport) => void) | undefined, starterGate: Promise<void> | undefined;
  const factory = { ...options, startTransport: async (hooks: CodexTransportStartOptions) => {
    const transport = new RecoveryTransport(hooks, history, counter); transports.push(transport);
    if (transports.length > 1) { configure?.(transport); await starterGate; }
    return transport;
  } };
  const control = await openCodexControlSession(request, factory); controls.push(control);
  return { control, transports, history, request, factory,
    configure: (callback: (transport: RecoveryTransport) => void) => { configure = callback; },
    gateStarter: (gate: Promise<void>) => { starterGate = gate; } };
}
async function completed(control: ControlSessionHandle) {
  const turn = await control.startTurn({ input: 'fixture' }); const items = [];
  for await (const item of turn.stream) items.push(item);
  expect(items.at(-1)).toMatchObject({ kind: 'result', result: { text: 'done' } }); return turn;
}
describe('same-thread persisted Codex control reconciliation', () => {
  it('deduplicates explicit recovery, preserves the captured policy, and never replays a prompt', async () => {
    const f = await controlFixture({ args: ['--fixture-original'] }); await completed(f.control);
    const old = f.control.identity!, epoch = f.control.transportEpoch; f.transports[0]!.hooks.onUnexpectedExit();
    expect(f.control.state()).toBe('unknown'); f.request.env.FIXTURE = 'mutated'; f.request.envelope.permissionModeCeiling = 'bypassPermissions'; f.factory.args![0] = '--mutated';
    const first = f.control.reconcile!(), second = f.control.reconcile!();
    await expect(first).resolves.toBe('active'); await expect(second).resolves.toBe('active');
    expect(f.transports).toHaveLength(2); expect(f.control.transportEpoch).not.toBe(epoch);
    expect(f.control.identity).toMatchObject({ ...old, transportEpoch: f.control.transportEpoch });
    const candidate = f.transports[1]!;
    expect(candidate.hooks.env.FIXTURE).toBe('original'); expect(candidate.hooks.args).toContain('--fixture-original');
    expect(candidate.calls.map(call => call.method)).toEqual(['thread/resume', 'thread/read', 'thread/turns/list']);
    expect(candidate.calls[0]!.params).toMatchObject({ threadId: old.id, cwd: '/fixture', model: 'fixture-model', sandbox: 'read-only', approvalPolicy: 'on-request' });
    await completed(f.control); expect(candidate.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });
  it('does not replace a live transport, a process-only failure, or a live-transport output failure', async () => {
    const live = await controlFixture(); await expect(live.control.reconcile!()).resolves.toBe('active'); expect(live.transports).toHaveLength(1);
    const processOnly = await controlFixture({}, { ...sessionRequest(), persistence: 'process' }); processOnly.transports[0]!.hooks.onUnexpectedExit();
    await expect(processOnly.control.reconcile!()).resolves.toBe('failed'); expect(processOnly.transports).toHaveLength(1);
    const failed = await controlFixture(); const turn = await failed.control.startTurn({ input: 'fixture' }); await turn.stream[Symbol.asyncIterator]().return?.();
    await expect(failed.control.reconcile!()).resolves.toBe('unknown'); expect(failed.transports).toHaveLength(1);
  });
  it.each(['thread/resume', 'thread/read', 'thread/turns/list'])('keeps failed %s unknown and closes its candidate', async method => {
    const f = await controlFixture(); await completed(f.control); const epoch = f.control.transportEpoch;
    f.transports[0]!.hooks.onUnexpectedExit(); f.configure(candidate => candidate.overrides.set(method, new Error('fixture refusal')));
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports[1]!.closes).toBe(1); expect(f.control.transportEpoch).toBe(epoch);
  });
  it.each([
    ['thread/resume', { thread: { id: 'foreign' } }], ['thread/read', { thread: { id: 'thread-1', status: { type: 'active', activeFlags: [] } } }],
    ['thread/turns/list', { data: [{ id: 'turn-1', status: 'failed' }], nextCursor: null, backwardsCursor: null }],
    ['thread/turns/list', { data: [], nextCursor: null, backwardsCursor: null }],
    ['thread/turns/list', { data: [{ id: 'foreign-turn', status: 'completed' }], nextCursor: null, backwardsCursor: null }],
  ])('refuses contradictory candidate %s %j', async (method, response) => {
    const f = await controlFixture(); await completed(f.control); f.transports[0]!.hooks.onUnexpectedExit(); f.configure(candidate => candidate.overrides.set(method as string, response));
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports[1]!.closes).toBe(1);
  });
  it('allows empty history only when no turn was ever dispatched', async () => {
    const f = await controlFixture(); f.transports[0]!.hooks.onUnexpectedExit(); await expect(f.control.reconcile!()).resolves.toBe('active');
    expect(f.transports[1]!.calls.map(call => call.method)).toEqual(['thread/resume', 'thread/read', 'thread/turns/list']);
  });
  it('can recover a never-dispatched local handle whose persisted thread already has terminal history', async () => {
    const f = await controlFixture(); f.history.set('thread-1', { id: 'historic', status: 'completed' }); f.transports[0]!.hooks.onUnexpectedExit();
    await expect(f.control.reconcile!()).resolves.toBe('active');
  });
  it('does not reinterpret an unacknowledged start as absent after its old RPC eventually rejects', async () => {
    const f = await controlFixture(), gate = deferred<void>(); f.transports[0]!.gates.set('turn/start', gate.promise);
    const start = f.control.startTurn({ input: 'unknown dispatch' }); void start.catch(() => undefined);
    await vi.waitFor(() => expect(f.transports[0]!.calls.some(call => call.method === 'turn/start')).toBe(true));
    f.transports[0]!.hooks.onUnexpectedExit(); gate.resolve(); await start.catch(() => undefined);
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1);
  });
  it('rejects undrained delivery and pending old native work before starting another transport', async () => {
    const f = await controlFixture(); f.transports[0]!.hangTurn = true;
    const gate = deferred<void>(); f.transports[0]!.gates.set('turn/steer', gate.promise);
    const turn = await f.control.startTurn({ input: 'fixture' });
    const pending = turn.steer!('extra'); void pending.catch(() => undefined);
    f.transports[0]!.hooks.onUnexpectedExit(); await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1);
    await expect((async () => { for await (const _item of turn.stream) {} })()).rejects.toBeDefined();
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1);
    gate.resolve(); await pending.catch(() => undefined); f.history.set('thread-1', { id: 'turn-1', status: 'completed' });
    await expect(f.control.reconcile!()).resolves.toBe('active');
  });
  it('blocks recovery while an old application callback ignores cancellation', async () => {
    const callback = deferred<unknown>(), entered = deferred<void>();
    const f = await controlFixture({ tools: [{ name: 'lookup', description: 'fixture', inputSchema: { type: 'object' }, timeoutMs: 1000, maxOutputBytes: 100,
      handler: async () => { entered.resolve(); return callback.promise; } }] });
    const wire = f.transports[0]!.hooks.onServerRequest('item/tool/call', { threadId: 'thread-1', turnId: 'old', callId: 'call', tool: 'lookup', arguments: {} }, 'tool'); void wire.catch(() => undefined);
    await entered.promise; f.transports[0]!.hooks.onUnexpectedExit(); await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1);
    callback.resolve(null); await wire.catch(() => undefined); await flush(); await expect(f.control.reconcile!()).resolves.toBe('active');
  });
  it.each(['starter', 'thread/resume', 'thread/read', 'thread/turns/list'])('fences close racing %s and observes late candidate cleanup', async boundary => {
    const f = await controlFixture(); await completed(f.control); f.transports[0]!.hooks.onUnexpectedExit(); const epoch = f.control.transportEpoch, gate = deferred<void>();
    if (boundary === 'starter') f.gateStarter(gate.promise); else f.configure(candidate => candidate.gates.set(boundary, gate.promise));
    const work = f.control.reconcile!(); await vi.waitFor(() => expect(f.transports).toHaveLength(2));
    if (boundary !== 'starter') await vi.waitFor(() => expect(f.transports[1]!.calls.some(call => call.method === boundary)).toBe(true));
    await f.control.close(); await expect(work).resolves.toBe('closed'); gate.resolve();
    await vi.waitFor(() => expect(f.transports[1]!.closes).toBe(1)); expect(f.control.state()).toBe('closed'); expect(f.control.transportEpoch).toBe(epoch);
  });
  it('does not adopt candidate activity or death between its inspected response and commit', async () => {
    for (const death of [false, true]) {
      const f = await controlFixture(); await completed(f.control); f.transports[0]!.hooks.onUnexpectedExit();
      f.configure(candidate => {
        const original = candidate.request.bind(candidate);
        candidate.request = async (method, params) => { const result = await original(method, params); if (method === 'thread/turns/list') {
          if (death) candidate.hooks.onUnexpectedExit(); else candidate.hooks.onNotification('turn/started', { threadId: 'thread-1', turnId: 'unowned' });
        } return result; };
      });
      await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports[1]!.closes).toBe(1);
    }
  });
  it.each([
    { type: 'active', activeFlags: [] }, { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'notLoaded' }, { type: 'systemError' }, { type: 'future' }, null, { type: 'idle', activeFlags: [] },
  ])('rejects same-ID thread/started status %j advertised after idle inspection', async status => {
    const f = await controlFixture(); await completed(f.control); const epoch = f.control.transportEpoch; f.transports[0]!.hooks.onUnexpectedExit();
    f.configure(candidate => { const request = candidate.request.bind(candidate); candidate.request = async (method, params) => {
      const result = await request(method, params);
      if (method === 'thread/turns/list') candidate.hooks.onNotification('thread/started', { thread: { id: 'thread-1', status } });
      return result;
    }; });
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.control.transportEpoch).toBe(epoch); expect(f.transports[1]!.closes).toBe(1);
  });
  it.each([undefined, { type: 'idle' }])('allows same-ID resume metadata with status %j', async status => {
    const f = await controlFixture(); await completed(f.control); f.transports[0]!.hooks.onUnexpectedExit();
    f.configure(candidate => { const request = candidate.request.bind(candidate); candidate.request = async (method, params) => {
      const result = await request(method, params); if (method === 'thread/turns/list') candidate.hooks.onNotification('thread/started', { thread: { id: 'thread-1', ...(status === undefined ? {} : { status }) } }); return result;
    }; });
    await expect(f.control.reconcile!()).resolves.toBe('active');
  });
  it('refuses adoption if the deadline crosses after final validation but before commit', async () => {
    vi.useFakeTimers(); const f = await controlFixture(); await completed(f.control); const epoch = f.control.transportEpoch; f.transports[0]!.hooks.onUnexpectedExit();
    const original = CodexThreadRegistry.prototype.activateRecovered;
    vi.spyOn(CodexThreadRegistry.prototype, 'activateRecovered').mockImplementation(function (this: CodexThreadRegistry, threadId, expected, hash) {
      const result = original.call(this, threadId, expected, hash), now = Date.now();
      // Final eligibility check is still timely; the following commit check is overdue.
      vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 5001); return result;
    });
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.control.transportEpoch).toBe(epoch); expect(f.transports[1]!.closes).toBe(1);
  });
  it('does not undo an atomic adoption when the clock crosses during its committed swap', async () => {
    vi.useFakeTimers(); const f = await controlFixture(); await completed(f.control); const epoch = f.control.transportEpoch; f.transports[0]!.hooks.onUnexpectedExit();
    const original = Map.prototype.set;
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key, value) {
      const result = original.call(this, key, value);
      if (key === 'thread-1' && value === f.control) vi.setSystemTime(Date.now() + 5001);
      return result;
    });
    await expect(f.control.reconcile!()).resolves.toBe('active'); expect(f.control.transportEpoch).not.toBe(epoch); expect(f.transports[1]!.closes).toBe(0); expect(f.control.state()).toBe('active');
    await vi.advanceTimersByTimeAsync(6000); expect(f.transports[1]!.closes).toBe(0); expect(f.control.state()).toBe('active');
  });
  it('starts zero candidates while an old dead turn is awaiting its disposal promise', async () => {
    const f = await controlFixture(), gate = deferred<void>(), entered = deferred<void>(), original = ControlBuffer.prototype.dispose; let gated = false;
    vi.spyOn(ControlBuffer.prototype, 'dispose').mockImplementation(async function (this: ControlBuffer<unknown>) {
      if (!gated) { gated = true; entered.resolve(); await gate.promise; } await original.call(this);
    });
    f.transports[0]!.hangTurn = true; const turn = await f.control.startTurn({ input: 'old' }); f.transports[0]!.hooks.onUnexpectedExit();
    f.history.set('thread-1', { id: 'turn-1', status: 'completed' });
    const drain = (async () => { for await (const _item of turn.stream) {} })(); void drain.catch(() => undefined); await entered.promise;
    try { await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1); }
    finally { gate.resolve(); await drain.catch(() => undefined); }
    await expect(f.control.reconcile!()).resolves.toBe('active'); expect(f.transports).toHaveLength(2);
  });
  it('keeps an ordinary turn busy until disposal has actually settled', async () => {
    const f = await controlFixture(), gate = deferred<void>(), entered = deferred<void>(), original = ControlBuffer.prototype.dispose; let gated = false;
    vi.spyOn(ControlBuffer.prototype, 'dispose').mockImplementation(async function (this: ControlBuffer<unknown>) {
      if (!gated) { gated = true; entered.resolve(); await gate.promise; } await original.call(this);
    });
    const first = completed(f.control); void first.catch(() => undefined); await entered.promise;
    try { await expect(f.control.startTurn({ input: 'overlap' })).rejects.toMatchObject({ code: 'SESSION_BUSY' }); expect(f.transports[0]!.calls.filter(call => call.method === 'turn/start')).toHaveLength(1); }
    finally { gate.resolve(); await first; }
    await completed(f.control); expect(f.transports[0]!.calls.filter(call => call.method === 'turn/start')).toHaveLength(2);
  });
  it('keeps fork siblings independently unknown and preserves the old shared plane until they close', async () => {
    const f = await controlFixture(); await completed(f.control); const sibling = await f.control.fork({}); controls.push(sibling);
    const siblingEpoch = sibling.transportEpoch; f.transports[0]!.hooks.onUnexpectedExit();
    await expect(f.control.reconcile!()).resolves.toBe('active'); expect(sibling.state()).toBe('unknown'); expect(sibling.transportEpoch).toBe(siblingEpoch); expect(f.transports[0]!.closes).toBe(0);
    await sibling.close(); expect(f.transports[0]!.closes).toBe(1);
  });
  it.each(['fork', 'respond'] as const)('blocks replacement until pending %s has actually settled', async operation => {
    const f = await controlFixture(), gate = deferred<void>();
    if (operation === 'fork') f.transports[0]!.gates.set('thread/fork', gate.promise);
    else vi.spyOn(InteractionBroker.prototype, 'respond').mockImplementation(() => gate.promise);
    const pending = operation === 'fork' ? f.control.fork({}) : f.control.respond('fixture', { kind: 'approval', decision: 'decline' }); void pending.catch(() => undefined);
    f.transports[0]!.hooks.onUnexpectedExit();
    try { await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1); }
    finally { gate.resolve(); await pending.catch(() => undefined); }
    await expect(f.control.reconcile!()).resolves.toBe('active');
  });
  it('denies all candidate server work before adoption and invalidates that attempt', async () => {
    const handler = vi.fn(async () => null), f = await controlFixture({ tools: [{ name: 'lookup', description: 'fixture', inputSchema: {}, timeoutMs: 1000, maxOutputBytes: 100, handler }] });
    f.transports[0]!.hooks.onUnexpectedExit(); const gate = deferred<void>(); f.configure(candidate => candidate.gates.set('thread/read', gate.promise));
    const pending = f.control.reconcile!(); await vi.waitFor(() => expect(f.transports[1]?.calls.some(call => call.method === 'thread/read')).toBe(true));
    await expect(f.transports[1]!.hooks.onServerRequest('item/tool/call', { threadId: 'thread-1', turnId: 'old', callId: 'old', tool: 'lookup', arguments: {} }, 'unowned')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(handler).not.toHaveBeenCalled(); gate.resolve(); await expect(pending).resolves.toBe('unknown'); expect(f.transports[1]!.closes).toBe(1);
  });
  it('quarantines a timed-out replacement starter and closes it when it finally appears', async () => {
    vi.useFakeTimers(); const f = await controlFixture(); f.transports[0]!.hooks.onUnexpectedExit(); const gate = deferred<void>(); f.gateStarter(gate.promise);
    const first = f.control.reconcile!(); await flush(); await vi.advanceTimersByTimeAsync(5000); await expect(first).resolves.toBe('unknown');
    for (let index = 0; index < 5; index++) await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(2);
    gate.resolve(); await vi.waitFor(() => expect(f.transports[1]!.closes).toBe(1)); await flush();
    await expect(f.control.reconcile!()).resolves.toBe('active'); expect(f.transports).toHaveLength(3);
  });
  it('fences old approvals, turn controls, tool requests, completions and death callbacks after adoption', async () => {
    const f = await controlFixture(), answer = deferred<{ kind: 'approval'; decision: string }>(); let oldRequest: InteractionRequest | undefined;
    const old = f.transports[0]!; old.hangTurn = true;
    const turn = await f.control.startTurn({ input: 'old prompt', onInteraction: request => { oldRequest = request; return answer.promise; } });
    const wire = old.hooks.onServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'old-tool', command: ['fixture'], cwd: '/fixture' }, 'old-approval'); void wire.catch(() => undefined);
    old.hooks.onUnexpectedExit(); await expect(wire).resolves.toMatchObject({ decision: 'decline' });
    await expect((async () => { for await (const _item of turn.stream) {} })()).rejects.toBeDefined();
    f.history.set('thread-1', { id: 'turn-1', status: 'completed' }); await expect(f.control.reconcile!()).resolves.toBe('active');
    const candidate = f.transports[1]!, count = candidate.calls.length;
    answer.resolve({ kind: 'approval', decision: 'accept' }); await flush();
    await expect(turn.interrupt()).resolves.toMatchObject({ requested: false }); await expect(turn.steer!('stale')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await expect(f.control.respond(oldRequest!.binding.interactionId, { kind: 'approval', decision: 'accept' })).rejects.toBeDefined();
    await expect(old.hooks.onServerRequest('item/tool/call', { threadId: 'thread-1', turnId: 'old', callId: 'old', tool: 'lookup', arguments: {} }, 'old-tool')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    old.hooks.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'stale', status: 'completed' } }); old.hooks.onUnexpectedExit();
    expect(candidate.calls).toHaveLength(count); expect(f.control.state()).toBe('active');
    candidate.hangTurn = true; let newRequest: InteractionRequest | undefined;
    const next = await f.control.startTurn({ input: 'new explicit prompt', onInteraction: async request => { newRequest = request; return { kind: 'approval', decision: 'decline' }; } });
    await candidate.hooks.onServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-2', itemId: 'new-tool', command: ['fixture'], cwd: '/fixture' }, 'new-approval');
    expect(newRequest?.binding.transportEpoch).toBe(f.control.transportEpoch); expect(newRequest?.binding.transportEpoch).not.toBe(oldRequest?.binding.transportEpoch);
    candidate.complete(); for await (const _item of next.stream) {}
  });
  it('rejects a conflicting old registry identity before starting a candidate', async () => {
    const f = await controlFixture(), epoch = f.control.transportEpoch; f.transports[0]!.hooks.onUnexpectedExit();
    const original = CodexThreadRegistry.prototype.identity;
    vi.spyOn(CodexThreadRegistry.prototype, 'identity').mockImplementation(function (this: CodexThreadRegistry, threadId) {
      const identity = original.call(this, threadId); return this.epoch === epoch ? { ...identity, provider: 'claude' } : identity;
    });
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1);
  });
  it('detects an old registry/tool hash mismatch before opening a candidate', async () => {
    const f = await controlFixture(); f.transports[0]!.hooks.onUnexpectedExit(); vi.spyOn(CodexDynamicToolHost.prototype, 'registryHash').mockReturnValue('foreign');
    await expect(f.control.reconcile!()).resolves.toBe('unknown'); expect(f.transports).toHaveLength(1);
  });
});

import { Session } from '../../src/session/session.js';
it('refreshes the public Session epoch after actual injected Codex handle adoption without another turn', async () => {
  const f = await controlFixture();
  const session = new Session({ adapter: { id: 'codex', detect: async () => ({ installed: true }), auth: async () => ({ authenticated: true, source: 'subscription' }),
    models: async () => [], execute: async () => { throw new Error('No EXEC/provider call'); } }, control: f.control, model: f.request.model,
    cwd: '/fixture', persistence: 'provider', transport: 'control', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
  const oldTurn = await session.send('first explicit prompt'), previous = session.export(); f.transports[0]!.hooks.onUnexpectedExit();
  await expect(session.reconcile()).resolves.toBe('idle');
  expect(session.export()).toMatchObject({ ...previous, transportEpoch: f.control.transportEpoch });
  expect(session.ref?.transportEpoch).not.toBe(previous.transportEpoch); expect(session.identity?.transportEpoch).toBe(f.control.transportEpoch);
  expect(oldTurn.session.transportEpoch).toBe(previous.transportEpoch);
  expect(f.transports[1]!.calls.every(call => call.method !== 'turn/start')).toBe(true);
  await expect(session.send('second explicit prompt')).resolves.toMatchObject({ session: { transportEpoch: f.control.transportEpoch } });
  await session.close();
});
