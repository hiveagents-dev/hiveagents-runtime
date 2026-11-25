import { describe, expect, it } from 'vitest';
import { Agent, Runtime, doctor, NotAuthenticatedError, UnexpectedAuthSourceError } from '../../src/index.js';
import { registrationFixture } from './fixtures/provider-registration.js';

describe('authentication evidence', () => {
  it.each(['oauth', 'api-key', 'cloud-provider', 'unknown'] as const)('reports passive %s configuration and allows an explicitly requested any turn', async (source) => {
    const fixture = registrationFixture();
    fixture.setAuth({ authenticated: false, state: 'unknown', evidence: 'local-configuration', source });
    const runtime = new Runtime({ providers: [fixture.registration] });
    const agent = new Agent({ model: 'fixture', requireAuth: 'any' }, runtime);
    const readiness = await agent.ready();
    expect(readiness.auth).toEqual({ authenticated: false, state: 'unknown', evidence: 'local-configuration', source });
    expect(readiness.capabilities.warnings.some((warning) => warning.code === 'AUTH_UNVERIFIED')).toBe(true);
    const report = await doctor({ runtime });
    expect(report.providers[0]?.auth.state).toBe('unknown');
    expect(report.providers[0]?.warnings.some((warning) => warning.code === 'AUTH_UNVERIFIED')).toBe(true);
    expect(fixture.requests).toHaveLength(0);
    expect((await agent.run('hello')).text).toBe('NativeCase');
  });
  it('fails closed for absent credentials and treats the default as any', async () => {
    const fixture = registrationFixture();
    const runtime = new Runtime({ providers: [fixture.registration] });
    fixture.setAuth({ authenticated: false, state: 'not-authenticated', evidence: 'provider-status', source: 'unknown' });
    await expect(new Agent({ model: 'fixture', requireAuth: 'any' }, runtime).ready()).rejects.toBeInstanceOf(NotAuthenticatedError);
    fixture.setAuth({ authenticated: false, state: 'unknown', evidence: 'local-configuration', source: 'oauth' });
    expect((await new Agent({ model: 'fixture' }, runtime).ready()).auth.state).toBe('unknown');
    await expect(new Agent({ model: 'fixture', requireAuth: 'subscription' }, runtime).ready()).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });
  it('requires confirmed subscription source and preserves legacy boolean evidence', async () => {
    const fixture = registrationFixture();
    const runtime = new Runtime({ providers: [fixture.registration] });
    fixture.setAuth({ authenticated: true, source: 'oauth', state: 'authenticated', evidence: 'provider-status' });
    await expect(new Agent({ model: 'fixture', requireAuth: 'subscription' }, runtime).ready()).rejects.toBeInstanceOf(UnexpectedAuthSourceError);
    fixture.setAuth({ authenticated: true, source: 'subscription' });
    expect((await new Agent({ model: 'fixture', requireAuth: 'subscription' }, runtime).ready()).ready).toBe(true);
  });
});
