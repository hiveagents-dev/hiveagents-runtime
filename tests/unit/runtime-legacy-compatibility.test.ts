import { describe, expect, it } from 'vitest';
import { Runtime, UnknownModelError, doctor } from '../../src/index.js';
import { registrationFixture } from './fixtures/provider-registration.js';

describe('runtime legacy compatibility', () => {
  it('normalizes builtin provider prefixes and preserves unknown-model suggestions', () => {
    const runtime = new Runtime();
    expect(runtime.resolveModel('CLAUDE/OPUS')).toEqual(runtime.resolveModel('claude/opus'));
    try { runtime.resolveModel('opuss'); throw new Error('expected unknown model'); }
    catch (error) {
      expect(error).toBeInstanceOf(UnknownModelError);
      expect((error as UnknownModelError).suggestions).toContain('opus');
    }
  });
  it('uses installed adapter models for legacy custom adapters and snapshots returned metadata', async () => {
    const fixture = registrationFixture();
    const catalog = [{ id: 'dynamic-model', provider: 'claude', aliases: ['dynamic'], source: 'agent-sdk' as const, availability: 'available' as const }];
    const runtime = new Runtime({ adapters: [{ ...fixture.registration.exec.adapter, id: 'claude', models: async () => catalog }] });
    expect(await runtime.models()).toEqual(catalog);
    expect((await doctor({ runtime })).providers[0]?.models.models).toEqual(catalog);
    const visible = await runtime.models('claude'); visible[0]!.aliases.push('mutated');
    expect(catalog[0]?.aliases).toEqual(['dynamic']);
  });
  it('rejects provider mismatches from legacy dynamic model catalogues', async () => {
    const fixture = registrationFixture();
    const runtime = new Runtime({ adapters: [{ ...fixture.registration.exec.adapter, id: 'claude' }] });
    await expect(runtime.models()).rejects.toThrow(/provider/i);
  });
  it('rejects an inconsistent explicit model resolver even for inferred builtin IDs', () => {
    const fixture = registrationFixture();
    fixture.registration.id = 'claude';
    fixture.registration.exec.adapter = { ...fixture.registration.exec.adapter, id: 'claude' };
    fixture.registration.modelCatalog = [];
    const runtime = new Runtime({ providers: [fixture.registration] });
    expect(() => runtime.resolveModel('claude-new')).toThrow(/provider/i);
  });
  it('rejects a factory that binds a different provider to the verified target', () => {
    const fixture = registrationFixture();
    fixture.registration.exec.withTarget = () => ({ ...fixture.registration.exec.adapter, id: 'codex' });
    const runtime = new Runtime({ providers: [fixture.registration] });
    expect(() => runtime.adapterWithTarget('fixture-provider', { command: process.execPath, argsPrefix: [] }))
      .toThrow(/provider/i);
  });
});
