import { describe, expect, it } from 'vitest';
import { AdapterRegistry, Agent, Runtime, doctor, runCli, type ProviderRegistration, type ModelInfo, type ExecTurnRequest } from '../../src/index.js';

function provider(alias = 'fixture', version = 'fixture-1'): ProviderRegistration {
  const catalog: ModelInfo[] = [{ id: 'NativeCase', provider: 'fixture-provider', aliases: [alias], source: 'explicit', availability: 'unverified' }];
  const adapter = {
    id: 'fixture-provider',
    detect: async () => ({ installed: true, version: '1.0.0' }),
    auth: async () => ({ authenticated: true, source: 'subscription' as const }),
    models: async () => catalog,
    compatibility: async () => ({ provider: 'fixture-provider', cliVersion: '1.0.0', transport: 'exec' as const, evidence: 'live-contract' as const, features: { turns: 'supported' as const, resume: 'supported' as const }, missingFlags: [], knownIssues: [] }),
    execute: async (request: ExecTurnRequest) => ({ completed: true, failed: false, refused: false, sessionId: request.sessionId ?? 'opaque-session-id', text: request.modelId, events: [], nativeEvents: [] }),
  };
  return { apiVersion: 1, id: 'fixture-provider', exec: { adapter, token: 'fixtureExecV1', adapterVersion: version, withTarget: () => adapter }, modelCatalog: catalog,
    resolveModel: (id) => ({ ...catalog[0]!, id }),
    translateContext: () => ({ args: [], unsupported: [], warnings: [], report: { profile: 'native', memory: 'inherit', active: [], inactive: [], unavoidable: [], unknown: [] } }),
    translatePermissions: (requested) => ({ args: [], report: { requested, effective: { filesystem: 'read-only', network: 'unknown', approvals: 'deny', enforcedBy: ['harness'] }, unsupported: [], warnings: [] } }),
    validateOptions: () => {},
  };
}

describe('provider registrations', () => {
  it('protects registered metadata from mutations through the runtime', () => {
    const runtime = new Runtime({ providers: [provider()] });
    expect(() => runtime.registration('fixture-provider').modelCatalog[0]!.aliases.push('changed')).toThrow();
    expect(runtime.resolveModel('fixture').id).toBe('NativeCase');
  });
  it('validates direct registry identities even when callers supply tokens', () => {
    const registry = new AdapterRegistry();
    for (const id of ['Bad', '__proto__', 'constructor', 'prototype', 'toString']) {
      expect(() => registry.registerExec({ adapter: { ...provider().exec.adapter, id }, token: 'externalExecV1' })).toThrow();
    }
    expect(() => registry.registerExec({ ...provider().exec, token: 'unversioned' })).toThrow();
  });
  it('isolates catalog snapshots, opaque sessions, doctor and CLI per runtime', async () => {
    const first = provider();
    const a = new Runtime({ providers: [first] });
    const b = new Runtime({ providers: [provider('other', 'fixture-2')] });
    first.modelCatalog[0]!.aliases.push('mutated');
    expect(a.resolveModel('fixture').id).toBe('NativeCase');
    expect(a.resolveModel('fixture-provider/UPPER').id).toBe('UPPER');
    expect(() => b.resolveModel('fixture')).toThrow();
    expect(() => a.resolveModel('mutated')).toThrow();
    const session = await new Agent({ model: 'fixture' }, a).openSession();
    expect((await session.send('hello')).text).toBe('NativeCase');
    expect(session.export().id).toBe('opaque-session-id');
    const resumed = await new Agent({ model: 'fixture' }, a).openSession({ resume: session.export() });
    expect((await resumed.send('again')).session.id).toBe('opaque-session-id');
    await resumed.close();
    expect((await doctor({ runtime: a })).providers[0]?.fingerprint?.adapterVersion).toBe('fixture-1');
    let output = '';
    expect(await runCli(['models'], { stdout: (text) => { output += text; }, stderr: () => {} }, b)).toBe(0);
    expect(output).toContain('other');
    await session.close();
  });
  it('rejects malformed, reserved, mismatched and colliding identities', () => {
    for (const id of ['Bad', '__proto__', 'constructor', 'prototype', 'a/b']) expect(() => new Runtime({ providers: [{ ...provider(), id }] })).toThrow();
    expect(() => new Runtime({ providers: [provider(), provider()] })).toThrow();
    expect(() => new Runtime({ providers: [{ ...provider(), id: 'different' }] })).toThrow();
    expect(() => new Runtime({ providers: [provider()], adapters: [] })).toThrow();
    const second = provider();
    second.id = 'second'; second.exec.adapter = { ...second.exec.adapter, id: 'second' }; second.modelCatalog = [{ ...second.modelCatalog[0]!, provider: 'second' }];
    expect(() => new Runtime({ providers: [provider(), second] })).toThrow();
    second.exec.token = 'secondExecV1';
    const runtime = new Runtime({ providers: [provider(), second] });
    expect(() => runtime.resolveModel('fixture')).toThrow(/ambiguous/i);
  });
});
