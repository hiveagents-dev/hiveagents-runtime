import { describe, expect, it } from 'vitest';
import { rankMemories, type MemoryDocument, type MemoryRankingOptions } from '../../src/orchestration/memory/index.js';

describe('rankMemories boundary validation', () => {
  it.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '3'])(
    'rejects invalid limit %s even for empty input', (limit) => {
      expect(() => rankMemories('', [], { limit } as MemoryRankingOptions)).toThrow();
    },
  );

  it.each(['lexicalWeight', 'semanticWeight', 'diversity'] as const)('validates %s as finite [0, 1]', (key) => {
    for (const value of [-0.1, 1.1, Number.NaN, Infinity, null, '0.5']) {
      expect(() => rankMemories('', [], { [key]: value } as MemoryRankingOptions)).toThrow();
    }
  });

  it('rejects all-zero retrieval weights and semantic retrieval without a query vector', () => {
    expect(() => rankMemories('', [], { lexicalWeight: 0, semanticWeight: 0 })).toThrow();
    expect(() => rankMemories('', [], { semanticWeight: 1 })).toThrow();
  });

  it.each([[], [Number.NaN], [Infinity], [-Infinity], [undefined], '1,0', null].map((vector) => ({ vector })))(
    'rejects malformed query vectors $vector', ({ vector: queryEmbedding }) => {
      expect(() => rankMemories('', [], { queryEmbedding } as MemoryRankingOptions)).toThrow();
    },
  );

  it('rejects mismatched dimensions even if vectors are unused or limit is zero', () => {
    const mismatched = [
      { id: 'one', text: 'api', embedding: [1] },
      { id: 'two', text: 'api', embedding: [1, 0] },
    ];
    expect(() => rankMemories('api', mismatched)).toThrow();
    expect(() => rankMemories('api', mismatched, { limit: 0 })).toThrow();
    expect(() => rankMemories('api', [mismatched[0]!], { queryEmbedding: [1, 0] })).toThrow();
  });

  it.each([[], [Number.NaN], [Infinity], [undefined], null].map((vector) => ({ vector })))(
    'rejects malformed document vectors $vector', ({ vector: embedding }) => {
    expect(() => rankMemories('', [{ id: 'a', text: '', embedding }] as MemoryDocument[])).toThrow();
  });

  it('does not underflow a tiny positive retrieval weight into no evidence', () => {
    expect(rankMemories('api', [{ id: 'a', text: 'api' }], { lexicalWeight: Number.MIN_VALUE })[0]?.record.id).toBe('a');
  });

  it('validates text, IDs, corpus and options at runtime', () => {
    expect(() => rankMemories(null as unknown as string, [])).toThrow();
    expect(() => rankMemories('', null as unknown as MemoryDocument[])).toThrow();
    expect(() => rankMemories('', [], null as unknown as MemoryRankingOptions)).toThrow();
    expect(() => rankMemories('', [], [] as MemoryRankingOptions)).toThrow();
    for (const record of [null, { id: '', text: 'api' }, { id: 1, text: 'api' }, { id: 'a', text: null }]) {
      expect(() => rankMemories('', [record] as MemoryDocument[])).toThrow();
    }
  });
});
