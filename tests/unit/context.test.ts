import { describe, expect, it } from 'vitest';

import { normalizeContextPolicy, translateContext } from '../../src/index.js';

describe('context policy', () => {
  it('defaults to native provider context and inherited memory', () => {
    expect(normalizeContextPolicy()).toEqual({ profile: 'native', memory: 'inherit' });
  });

  it('uses Claude safe mode for clean without breaking OAuth via bare mode', () => {
    const translated = translateContext('claude', { profile: 'clean', memory: 'off' });

    expect(translated.args).toContain('--safe-mode');
    expect(translated.args).not.toContain('--bare');
    expect(translated.report.unavoidable).toContain('admin-managed-policy');
    expect(translated.unsupported).toEqual([]);
  });

  it('declares Claude read-only durable memory unsupported', () => {
    expect(translateContext('claude', { memory: 'read-only' }).unsupported)
      .toContain('memory.read-only');
  });

  it('does not claim Codex exec can fully isolate discovered project instructions', () => {
    const translated = translateContext('codex', { profile: 'clean', memory: 'off' });

    expect(translated.args).toEqual(expect.arrayContaining([
      '--ignore-user-config',
      '--ignore-rules',
      '--disable',
      'memories',
    ]));
    expect(translated.unsupported).toContain('context.clean.project-instructions');
  });
});
