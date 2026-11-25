import { describe, expect, it } from 'vitest';
import {
  bindDecision, DecisionRunner, type DecisionRecord, type DecisionStore,
} from '../../src/orchestration/decisions/index.js';

const binding = () => bindDecision({ input: { file: 'document-1' }, authority: { mode: 'local-only' }, inputVersion: 'v1', authorityVersion: 'epoch-1' });
function fixture(saved?: DecisionRecord) {
  let value = saved;
  let locked = false;
  const writes: DecisionRecord[] = [];
  const store: DecisionStore = { async acquire() {
    if (locked) throw new Error('owned'); locked = true;
    return { async load() { return value; }, async save(next) { value = structuredClone(next); writes.push(value); }, async release() { locked = false; } };
  } };
  return { store, writes, get: () => value };
}
const allow = () => ({ decision: 'allow' as const, reason: 'current operator policy', expiresAt: 200 });
const verify = () => ({ verified: true as const, evidence: ['artifact:sha256'] });
const isCurrent = () => true;

describe('durable decisions', () => {
  it('freezes inputs, binds versions, and retains the existing JSON hash identity', () => {
    const input = { document: ['one'] };
    const proof = bindDecision({ input, authority: ['operator'], inputVersion: 'v1', authorityVersion: 'a1' });
    input.document.push('two');
    expect(proof.input).toEqual({ document: ['one'] });
    expect(Object.isFrozen(proof.input)).toBe(true);
    expect(Object.isFrozen((proof.input as typeof input).document)).toBe(true);
    expect(proof.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.authorityVersion).toBe('a1');
  });

  it('persists intent before effect and requires verified evidence before completion', async () => {
    const f = fixture();
    const result = await new DecisionRunner(f.store).run({ id: 'one', binding: binding(), now: () => 100,
      authorize: allow, isCurrent, execute: async context => {
        expect(f.get()).toMatchObject({ status: 'intent', attempts: 1, intentId: context.intentId });
        return { output: 'document' };
      }, verify });
    expect(result.status).toBe('verified');
    expect(result.receipt).toMatchObject({ inputHash: binding().inputHash, authorityVersion: 'epoch-1', evidence: ['artifact:sha256'] });
    expect(f.writes.map(r => r.status)).toEqual(['intent', 'dispatched', 'verified']);
  });

  it('waits durably for a condition, then obtains fresh authorization on resume', async () => {
    const f = fixture(); let ready = false, calls = 0;
    const options = { id: 'wait', binding: binding(), now: () => 100,
      condition: () => ready, authorize: () => { calls++; return allow(); }, isCurrent, execute: () => null, verify };
    expect((await new DecisionRunner(f.store).run(options)).status).toBe('waiting');
    expect(calls).toBe(0);
    const count = f.writes.length;
    expect((await new DecisionRunner(f.store).run(options)).status).toBe('waiting');
    expect(f.writes.length).toBe(count);
    ready = true;
    expect((await new DecisionRunner(f.store).run(options)).status).toBe('verified');
    expect(calls).toBe(1);
  });

  it('expires approvals after asynchronous authorization without dispatch or attempts', async () => {
    const f = fixture(); let now = 100, effects = 0;
    const result = await new DecisionRunner(f.store).run({ id: 'expired', binding: binding(), now: () => now,
      authorize: async () => { now = 201; return allow(); }, isCurrent, execute: () => { effects++; return null; }, verify });
    expect(result.status).toBe('waiting'); expect(result.attempts).toBe(0); expect(effects).toBe(0);
  });

  it('records rejection without effects, and never treats an old allow as current authority', async () => {
    const f = fixture(); let effects = 0;
    const options = { id: 'denied', binding: binding(), now: () => 100,
      authorize: () => ({ decision: 'wait' as const, reason: 'review', expiresAt: 200 }),
      execute: () => { effects++; return null; }, isCurrent, verify };
    await new DecisionRunner(f.store).run(options);
    const result = await new DecisionRunner(f.store).run({ ...options,
      authorize: () => ({ decision: 'deny', reason: 'revoked', expiresAt: 200 }) });
    expect(result.status).toBe('denied'); expect(result.attempts).toBe(0); expect(effects).toBe(0);
  });

  it('requires owner recovery for an interrupted intent and never replays it', async () => {
    const f = fixture(); let effects = 0;
    const options = { id: 'ambiguous', binding: binding(), now: () => 100, authorize: allow, isCurrent,
      execute: () => { effects++; throw new Error('effect may have happened'); }, verify };
    await expect(new DecisionRunner(f.store).run(options)).rejects.toThrow('effect may have happened');
    const result = await new DecisionRunner(f.store).run(options);
    expect(result.status).toBe('needs-owner'); expect(effects).toBe(1);
  });

  it('does not dispatch if the store cannot persist intent', async () => {
    let effects = 0;
    const store: DecisionStore = { async acquire() { return { async load() {}, async save() { throw new Error('disk full'); }, async release() {} }; } };
    await expect(new DecisionRunner(store).run({ id: 'fail', binding: binding(), now: () => 100, authorize: allow, isCurrent,
      execute: () => { effects++; return null; }, verify })).rejects.toThrow('disk full');
    expect(effects).toBe(0);
  });

  it('recovers a dispatched result by verification without reexecuting or reauthorizing', async () => {
    const f = fixture(); let effects = 0;
    const options = { id: 'verified-later', binding: binding(), now: () => 100, authorize: allow, isCurrent,
      execute: () => { effects++; return { artifact: 'one' }; }, verify: () => ({ verified: false, evidence: [] }) };
    expect((await new DecisionRunner(f.store).run(options)).status).toBe('dispatched');
    const resumed = await new DecisionRunner(f.store).run({ ...options, authorize: () => { throw Error('no new effect'); }, verify });
    expect(resumed.status).toBe('verified'); expect(effects).toBe(1);
  });

  it('blocks changed input or authority versions before another effect', async () => {
    const f = fixture();
    const options = { id: 'changed', binding: binding(), now: () => 100, isCurrent, authorize: () => ({ decision: 'wait' as const, reason: 'review', expiresAt: 200 }), execute: () => null, verify };
    await new DecisionRunner(f.store).run(options);
    const result = await new DecisionRunner(f.store).run({ ...options,
      binding: bindDecision({ input: { file: 'document-1' }, authority: { mode: 'local-only' }, inputVersion: 'v1', authorityVersion: 'epoch-2' }),
      authorize: () => { throw Error('changed binding cannot execute'); } });
    expect(result.status).toBe('needs-owner');
  });

  it('rechecks current authority after durable persistence and blocks revoked authority', async () => {
    let current = true, effects = 0;
    const f = fixture();
    const store: DecisionStore = { async acquire(id) {
      const lease = await f.store.acquire(id);
      return { ...lease, async save(value) { await lease.save(value); if (value.status === 'intent') current = false; } };
    } };
    const result = await new DecisionRunner(store).run({ id: 'revoked', binding: binding(), now: () => 100,
      authorize: allow, isCurrent: () => current, execute: () => { effects++; return null; }, verify });
    expect(result.status).toBe('needs-owner'); expect(effects).toBe(0);
  });

  it('does not replay an effect after result persistence fails', async () => {
    const f = fixture(); let effects = 0;
    const store: DecisionStore = { async acquire(id) {
      const lease = await f.store.acquire(id);
      return { ...lease, async save(value) { if (value.status === 'dispatched' || value.status === 'needs-owner') throw Error('store offline'); await lease.save(value); } };
    } };
    const options = { id: 'uncertain', binding: binding(), now: () => 100, authorize: allow, isCurrent,
      execute: () => { effects++; return null; }, verify };
    await expect(new DecisionRunner(store).run(options)).rejects.toThrow('store offline');
    expect(f.get()?.status).toBe('intent');
    expect((await new DecisionRunner(f.store).run(options)).status).toBe('needs-owner');
    expect(effects).toBe(1);
  });
});
