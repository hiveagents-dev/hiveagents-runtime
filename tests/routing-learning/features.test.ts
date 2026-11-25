import { describe, expect, it } from 'vitest';
import { hashTaskFeatures, inputDigest } from '../../src/routing/learning/features.js';
describe('local task features', () => {
    it('hashes text deterministically into bounded normalized local features', () => {
        const a = hashTaskFeatures('Calculate the total sum of five integers');
        expect(a.schema).toBe('oar-hash-ngrams-v1');
        expect(a.values).toHaveLength(128);
        expect(Math.hypot(...a.values)).toBeCloseTo(1);
        expect(a).toEqual(hashTaskFeatures('Calculate the total sum of five integers'));
        expect(a).not.toEqual(hashTaskFeatures('Write a friendly poem about an ocean'));
        expect(Object.isFrozen(a.values)).toBe(true);
        expect(inputDigest('a')).not.toBe(inputDigest('A'));
    });
    it('rejects oversized and malformed input and leaves empty text cold', () => {
        expect(() => hashTaskFeatures('x'.repeat(50001))).toThrow();
        expect(hashTaskFeatures('').values.every(v => v === 0)).toBe(true);
    });
});
