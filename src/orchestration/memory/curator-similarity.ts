import { createHash } from 'node:crypto';
import { digest } from '../../shared/json.js';
import { normalizedEpisodeText } from './curator-acceptance.js';
import type { MemoryScope } from './ports.js';

/**
 * Near-duplicate detection for the paraphrase cooldown, with no model and no text kept.
 *
 * A text's words are its runs of letters and digits after the episode normalization (NFKC,
 * invisible format characters removed, lower-cased). Each distinct word is hashed with the
 * scope as salt and truncated to 32 bits; a sketch keeps the `SKETCH_SIZE` smallest hashes,
 * ascending (a bottom-k sketch). Two sketches estimate the Jaccard similarity of the word sets;
 * for texts of at most `SKETCH_SIZE` distinct words, which covers lessons of a sentence or two,
 * the estimate is exact. The measure is language-neutral: no stop words, no stemming. It
 * catches reworded copies that keep most of the words (nonce variants, reordering, a word
 * swapped), not a rewrite in other words.
 */

export const SKETCH_SIZE = 64;
const WORD = /[\p{L}\p{N}]+/gu;

/** The sketch of a text in a scope: up to 64 hashes of 8 hex characters, ascending, concatenated. */
export function textSketch(scope: MemoryScope, text: string): string {
  const salt = digest([scope.tenant, scope.namespace, scope.subject ?? null]);
  const words = new Set(normalizedEpisodeText(text).match(WORD) ?? []);
  const hashes = new Set<string>();
  for (const word of words) hashes.add(createHash('sha256').update(`${salt}\0${word}`).digest('hex').slice(0, 8));
  return [...hashes].sort().slice(0, SKETCH_SIZE).join('');
}

function hashesOf(sketch: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < sketch.length; at += 8) out.push(sketch.slice(at, at + 8));
  return out;
}

/** Estimated Jaccard similarity of the word sets behind two sketches; 0 when either is empty. */
export function sketchSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const left = new Set(hashesOf(a));
  const right = new Set(hashesOf(b));
  const union = [...new Set([...left, ...right])].sort().slice(0, SKETCH_SIZE);
  let shared = 0;
  for (const hash of union) if (left.has(hash) && right.has(hash)) shared += 1;
  return shared / union.length;
}
