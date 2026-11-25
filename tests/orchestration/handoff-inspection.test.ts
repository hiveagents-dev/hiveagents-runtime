import { describe, expect, it, vi } from 'vitest';
import { bindDecision, decisionHash } from '../../src/orchestration/decisions/binding.js';
import { createTaskHandoff } from '../../src/orchestration/handoff/bundle.js';
import { readHandoffDecision } from '../../src/orchestration/handoff/inspection.js';
import type { DecisionRecord, DecisionStore } from '../../src/orchestration/decisions/types.js';

const sourceDigest = 'a'.repeat(64);
const handoff = createTaskHandoff({ id: 'selected', goal: 'Review', requirements: [], context: null,
  source: { id: 'app', version: '1', digest: sourceDigest }, destination: { id: 'receiver', version: '1' },
  evidence: [], artifacts: [], pending: [], unresolvedEffects: [] });
const binding = () => bindDecision({ input: { handoffId: handoff.id, handoffDigest: handoff.digest, sourceDigest, target: { ...handoff.destination } },
  inputVersion: 'task-handoff:1', authority: { id: 'operator', version: '1' }, authorityVersion: '1' });
function verified(): DecisionRecord {
  const bound = binding(), approval = { decision: 'allow' as const, reason: 'approved', expiresAt: 100 };
  return { format: 1, id: 'effect', status: 'verified', attempts: 1, reason: 'Result verified', binding: bound, intentId: 'intent', authorization: approval, result: true,
    receipt: { ...bound, intentId: 'intent', approval, resultHash: decisionHash(true), evidence: ['artifact'], verifiedAt: 50 } };
}
function fixture(raw: unknown) {
  const save = vi.fn(), release = vi.fn(async () => {});
  const decisionStore: DecisionStore = { async acquire() { return { load: async () => raw, save, release }; } };
  return { decisionStore, save, release, store: { save: async () => {}, load: async () => handoff } };
}
describe('read-only durable handoff decision inspection', () => {
  it('validates a verified record without saving or dispatching', async () => {
    const record = verified(), f = fixture(record);
    expect(await readHandoffDecision({ id: 'effect', handoffId: handoff.id, ...f })).toEqual(record);
    expect(f.save).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
    expect(await readHandoffDecision({ id: 'effect', handoffId: handoff.id, ...fixture(undefined) })).toBeUndefined();
  });
  it('preserves the original canonical target binding for existing receipts regardless of draft property order', async () => {
    const { format: _format, digest: _digest, ...draft } = handoff;
    const reordered = createTaskHandoff({ ...draft, destination: { model: 'model', provider: 'claude', version: '1', id: 'receiver' } });
    const record = verified();
    record.binding = bindDecision({ input: { handoffId: reordered.id, handoffDigest: reordered.digest, sourceDigest,
      target: { id: 'receiver', version: '1', provider: 'claude', model: 'model' } },
      inputVersion: 'task-handoff:1', authority: { id: 'operator', version: '1' }, authorityVersion: '1' });
    Object.assign(record.receipt!, record.binding);
    const f = fixture(record); f.store.load = async () => reordered;
    expect((await readHandoffDecision({ id: 'effect', handoffId: reordered.id, ...f }))?.receipt).toEqual(record.receipt);
    expect(f.save).not.toHaveBeenCalled();
  });
  it.each(['receipt', 'binding', 'result', 'intent'] as const)('rejects a malformed verified %s record accepted by its workflow envelope', async corruption => {
    const record = verified();
    if (corruption === 'receipt') delete record.receipt;
    if (corruption === 'binding') record.binding = { ...record.binding, inputHash: 'b'.repeat(64) };
    if (corruption === 'result') record.result = false;
    if (corruption === 'intent') delete record.intentId;
    const f = fixture(record);
    await expect(readHandoffDecision({ id: 'effect', handoffId: handoff.id, ...f })).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(['handoffId', 'handoffDigest', 'sourceDigest', 'target', 'version'] as const)('rejects a self-consistent record for another handoff %s', async field => {
    const record = verified(), input = structuredClone(record.binding.input) as Record<string, unknown>;
    if (field === 'version') record.binding = { ...record.binding, inputVersion: 'task-handoff:other' };
    else { input[field] = field === 'target' ? { id: 'other', version: '1' } : field === 'handoffId' ? 'other' : 'b'.repeat(64); record.binding = { ...record.binding, input: input as never, inputHash: decisionHash(input as never) }; }
    Object.assign(record.receipt!, record.binding);
    const f = fixture(record);
    await expect(readHandoffDecision({ id: 'effect', handoffId: handoff.id, ...f })).rejects.toThrow(/binding|handoff/i);
    expect(f.save).not.toHaveBeenCalled();
  });
});
