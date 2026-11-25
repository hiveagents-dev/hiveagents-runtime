/**
 * BM25/cosine/MMR retrieval adapted from Ruflo's hybrid-retrieval.ts at
 * 0a96fb8857dabd343d71d76c3ca703100a2923bc (MIT, copyright 2024-2026 ruvnet).
 * The upstream notice is in docs/licenses/ruflo-memory-MIT.txt.
 */

/** A caller-owned record. No store is opened, retained, or searched implicitly. */
export interface MemoryDocument {
  id: string;
  text: string;
  embedding?: readonly number[];
}

export interface MemoryRankingOptions {
  /** Maximum results; a nonnegative safe integer. Default: 5. */
  limit?: number;
  /** Weight in [0, 1]. Default: 1. At least one retrieval weight must be positive. */
  lexicalWeight?: number;
  /** Weight in [0, 1]. Default: 0. A positive value requires queryEmbedding. */
  semanticWeight?: number;
  /** Supplied by the caller, from the same model as document embeddings. */
  queryEmbedding?: readonly number[];
  /**
   * MMR penalty in [0, 1]; 0 disables reranking. Default: 0.
   * Uses cosine between nonzero vectors, otherwise token-set Jaccard similarity.
   * Seeds the most relevant record even when diversity=1.
   */
  diversity?: number;
}

export interface MemoryScores {
  /** Unbounded nonnegative BM25 score (k1=1.2, b=0.75). */
  lexical: number;
  /** lexical / (1 + lexical); a zero match stays zero. */
  lexicalNormalized: number;
  /** Cosine similarity clamped to [0, 1]; missing/zero vectors score zero. */
  semantic: number;
  /** Weighted mean of lexicalNormalized and semantic. Not a probability. */
  relevance: number;
  /** Maximum similarity to an earlier MMR selection; 0 when MMR is disabled. */
  redundancy: number;
  /** (1 - diversity) * relevance - diversity * redundancy; may be negative. */
  mmr: number;
}

export interface RankedMemory<T extends MemoryDocument> {
  /** The exact input object; all caller payload and provenance remain intact. */
  record: T;
  scores: MemoryScores;
}

function tokenize(text: string): string[] {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function weight(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number in [0, 1]`);
  }
  return value;
}

/** Scaling first avoids overflow/underflow when all components are finite. */
function unitVector(vector: readonly number[], dimension: number | undefined): number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new TypeError('Embeddings must be nonempty arrays of finite numbers');
  }
  if (dimension !== undefined && vector.length !== dimension) {
    throw new RangeError('All query and document embeddings must have the same dimension');
  }
  let scale = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('Embeddings must contain only finite numbers');
    }
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) return vector.map(() => 0);
  const scaled = vector.map((value) => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map((value) => value / norm);
}

function cosine(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(0, Math.min(1, dot));
}

interface Candidate<T extends MemoryDocument> extends RankedMemory<T> {
  tokens: ReadonlySet<string>;
  vector: readonly number[] | undefined;
}

function similarity<T extends MemoryDocument>(a: Candidate<T>, b: Candidate<T>): number {
  if (a.vector && b.vector) return cosine(a.vector, b.vector);
  let intersection = 0;
  for (const token of a.tokens) if (b.tokens.has(token)) intersection++;
  const union = a.tokens.size + b.tokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function rerank<T extends MemoryDocument>(
  candidates: Candidate<T>[], limit: number, diversity: number,
): RankedMemory<T>[] {
  if (diversity === 0) {
    return candidates.sort((a, b) => b.scores.relevance - a.scores.relevance)
      .slice(0, limit).map(({ record, scores }) => ({ record, scores }));
  }
  const selected: RankedMemory<T>[] = [];
  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      candidate.scores.mmr = (1 - diversity) * candidate.scores.relevance - diversity * candidate.scores.redundancy;
      const score = selected.length === 0 ? candidate.scores.relevance : candidate.scores.mmr;
      // Strict > leaves equal scores in the caller's original input order.
      if (score > bestScore) { bestIndex = i; bestScore = score; }
    }
    const chosen = candidates.splice(bestIndex, 1)[0]!;
    selected.push({ record: chosen.record, scores: chosen.scores });
    for (const candidate of candidates) {
      candidate.scores.redundancy = Math.max(candidate.scores.redundancy, similarity(candidate, chosen));
    }
  }
  return selected;
}

/**
 * Rank only the supplied records. Pure, synchronous, browser-safe, and stateless:
 * it never fetches embeddings, opens a store, or retains provider memory.
 *
 * The default is lexical BM25 with accent-folded Unicode tokens. There is no
 * stemming, stop-word removal, or synonym expansion. Scores depend on the
 * supplied corpus. Semantic retrieval and diversity are explicit opt-ins.
 * All supplied vectors are validated, including when unused or limit=0.
 * Equal scores retain input order. The caller owns filtering/authorization,
 * forgetting, persistence, and ensuring embeddings share a model/version.
 */
export function rankMemories<T extends MemoryDocument>(
  query: string, documents: readonly T[], options: MemoryRankingOptions = {},
): RankedMemory<T>[] {
  if (typeof query !== 'string' || !Array.isArray(documents)) {
    throw new TypeError('query must be a string and documents must be an array');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const limit = options.limit === undefined ? 5 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a nonnegative safe integer');
  }
  const lexicalWeight = weight(options.lexicalWeight, 1, 'lexicalWeight');
  const semanticWeight = weight(options.semanticWeight, 0, 'semanticWeight');
  const diversity = weight(options.diversity, 0, 'diversity');
  const totalWeight = lexicalWeight + semanticWeight;
  if (totalWeight === 0) throw new RangeError('At least one retrieval weight must be positive');
  if (semanticWeight > 0 && options.queryEmbedding === undefined) {
    throw new TypeError('A positive semanticWeight requires queryEmbedding');
  }
  const queryVector = options.queryEmbedding === undefined ? undefined : unitVector(options.queryEmbedding, undefined);
  let dimension = queryVector?.length;
  const vectors = documents.map((record) => {
    if (!record || typeof record.id !== 'string' || record.id.length === 0 || typeof record.text !== 'string') {
      throw new TypeError('Every document must have a nonempty string id and string text');
    }
    if (record.embedding === undefined) return undefined;
    const vector = unitVector(record.embedding, dimension);
    dimension ??= vector.length;
    return vector.some((value) => value !== 0) ? vector : undefined;
  });
  if (limit === 0 || documents.length === 0) return [];
  const queryTokens = new Set(tokenize(query));
  const tokenized = documents.map((record) => tokenize(record.text));
  const frequencies = tokenized.map((tokens) => {
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of frequencies) {
    for (const token of counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / (documents.length || 1);
  const candidates = documents.map((record, index): Candidate<T> => {
    let lexical = 0;
    for (const token of queryTokens) {
      const frequency = frequencies[index]!.get(token) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(token)!;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const norm = tokenized[index]!.length / (averageLength || 1);
      lexical += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * norm));
    }
    const lexicalNormalized = lexical / (1 + lexical);
    const semantic = cosine(queryVector, vectors[index]);
    // Normalize weights before multiplying, so tiny positive weights stay useful.
    const relevance = (lexicalWeight / totalWeight) * lexicalNormalized + (semanticWeight / totalWeight) * semantic;
    return { record, tokens: new Set(tokenized[index]), vector: vectors[index], scores: {
      lexical, lexicalNormalized, semantic, relevance,
      redundancy: 0, mmr: relevance,
    } };
  }).filter(({ scores }) => scores.relevance > 0);
  return rerank(candidates, limit, diversity);
}
