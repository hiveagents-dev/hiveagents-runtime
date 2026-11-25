import { describe, expect, it } from 'vitest';

import {
  AmbiguousModelError,
  ModelProviderMismatchError,
  UnknownModelError,
  resolveModel,
} from '../../src/index.js';

describe('resolveModel', () => {
  it.each([
    ['opus-5', 'claude', 'claude-opus-5'],
    ['claude-opus-5', 'claude', 'claude-opus-5'],
    ['gpt-5.6-sol', 'codex', 'gpt-5.6-sol'],
    ['o3', 'codex', 'o3'],
  ] as const)('resolves %s to %s', (requested, provider, id) => {
    expect(resolveModel(requested)).toMatchObject({ provider, id });
  });

  it('marks bundled fallback entries as compatibility data', () => {
    expect(resolveModel('opus-5').source).toBe('compatibility-catalog');
  });

  it('accepts an explicitly prefixed unknown id for provider validation later', () => {
    expect(resolveModel('claude/claude-future-9')).toMatchObject({
      provider: 'claude',
      id: 'claude-future-9',
      source: 'explicit',
      availability: 'unverified',
    });
  });

  it.each(['best', 'default'])('requires a prefix for ambiguous alias %s', (name) => {
    expect(() => resolveModel(name)).toThrow(AmbiguousModelError);
  });

  it('rejects a provider prefix that contradicts a recognized model family', () => {
    expect(() => resolveModel('codex/claude-opus-5')).toThrow(ModelProviderMismatchError);
  });

  it('rejects an unknown unprefixed model with suggestions', () => {
    try {
      resolveModel('opuz-5');
      throw new Error('expected resolveModel to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      expect((error as UnknownModelError).suggestions).toContain('opus-5');
    }
  });
});
