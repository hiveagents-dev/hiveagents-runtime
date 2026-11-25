import { createHash } from 'node:crypto';
import { freeze } from '../../shared/json.js';
import type { LearningFeatures } from './types.js';
function textInput(text: string): void {
    if (typeof text !== 'string' || text.length > 50000)
        throw new TypeError('Task text must contain at most 50000 characters');
}
/** Exact executable UTF-8 identity; normalization is only used for contextual features. */
export function inputDigest(text: string): string { textInput(text); return createHash('sha256').update(text, 'utf8').digest('hex'); }
/** Transparent signed hashing of local word and character ngrams, never task IDs. */
export function hashTaskFeatures(text: string): LearningFeatures {
    textInput(text);
    const values = Array<number>(128).fill(0);
    const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
    const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const add = (token: string, weight: number): void => {
        const hash = createHash('sha256').update(token).digest();
        const bucket = hash.readUInt32LE(0) % 128;
        values[bucket] = values[bucket]! + (hash[4]! & 1 ? -weight : weight);
    };
    for (let i = 0; i < words.length; i++) {
        add(`w:${words[i]!}`, 2);
        if (i)
            add(`b:${words[i - 1]!} ${words[i]!}`, 1);
    }
    for (let n = 3; n <= 5; n++)
        for (let i = 0; i + n <= normalized.length; i++)
            add(`c:${normalized.slice(i, i + n)}`, .25);
    const norm = Math.hypot(...values);
    if (norm)
        for (let i = 0; i < values.length; i++)
            values[i] = values[i]! / norm;
    return freeze({ schema: 'oar-hash-ngrams-v1', values });
}
