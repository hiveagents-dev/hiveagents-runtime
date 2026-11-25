import { describe, expect, it } from 'vitest';
import { rankMemories } from '../../src/orchestration/memory/index.js';

describe('rankMemories lexical retrieval', () => {
  it('keeps short terms and folds Unicode accents while preserving payload identity', () => {
    const evidence = { source: 'operator', receipt: 'r1' };
    const relevant = Object.freeze({ id: 'seo', text: 'SEO: Diseño y conversión', evidence });
    const documents = Object.freeze([relevant, Object.freeze({ id: 'other', text: 'Una factura' })]);
    const ranked = rankMemories('seo diseno conversion', documents);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.record).toBe(relevant);
    const record = ranked[0]?.record;
    expect(record && 'evidence' in record ? record.evidence : undefined).toBe(evidence);
    expect(ranked[0]?.scores.lexical).toBeGreaterThan(0);
  });

  it('does not confuse a substring with a query token', () => {
    expect(rankMemories('press', [{ id: 'wp', text: 'WordPress maintenance' }])).toEqual([]);
  });

  it('exposes a nonzero hand-calculated BM25 score without elevating zero matches', () => {
    const [result] = rankMemories('alpha', [
      { id: 'a', text: 'alpha' }, { id: 'o', text: 'omega' },
    ]);
    expect(result?.record.id).toBe('a');
    // N=2, df=1, equal document lengths, tf=1: BM25 reduces to ln(2).
    expect(result?.scores.lexical).toBeCloseTo(0.6931471805599453, 12);
    expect(result?.scores.lexicalNormalized).toBeCloseTo(0.4093838908503587, 12);
    expect(result?.scores.semantic).toBe(0);
    expect(result?.scores.relevance).toBe(result?.scores.lexicalNormalized);
    expect(result?.scores.redundancy).toBe(0);
    expect(result?.scores.mmr).toBe(result?.scores.relevance);
  });

  it('uses term rarity and length to rank a focused match above incidental overlap', () => {
    const results = rankMemories('api payment', [
      { id: 'incidental', text: 'api api api general notes about many unrelated things' },
      { id: 'focused', text: 'api payment' },
      { id: 'other', text: 'api guidance for another topic' },
    ]);
    expect(results[0]?.record.id).toBe('focused');
  });

  it('does not let repeated query words change relevance', () => {
    const docs = [{ id: 'api', text: 'api bug' }, { id: 'other', text: 'api documentation' }];
    expect(rankMemories('api api', docs)).toEqual(rankMemories('api', docs));
  });

  it('preserves input order for ties and respects zero and finite limits', () => {
    const docs = [
      { id: 'z', text: 'same api' }, { id: 'a', text: 'same api' }, { id: 'b', text: 'same api' },
    ];
    expect(rankMemories('api', docs, { limit: 2 }).map(({ record }) => record.id)).toEqual(['z', 'a']);
    expect(rankMemories('api', docs, { limit: 0 })).toEqual([]);
    expect(docs.map(({ id }) => id)).toEqual(['z', 'a', 'b']);
  });

  it('handles empty corpora, empty documents, and punctuation-only queries', () => {
    expect(rankMemories('api', [])).toEqual([]);
    expect(rankMemories('', [{ id: 'a', text: 'api' }])).toEqual([]);
    expect(rankMemories('!!!', [{ id: 'a', text: 'api' }])).toEqual([]);
    expect(rankMemories('api', [{ id: 'a', text: '' }])).toEqual([]);
    expect(rankMemories('absent', [{ id: 'a', text: 'api' }])).toEqual([]);
  });

  it('recognizes non-Latin letters and canonically equivalent Unicode', () => {
    expect(rankMemories('cafe\u0301 東京', [
      { id: 'cafe', text: 'CAFÉ' }, { id: 'tokyo', text: '東京' }, { id: 'other', text: 'Paris' },
    ]).map(({ record }) => record.id)).toEqual(['cafe', 'tokyo']);
  });
});
