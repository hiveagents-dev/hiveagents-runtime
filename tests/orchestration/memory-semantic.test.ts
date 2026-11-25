import { describe, expect, it } from 'vitest';
import { rankMemories } from '../../src/orchestration/memory/index.js';

// These authored vectors prove the scoring contract, not a real model's quality.
describe('rankMemories supplied semantic vectors', () => {
  it('retrieves positive cosine matches without a lexical hit, excluding negative and zero cosine', () => {
    const documents = [
      { id: 'similar', text: 'unrelated tokens', embedding: [3, 4] },
      { id: 'opposite', text: 'other words', embedding: [-1, 0] },
      { id: 'orthogonal', text: 'different words', embedding: [0, 1] },
      { id: 'empty-vector', text: 'unused words', embedding: [0, 0] },
      { id: 'missing-vector', text: 'additional words' },
    ];
    const results = rankMemories('absent', documents, {
      lexicalWeight: 0, semanticWeight: 1, queryEmbedding: [1, 0],
    });
    expect(results.map(({ record }) => record.id)).toEqual(['similar']);
    expect(results[0]?.scores.lexical).toBe(0);
    expect(results[0]?.scores.semantic).toBeCloseTo(0.6, 12);
    expect(results[0]?.scores.relevance).toBeCloseTo(0.6, 12);
  });

  it('requires an explicit positive semantic weight to change lexical retrieval', () => {
    const docs = [
      { id: 'lexical', text: 'alpha', embedding: [0, 1] },
      { id: 'semantic', text: 'omega', embedding: [1, 0] },
    ];
    expect(rankMemories('alpha', docs, { queryEmbedding: [1, 0] }).map(({ record }) => record.id)).toEqual(['lexical']);
    const hybrid = rankMemories('alpha', docs, { queryEmbedding: [1, 0], lexicalWeight: 0.5, semanticWeight: 0.5 });
    expect(hybrid.map(({ record }) => record.id)).toEqual(['semantic', 'lexical']);
    expect(hybrid[0]?.scores.relevance).toBe(0.5);
    expect(hybrid[1]?.scores.relevance).toBeCloseTo(0.2046919454251793, 12);
  });

  it('handles finite very large and very small vectors without overflow or underflow', () => {
    const results = rankMemories('', [
      { id: 'huge', text: '', embedding: [1e308, 1e308] },
      { id: 'tiny', text: '', embedding: [1e-300, 1e-300] },
    ], { queryEmbedding: [1e308, 1e308], lexicalWeight: 0, semanticWeight: 1 });
    expect(results.map(({ record }) => record.id)).toEqual(['huge', 'tiny']);
    for (const result of results) expect(result.scores.semantic).toBeCloseTo(1, 12);
  });

  it('treats a zero query vector as no semantic evidence', () => {
    expect(rankMemories('', [{ id: 'a', text: '', embedding: [1, 0] }], {
      queryEmbedding: [0, 0], semanticWeight: 1, lexicalWeight: 0,
    })).toEqual([]);
  });
});

describe('rankMemories explicit diversity', () => {
  it('uses token diversity to avoid near duplicates only when requested', () => {
    const docs = [
      { id: 'first', text: 'plan email' },
      { id: 'duplicate', text: 'plan email' },
      { id: 'different', text: 'plan seo' },
      { id: 'irrelevant', text: 'unrelated' },
    ];
    expect(rankMemories('plan', docs, { limit: 2 }).map(({ record }) => record.id)).toEqual(['first', 'duplicate']);
    const results = rankMemories('plan', docs, { diversity: 0.6, limit: 3 });
    expect(results.map(({ record }) => record.id)).toEqual(['first', 'different', 'duplicate']);
    expect(results[1]?.scores.redundancy).toBeCloseTo(1 / 3, 12);
    expect(results[2]?.scores.redundancy).toBe(1);
    expect(results[2]?.scores.mmr).toBeLessThan(0);
  });

  it('uses supplied document vectors for MMR when both documents have vectors', () => {
    const docs = [
      { id: 'first', text: 'plan email', embedding: Object.freeze([1, 0]) },
      { id: 'duplicate-vector', text: 'plan roi', embedding: Object.freeze([1, 0]) },
      { id: 'different-vector', text: 'plan email', embedding: Object.freeze([0, 1]) },
    ];
    const results = rankMemories('plan', Object.freeze(docs), { limit: 2, diversity: 0.6 });
    expect(results.map(({ record }) => record.id)).toEqual(['first', 'different-vector']);
    expect(results[1]?.scores.redundancy).toBe(0);
    expect(results[0]?.record).toBe(docs[0]);
  });

  it('starts with the most relevant record even at maximum diversity', () => {
    const results = rankMemories('api payment', [
      { id: 'less-relevant', text: 'api api' },
      { id: 'most-relevant', text: 'api payment' },
    ], { diversity: 1 });
    expect(results[0]?.record.id).toBe('most-relevant');
    expect(results[0]?.scores.mmr).toBe(0);
  });
});
