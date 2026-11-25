import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { curateMemory } from '../../src/orchestration/memory/curator.js';
import type { CuratableStore } from '../../src/orchestration/memory/curator.js';
import { evaluateMemoryGate } from '../../src/orchestration/memory/index.js';
import type {
  MemoryPromotion, MemoryPromotionResult, MemoryRecordView, ScopedMemoryRecord,
} from '../../src/orchestration/memory/index.js';
import { IDENTITY, letterEmbedder } from './memory-agent-fixture.js';

/**
 * A structural stand-in for the agentdb-memory `VectorMemory`: it refuses a record without a
 * vector of its identity, and evidence that measured more than one candidate, as the package does.
 */
function vectorStore() {
  const entries: { view: MemoryRecordView; order: number }[] = [];
  let order = 0;
  const store: CuratableStore & { entries: typeof entries } = {
    entries,
    async list() {
      return entries.slice().sort((a, b) => b.order - a.order).map(entry => entry.view);
    },
    async put(record: ScopedMemoryRecord) {
      const values = record.embedding?.values;
      if (!values || values.length !== IDENTITY.dimensions) throw Object.assign(new Error('no vector'), { code: 'EMBEDDING_MISMATCH' });
      const contentDigest = createHash('sha256').update(JSON.stringify(record)).digest('hex');
      const existing = entries.find(entry => entry.view.record.id === record.id);
      if (existing) {
        if (existing.view.contentDigest !== contentDigest) throw Object.assign(new Error('conflict'), { code: 'CONFLICT' });
        return;
      }
      entries.push({ view: { record: structuredClone(record), state: 'episode', contentDigest, recordedAt: `t${order}` }, order: order++ });
    },
    async promote(promotion: MemoryPromotion): Promise<MemoryPromotionResult> {
      const entry = entries.find(candidate => candidate.view.record.id === promotion.id);
      if (!entry) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      if (!promotion.gate.candidateDigests.includes(entry.view.contentDigest)) return { promoted: false, reason: 'CANDIDATE_NOT_MEASURED' };
      if (promotion.gate.candidateDigests.length !== 1) throw Object.assign(new Error('isolate'), { code: 'CANDIDATE_NOT_ISOLATED' });
      const verdict = evaluateMemoryGate(promotion.gate);
      if (!verdict.passed) return { promoted: false, reason: verdict.reason };
      entry.view = { ...entry.view, state: 'lesson', promotion: { promotedAt: 'now', promotedBy: promotion.by, gate: promotion.gate } };
      return { promoted: true, promotedAt: 'now' };
    },
  };
  return store;
}

const scope = { tenant: 'grow', namespace: 'lessons' };
const raw: ScopedMemoryRecord = {
  id: 'turn-1', scope, text: 'User prefers formal Spanish.',
  provenance: { source: 'agent-turn', sourceVersion: 'claude/x', observedAt: '2026-11-10T10:00:00.000Z', inputHash: 'a'.repeat(64) },
  embedding: { identity: IDENTITY, values: [1, 1, 1] },
};

function pass(store: CuratableStore, extra: Partial<Parameters<typeof curateMemory>[0]> = {}) {
  return curateMemory({
    store, scope, distillerId: 'distill-1',
    tasks: [1, 2, 3, 4, 5].map(n => ({ id: `t${n}`, input: `greet ${n}` })),
    distill: async () => [{ text: 'Address the user formally, in Spanish.', sources: ['turn-1'] }],
    history: () => [],
    run: (_task, { condition, context }) => ({ passed: condition === 'memory' && context.length === 1 }),
    confirm: false, alpha: 0.05,
    ...extra,
  });
}

describe('curateMemory over a structural vector store', () => {
  it('embeds the candidate, measures it alone and promotes it', async () => {
    const store = vectorStore();
    await store.put(raw);
    const calls: string[][] = [];

    const report = await pass(store, { embedder: letterEmbedder(IDENTITY, calls) });

    expect(report.candidates.map(outcome => outcome.status)).toEqual(['promoted']);
    expect(calls).toEqual([['Address the user formally, in Spanish.']]);
    const lesson = store.entries.find(entry => entry.view.state === 'lesson')!.view;
    const [expected] = await letterEmbedder().embed(['Address the user formally, in Spanish.']);
    expect(lesson.record.embedding).toEqual({ identity: IDENTITY, values: expected });
    expect(lesson.promotion!.gate.candidateDigests).toEqual([lesson.contentDigest]);
    expect(store.entries.find(entry => entry.view.record.id === 'turn-1')!.view.state).toBe('episode');
  });

  it('reports a store that refuses a record without a vector, and promotes nothing', async () => {
    const store = vectorStore();
    await store.put(raw);
    const report = await pass(store);
    expect(report.candidates).toEqual([expect.objectContaining({ status: 'error', stage: 'store', error: 'EMBEDDING_MISMATCH' })]);
    expect(store.entries.every(entry => entry.view.state === 'episode')).toBe(true);
  });

  it('refuses an embedder whose vector does not match its identity', async () => {
    const store = vectorStore();
    await store.put(raw);
    const report = await pass(store, { embedder: { identity: IDENTITY, embed: async () => [[1, 2]] } });
    expect(report.candidates[0]).toMatchObject({ status: 'error', stage: 'store', error: 'RangeError' });
  });
});
