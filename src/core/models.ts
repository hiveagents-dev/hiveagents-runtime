import { COMPATIBILITY_MODELS } from '../compatibility/catalog.js';
import {
  AmbiguousModelError,
  ModelProviderMismatchError,
  UnknownModelError,
} from '../public/errors.js';
import type { ModelInfo, ProviderId } from '../public/types.js';

const AMBIGUOUS = new Set(['best', 'default']);

function inferredProvider(id: string): ProviderId | undefined {
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gpt-') || /^o\d/.test(id)) return 'codex';
  return undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = saved;
    }
  }
  return row[b.length] ?? Math.max(a.length, b.length);
}

function suggestionsFor(requested: string): string[] {
  const candidates = COMPATIBILITY_MODELS.flatMap((model) => [model.id, ...model.aliases]);
  return [...new Set(candidates)]
    .map((candidate) => ({ candidate, score: distance(requested, candidate) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

export function resolveModel(requested: string): ModelInfo {
  const normalized = requested.trim().toLowerCase();
  if (!normalized) throw new UnknownModelError(requested);

  const slash = normalized.indexOf('/');
  if (slash > 0) {
    const prefix = normalized.slice(0, slash);
    const id = normalized.slice(slash + 1);
    if ((prefix !== 'claude' && prefix !== 'codex') || !id) {
      throw new UnknownModelError(requested, suggestionsFor(normalized));
    }
    const provider = prefix satisfies ProviderId;
    const inferred = inferredProvider(id);
    if (inferred && inferred !== provider) {
      throw new ModelProviderMismatchError(requested, provider, inferred);
    }
    const known = COMPATIBILITY_MODELS.find(
      (model) => model.provider === provider && (model.id === id || model.aliases.includes(id)),
    );
    return known ? { ...known, aliases: [...known.aliases] } : {
      id,
      provider,
      aliases: [],
      source: 'explicit',
      availability: 'unverified',
    };
  }

  if (AMBIGUOUS.has(normalized)) {
    throw new AmbiguousModelError(requested, ['claude', 'codex']);
  }

  const known = COMPATIBILITY_MODELS.find(
    (model) => model.id === normalized || model.aliases.includes(normalized),
  );
  if (known) return { ...known, aliases: [...known.aliases] };

  const provider = inferredProvider(normalized);
  if (provider) {
    return {
      id: normalized,
      provider,
      aliases: [],
      source: 'explicit',
      availability: 'unverified',
    };
  }

  throw new UnknownModelError(requested, suggestionsFor(normalized));
}

export function compatibilityModels(provider?: ProviderId): ModelInfo[] {
  return COMPATIBILITY_MODELS
    .filter((model) => provider === undefined || model.provider === provider)
    .map((model) => ({ ...model, aliases: [...model.aliases] }));
}
