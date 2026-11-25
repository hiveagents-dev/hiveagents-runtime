import type { MemoryCaptureRequest, MemoryRecallRequest } from '../../src/public/memory-types.js';
import type { Turn } from '../../src/public/types.js';
import type { EmbeddingIdentity, MemoryEmbedder, MemoryScope } from '../../src/orchestration/memory/index.js';

/** A completed turn as the core hands it to `capture`. */
export function completedTurn(overrides: Partial<Turn> = {}, session: Partial<Turn['session']> = {}): Turn {
  return {
    id: 'turn-1',
    session: {
      schemaVersion: 1,
      provider: 'claude',
      id: 'session-1',
      model: 'claude-test',
      cwd: '/work',
      transport: 'exec',
      persistence: 'provider',
      createdAt: '2026-11-10T09:00:00.000Z',
      transportEpoch: 'epoch-1',
      ...session,
    },
    status: 'completed',
    text: 'El cliente paga a treinta días.',
    events: [{ type: 'message.completed', text: 'secret-looking event payload' }],
    warnings: [],
    providerMetadata: { apiKey: 'never-stored' },
    ...overrides,
  };
}

export function recallRequest(scope: MemoryScope, text: string, overrides: Partial<MemoryRecallRequest> = {}): MemoryRecallRequest {
  return {
    scope, text, provider: 'claude', transport: 'exec', cwd: '/work', limit: 2,
    signal: new AbortController().signal, ...overrides,
  };
}

/** The SDK stamps every capture request with the time it delivered the turn. */
export const CAPTURED_AT = '2026-11-15T12:00:00.000Z';

export function captureRequest(scope: MemoryScope, overrides: Partial<MemoryCaptureRequest> = {}): MemoryCaptureRequest {
  return {
    scope, input: '¿Cuándo paga el cliente?', turn: completedTurn(), completedAt: CAPTURED_AT,
    signal: new AbortController().signal, ...overrides,
  };
}

export const IDENTITY: EmbeddingIdentity = { provider: 'test', model: 'bag-of-letters', revision: '1', dimensions: 3 };

/** A deterministic toy embedder: counts of three letters. It proves the contract, not retrieval quality. */
export function letterEmbedder(identity: EmbeddingIdentity = IDENTITY, calls: string[][] = []): MemoryEmbedder {
  return {
    identity,
    async embed(texts, signal) {
      signal?.throwIfAborted();
      calls.push([...texts]);
      return texts.map(text => ['a', 'e', 'o'].slice(0, identity.dimensions)
        .map(letter => text.split(letter).length - 1)
        .concat(Array(Math.max(0, identity.dimensions - 3)).fill(0)));
    },
  };
}

/** A promise that never settles, as a port ignoring its signal would. */
export function hanging<T>(): Promise<T> {
  return new Promise<T>(() => {});
}
