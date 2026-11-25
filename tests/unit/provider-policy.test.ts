import { describe, expect, it } from 'vitest';
import { Agent, Runtime, UnknownProviderError, createClaudeProvider, translateContext, translatePermissions } from '../../src/index.js';
import { registrationFixture } from './fixtures/provider-registration.js';

describe('registered provider policy', () => {
  it('rejects required image transport even when an exec adapter advertises it', async () => {
    const fixture = registrationFixture();
    fixture.registration.exec.adapter.compatibility = async () => ({
      provider: fixture.registration.id, cliVersion: '1.0.0', transport: 'exec',
      evidence: 'live-contract', features: { turns: 'supported', images: 'supported' },
      missingFlags: [], knownIssues: [],
    });
    const runtime = new Runtime({ providers: [fixture.registration] });
    await expect(new Agent({ model: 'fixture', capabilities: { images: 'required' } }, runtime).ready())
      .rejects.toThrow(/images/);
    expect(fixture.requests).toHaveLength(0);
  });
  it('rejects unregistered providers and never falls through to a builtin policy', () => {
    expect(() => new Agent({ model: 'unknown/model' })).toThrow(UnknownProviderError);
    expect(() => translateContext('unknown')).toThrow(UnknownProviderError);
    expect(() => translatePermissions('unknown', { mode: 'analyze' })).toThrow(UnknownProviderError);
  });
  it('uses external option validation and translations before any execute', async () => {
    const fixture = registrationFixture();
    const runtime = new Runtime({ providers: [fixture.registration] });
    await expect(new Agent({ model: 'fixture', instructions: 'unsupported' }, runtime).ready()).rejects.toThrow('instructions');
    expect(fixture.requests).toHaveLength(0);
    await new Agent({ model: 'fixture', providerOptions: { external: { 'fixture-provider': { marker: 'allowed' } } } }, runtime).run('hello');
    expect(fixture.requests[0]?.contextArgs).toEqual(['--fixture-context']);
    expect(fixture.requests[0]?.permissionArgs).toEqual(['--fixture-permissions']);
    expect(fixture.requests[0]?.providerOptions).toEqual({ marker: 'allowed' });
  });
  it('negotiates all installation compatibility features and fails closed on required unknown or none', async () => {
    const fixture = registrationFixture();
    const runtime = new Runtime({ providers: [fixture.registration] });
    const ready = await new Agent({ model: 'fixture' }, runtime).ready();
    expect(ready.plan.capabilities.customCapability?.support).toBe('full');
    await expect(new Agent({ model: 'fixture', capabilities: { images: 'required' } }, runtime).ready()).rejects.toThrow(/required capability/i);
    await expect(new Agent({ model: 'fixture', capabilities: { steering: 'required' } }, runtime).ready()).rejects.toThrow(/control/i);
    expect(fixture.requests).toHaveLength(0);
  });
  it('takes immutable provider options snapshots', async () => {
    const fixture = registrationFixture();
    const options = { model: 'fixture', providerOptions: { external: { 'fixture-provider': { marker: 'original' } } } };
    const agent = new Agent(options, new Runtime({ providers: [fixture.registration] }));
    options.providerOptions.external['fixture-provider'].marker = 'mutated';
    await agent.run('hello');
    expect(fixture.requests[0]?.providerOptions?.marker).toBe('original');
  });
});
