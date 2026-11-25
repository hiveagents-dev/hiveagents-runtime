import { describe, expect, it, vi } from 'vitest';
import { createTaskHandoff, runHandoff, type HandoffRunOptions, type HandoffStore, type TaskHandoff, type TaskHandoffDraft } from '../../src/orchestration/handoff/index.js';
import type { DecisionRecord, DecisionStore } from '../../src/orchestration/decisions/types.js';

const hash = 'a'.repeat(64);
const draft = (): TaskHandoffDraft => ({ id: 'bundle', goal: 'Verify selected artifact', requirements: ['Check digest'],
  context: { selected: true }, source: { id: 'producer', version: '1', digest: hash }, destination: { id: 'receiver', version: '1' },
  evidence: [{ id: 'prior', digest: hash }], artifacts: [{ uri: 'file:///inert-reference', digest: hash }], pending: ['verify'], unresolvedEffects: [] });
function decisionFixture() {
  let value: DecisionRecord | undefined, owned = false;
  const writes: DecisionRecord[] = [];
  const store: DecisionStore = { async acquire() {
    if (owned) throw Error('owned'); owned = true;
    return { async load() { return value; }, async save(next) { value = structuredClone(next); writes.push(value); }, async release() { owned = false; } };
  } };
  return { store, writes, get: () => value, set: (next: DecisionRecord) => { value = next; }, owned: () => owned };
}
function fixture() {
  const decisions = decisionFixture(); let effects = 0, approvals = 0, verifications = 0;
  let bundle = createTaskHandoff(draft());
  const handoffs: HandoffStore = { async save(next) { bundle = next; }, async load() { return bundle; } };
  const options: HandoffRunOptions = { id: 'receive', handoffId: 'bundle', store: handoffs, decisionStore: decisions.store,
    target: { id: 'receiver', version: '1' }, sourceDigest: hash, authority: { id: 'operator', version: 'epoch-1' },
    authorize: () => { approvals++; return { decision: 'allow', reason: 'current local policy', expiresAt: Date.now() + 60_000 }; },
    isCurrent: () => true,
    execute: context => { effects++; expect(context.handoff.context).toEqual({ selected: true }); return { artifact: 'done' }; },
    verify: () => { verifications++; return { verified: true, evidence: ['artifact:sha256'] }; } };
  return { decisions, options, replace: (next: TaskHandoff) => { bundle = next; }, counts: () => ({ effects, approvals, verifications }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise };
}

describe('durable handoff decisions', () => {
  it('persists intent before dispatch, binds exact content and receiver, and reuses a verified receipt', async () => {
    const f = fixture(); const original = f.options.execute;
    f.options.execute = context => {
      expect(f.decisions.get()).toMatchObject({ status: 'intent', attempts: 1, intentId: context.intentId });
      expect(context.target).toEqual({ id: 'receiver', version: '1' });
      expect(Object.isFrozen(context.handoff.context)).toBe(true);
      expect(Object.isFrozen(context.target)).toBe(true);
      return original(context);
    };
    const one = await runHandoff(f.options), two = await runHandoff(f.options);
    expect(one.status).toBe('verified'); expect(two.receipt).toEqual(one.receipt);
    expect(one.binding.input).toEqual({ handoffId: 'bundle', handoffDigest: createTaskHandoff(draft()).digest,
      sourceDigest: hash, target: { id: 'receiver', version: '1' } });
    expect(one.receipt).toMatchObject({ authorityVersion: 'epoch-1', evidence: ['artifact:sha256'] });
    expect(f.counts()).toEqual({ effects: 1, approvals: 1, verifications: 1 });
  });

  it.each([
    ['wrong receiver', { target: { id: 'other', version: '1' } }],
    ['changed receiver version', { target: { id: 'receiver', version: '2' } }],
    ['changed receiver provider', { target: { id: 'receiver', version: '1', provider: 'claude' } }],
    ['changed source', { sourceDigest: 'b'.repeat(64) }],
    ['invalid authority', { authority: { id: 'operator', version: '' } }],
    ['unknown authority fields', { authority: { id: 'operator', version: '1', approval: 'allow' } }],
  ])('rejects %s before acquiring a decision lease or calling application ports', async (_label, changes) => {
    const f = fixture(); await expect(runHandoff({ ...f.options, ...changes })).rejects.toThrow();
    expect(f.counts()).toEqual({ effects: 0, approvals: 0, verifications: 0 }); expect(f.decisions.writes).toEqual([]);
  });

  it('validates a custom store bundle and blocks unresolved effects before authorizing', async () => {
    const f = fixture(); f.replace(createTaskHandoff({ ...draft(), unresolvedEffects: ['An earlier write may have happened'] }));
    await expect(runHandoff(f.options)).rejects.toThrow(/unresolved|ambiguous/i);
    f.replace({ ...createTaskHandoff(draft()), goal: 'tampered' });
    await expect(runHandoff(f.options)).rejects.toThrow();
    expect(f.counts()).toEqual({ effects: 0, approvals: 0, verifications: 0 });
    f.options.store = { async save() {}, async load() { return undefined; } };
    await expect(runHandoff(f.options)).rejects.toThrow(/missing|not found/i);
  });

  it('snapshots caller target and authority before asynchronous loading', async () => {
    const f = fixture(), loaded = deferred<TaskHandoff>();
    f.options.store = { async save() {}, load: () => loaded.promise };
    const running = runHandoff(f.options);
    f.options.target = { id: 'other', version: '2' }; f.options.authority.version = 'later';
    loaded.resolve(createTaskHandoff(draft()));
    const result = await running;
    expect(result.status).toBe('verified'); expect(result.receipt?.authorityVersion).toBe('epoch-1');
  });

  it('rejects authority accessors without evaluating them as trusted identity', async () => {
    const f = fixture(); let invoked = false;
    Object.defineProperty(f.options.authority, 'id', { enumerable: true, get() { invoked = true; return 'operator'; } });
    await expect(runHandoff(f.options)).rejects.toThrow();
    expect(invoked).toBe(false); expect(f.counts().effects).toBe(0);
  });

  it('expires authority during durable intent before the effect boundary', async () => {
    const f = fixture(), clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      f.options.authorize = () => ({ decision: 'allow', reason: 'bounded', expiresAt: 200 });
      f.options.decisionStore = { async acquire(id) { const lease = await f.decisions.store.acquire(id);
        return { ...lease, async save(record) { await lease.save(record); if (record.status === 'intent') clock.mockReturnValue(201); } }; } };
      expect((await runHandoff(f.options)).status).toBe('needs-owner'); expect(f.counts().effects).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it('records cancellation during intent without dispatching an effect', async () => {
    const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal;
    f.options.decisionStore = { async acquire(id) { const lease = await f.decisions.store.acquire(id);
      return { ...lease, async save(record) { await lease.save(record); if (record.status === 'intent') controller.abort(); } }; } };
    expect((await runHandoff(f.options)).status).toBe('needs-owner'); expect(f.counts().effects).toBe(0);
  });

  it('requires an owner after execution throws and recovers verifier failure without replay', async () => {
    const f = fixture(); let effects = 0;
    f.options.execute = () => { effects++; throw Error('uncertain application effect'); };
    await expect(runHandoff(f.options)).rejects.toThrow('uncertain application effect');
    expect((await runHandoff(f.options)).status).toBe('needs-owner'); expect(effects).toBe(1);
    const g = fixture(); g.options.verify = () => { throw Error('evidence unreadable'); };
    await expect(runHandoff(g.options)).rejects.toThrow('evidence unreadable');
    g.options.verify = () => ({ verified: true, evidence: ['recovered-evidence'] });
    expect((await runHandoff(g.options)).status).toBe('verified'); expect(g.counts().effects).toBe(1);
  });

  it('obtains fresh authorization for waiting work after restart', async () => {
    const f = fixture(); f.options.authorize = () => ({ decision: 'wait', reason: 'review', expiresAt: Date.now() + 60_000 });
    expect((await runHandoff(f.options)).status).toBe('waiting');
    f.options.authorize = () => ({ decision: 'deny', reason: 'revoked', expiresAt: Date.now() + 60_000 });
    expect((await runHandoff(f.options)).status).toBe('denied');
    expect(f.counts().effects).toBe(0); expect(f.decisions.get()?.attempts).toBe(0);
  });

  it('rejects expired approval without dispatch', async () => {
    const f = fixture(); f.options.authorize = () => ({ decision: 'allow', reason: 'old', expiresAt: 1 });
    expect((await runHandoff(f.options)).status).toBe('waiting'); expect(f.counts().effects).toBe(0);
  });

  it('checks live authority after durable intent and blocks changes during persistence', async () => {
    const f = fixture(); let current = true;
    f.options.isCurrent = context => current && context.handoff.digest === createTaskHandoff(draft()).digest;
    f.options.decisionStore = { async acquire(id) { const lease = await f.decisions.store.acquire(id);
      return { ...lease, async save(record) { await lease.save(record); if (record.status === 'intent') current = false; } }; } };
    const result = await runHandoff(f.options);
    expect(result.status).toBe('needs-owner'); expect(f.counts().effects).toBe(0);
  });

  it('blocks changed authority or selected JSON on a prior decision identity', async () => {
    const f = fixture(); f.options.verify = () => ({ verified: false, evidence: [] });
    expect((await runHandoff(f.options)).status).toBe('dispatched');
    f.options.authority = { id: 'operator', version: 'epoch-2' };
    expect((await runHandoff(f.options)).status).toBe('needs-owner'); expect(f.counts().effects).toBe(1);
    const g = fixture(); g.options.authorize = () => ({ decision: 'wait', reason: 'review', expiresAt: Date.now() + 60_000 });
    await runHandoff(g.options); g.replace(createTaskHandoff({ ...draft(), context: { selected: 'changed' } }));
    expect((await runHandoff(g.options)).status).toBe('needs-owner'); expect(g.counts().effects).toBe(0);
  });

  it('reverifies a recovered dispatched result without executing or reauthorizing it', async () => {
    const f = fixture(); f.options.verify = () => ({ verified: false, evidence: [] });
    expect((await runHandoff(f.options)).status).toBe('dispatched');
    f.options.authorize = () => { throw Error('must not reauthorize completed effect'); };
    f.options.execute = () => { throw Error('must not replay effect'); };
    f.options.verify = (result, context) => {
      expect(result).toEqual({ artifact: 'done' }); expect(context.handoff.id).toBe('bundle');
      return { verified: true, evidence: ['verified-on-restart'] };
    };
    const result = await runHandoff(f.options);
    expect(result.status).toBe('verified'); expect(result.receipt?.evidence).toEqual(['verified-on-restart']); expect(f.counts().effects).toBe(1);
  });

  it('turns a recovered durable intent into needs-owner without repeating an ambiguous effect', async () => {
    const f = fixture(); await runHandoff(f.options);
    const previous = f.decisions.get()!;
    const { result: _result, receipt: _receipt, ...intent } = previous;
    f.decisions.set({ ...intent, status: 'intent' });
    expect((await runHandoff(f.options)).status).toBe('needs-owner'); expect(f.counts().effects).toBe(1);
  });

  it('does not dispatch if intent persistence fails, and never replays failed result persistence', async () => {
    const f = fixture(); f.options.decisionStore = { async acquire(id) { const lease = await f.decisions.store.acquire(id);
      return { ...lease, async save() { throw Error('disk full'); } }; } };
    await expect(runHandoff(f.options)).rejects.toThrow('disk full'); expect(f.counts().effects).toBe(0);
    const g = fixture(); g.options.decisionStore = { async acquire(id) { const lease = await g.decisions.store.acquire(id);
      return { ...lease, async save(record) { if (record.status !== 'intent') throw Error('store offline'); await lease.save(record); } }; } };
    await expect(runHandoff(g.options)).rejects.toThrow('store offline');
    g.options.decisionStore = g.decisions.store;
    expect((await runHandoff(g.options)).status).toBe('needs-owner'); expect(g.counts().effects).toBe(1);
  });

  it('retains the dispatched result when verification persistence fails and only reverifies it', async () => {
    const f = fixture(); f.options.decisionStore = { async acquire(id) { const lease = await f.decisions.store.acquire(id);
      return { ...lease, async save(record) { if (record.status === 'verified') throw Error('receipt offline'); await lease.save(record); } }; } };
    await expect(runHandoff(f.options)).rejects.toThrow('receipt offline'); expect(f.decisions.get()?.status).toBe('dispatched');
    f.options.decisionStore = f.decisions.store;
    expect((await runHandoff(f.options)).status).toBe('verified'); expect(f.counts().effects).toBe(1);
  });

  it('propagates a handoff store failure before requesting authority', async () => {
    const f = fixture(); f.options.store = { async save() {}, async load() { throw Error('store unreadable'); } };
    await expect(runHandoff(f.options)).rejects.toThrow('store unreadable'); expect(f.counts().approvals).toBe(0);
  });

  it('aborts before starting without reading a handoff', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort(Error('cancelled'));
    f.options.store = { async save() {}, async load() { throw Error('must not load'); } }; f.options.signal = controller.signal;
    await expect(runHandoff(f.options)).rejects.toThrow('cancelled'); expect(f.counts().effects).toBe(0);
  });

  it('does not release exclusive ownership while noncooperative authorization is pending', async () => {
    const f = fixture(), controller = new AbortController(), entered = deferred<void>(), finished = deferred<void>();
    f.options.signal = controller.signal;
    f.options.authorize = async () => { entered.resolve(); await finished.promise;
      return { decision: 'allow', reason: 'late', expiresAt: Date.now() + 60_000 }; };
    const running = runHandoff(f.options); const rejected = running.catch(error => error);
    await entered.promise; controller.abort(Error('cancelled'));
    expect(f.decisions.owned()).toBe(true);
    await expect(runHandoff({ ...f.options, signal: new AbortController().signal })).rejects.toThrow('owned');
    finished.resolve(); expect(await rejected).toMatchObject({ message: 'cancelled' });
    expect(f.decisions.owned()).toBe(false); expect(f.counts().effects).toBe(0);
  });

  it('drains noncooperative execution before release and persists its result without replay', async () => {
    const f = fixture(), controller = new AbortController(), entered = deferred<void>(), finished = deferred<void>();
    f.options.signal = controller.signal;
    f.options.execute = async () => { entered.resolve(); await finished.promise; return { artifact: 'late' }; };
    const running = runHandoff(f.options); const rejected = running.catch(error => error);
    await entered.promise; controller.abort(Error('cancelled'));
    expect(f.decisions.owned()).toBe(true);
    await expect(runHandoff({ ...f.options, signal: new AbortController().signal })).rejects.toThrow('owned');
    finished.resolve(); expect(await rejected).toMatchObject({ message: 'cancelled' });
    expect(f.decisions.owned()).toBe(false); expect(f.counts().verifications).toBe(0);
    expect(f.decisions.get()?.status).toBe('dispatched');
    f.options.signal = new AbortController().signal;
    f.options.execute = () => { throw Error('late result must not replay'); };
    expect((await runHandoff(f.options)).status).toBe('verified');
  });

  it('holds ownership until pending verification settles after cancellation', async () => {
    const f = fixture(), controller = new AbortController(), entered = deferred<void>(), finished = deferred<void>();
    f.options.signal = controller.signal;
    f.options.verify = async () => { entered.resolve(); await finished.promise; return { verified: true, evidence: ['late'] }; };
    const running = runHandoff(f.options); const rejected = running.catch(error => error);
    await entered.promise; controller.abort(Error('cancelled')); expect(f.decisions.owned()).toBe(true);
    finished.resolve(); expect(await rejected).toMatchObject({ message: 'cancelled' });
    expect(f.decisions.owned()).toBe(false); expect(f.decisions.get()?.status).toBe('dispatched');
  });
});
