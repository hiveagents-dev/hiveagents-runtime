import { describe, expect, it } from 'vitest';

import {
  Runtime,
  doctor,
  type ExecAdapter,
  type ExecTurnRequest,
  type ProtocolResult,
  type ProviderId,
} from '../../src/index.js';

class DiagnosticAdapter implements ExecAdapter {
  constructor(
    readonly id: ProviderId,
    readonly installed: boolean,
    readonly source: 'subscription' | 'api-key',
  ) {}

  async detect() {
    return this.installed
      ? { installed: true, path: `/safe/${this.id}`, version: '1.2.3' }
      : { installed: false };
  }

  async auth() {
    return { authenticated: this.installed, source: this.installed ? this.source : 'unknown' as const };
  }

  async models() {
    return [{
      id: `${this.id}-model`,
      provider: this.id,
      aliases: [],
      source: 'compatibility-catalog' as const,
      availability: 'unverified' as const,
    }];
  }

  async execute(_request: ExecTurnRequest): Promise<ProtocolResult> {
    throw new Error('doctor must not execute inference turns');
  }
}

describe('doctor', () => {
  it('uses non-inference probes and reports auth source without identity', async () => {
    const runtime = new Runtime({ adapters: [
      new DiagnosticAdapter('claude', true, 'subscription'),
      new DiagnosticAdapter('codex', true, 'api-key'),
    ] });

    const report = await doctor({ runtime });

    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]).toMatchObject({
      provider: 'claude',
      installation: { installed: true, path: '/safe/claude', version: '1.2.3' },
      auth: { authenticated: true, source: 'subscription' },
      transports: [
        { kind: 'exec', available: true },
        { kind: 'control', available: false },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(/email|organization/i);
  });

  it('reports fingerprint and redacted capability evidence per provider', async () => {
    const claude = new DiagnosticAdapter('claude', true, 'subscription');
    (claude as ExecAdapter).compatibility = async () => ({
      provider: 'claude' as const,
      cliVersion: '1.2.3',
      transport: 'exec' as const,
      evidence: 'help-probe' as const,
      features: { turns: 'supported' as const, resume: 'unverified' as const },
      missingFlags: [],
      knownIssues: [],
    });
    const runtime = new Runtime({
      adapters: [claude],
      controlAdapters: [{
        token: 'claudeControlV1',
        provider: 'claude',
        packageName: '@open-agent-runtime/claude-control',
        adapterVersion: '0.1.0',
        capabilityVerdicts: { interactiveApprovals: 'full', steering: 'none' },
        evidenceSource: 'sdk-capability',
        sdkVersion: '0.3.252',
      }],
    });

    const report = await doctor({ runtime });

    expect(report.providers[0]).toMatchObject({
      fingerprint: {
        adapterVersion: '0.1.0',
        cliVersion: '1.2.3',
        executableRealpath: '/safe/claude',
        sdkVersion: '0.3.252',
      },
      transports: [
        { kind: 'exec', available: true, detail: expect.stringContaining('claudeExecV1') },
        { kind: 'control', available: true, detail: expect.stringContaining('claudeControlV1') },
      ],
      capabilityEvidence: {
        turns: { support: 'full', sources: ['compatibility-manifest'] },
        resume: { support: 'unknown', sources: ['compatibility-manifest'] },
        interactiveApprovals: { support: 'full', sources: ['sdk-capability'] },
      },
    });
    expect(JSON.stringify(report)).not.toMatch(/email|organization/i);
  });

  it('warns when the CLI cannot honour the respond policy and names what is missing', async () => {
    const claude = new DiagnosticAdapter('claude', true, 'subscription');
    (claude as ExecAdapter).compatibility = async () => ({
      provider: 'claude' as const,
      cliVersion: '1.2.3',
      transport: 'exec' as const,
      evidence: 'live-contract' as const,
      features: { turns: 'supported' as const },
      missingFlags: [],
      knownIssues: [],
      responsePolicy: { supported: false, missing: ['--strict-mcp-config', 'permission-mode.dontAsk'] },
    });
    const report = await doctor({ runtime: new Runtime({ adapters: [claude] }) });
    const provider = report.providers[0]!;
    expect(provider.warnings).toContainEqual({
      code: 'RESPOND_POLICY_UNSUPPORTED',
      message: expect.stringMatching(/--strict-mcp-config.*permission-mode\.dontAsk/),
      providerMetadata: { missing: ['--strict-mcp-config', 'permission-mode.dontAsk'] },
    });
    expect(provider.capabilityEvidence?.respond).toEqual({ support: 'none', sources: ['compatibility-manifest'] });
  });

  it('reports respond evidence without a warning when the policy is supported', async () => {
    const claude = new DiagnosticAdapter('claude', true, 'subscription');
    (claude as ExecAdapter).compatibility = async () => ({
      provider: 'claude' as const,
      cliVersion: '1.2.3',
      transport: 'exec' as const,
      evidence: 'live-contract' as const,
      features: { turns: 'supported' as const },
      missingFlags: [],
      knownIssues: [],
      responsePolicy: { supported: true, missing: [] },
    });
    const report = await doctor({ runtime: new Runtime({ adapters: [claude] }) });
    const provider = report.providers[0]!;
    expect(provider.warnings.map(warning => warning.code)).not.toContain('RESPOND_POLICY_UNSUPPORTED');
    expect(provider.capabilityEvidence?.respond).toEqual({ support: 'full', sources: ['compatibility-manifest'] });
  });

  for (const evidence of ['live-contract', 'help-probe', 'unverified'] as const) {
    for (const supported of [false, true]) {
      it(`bounds respond certainty to ${evidence} evidence when supported is ${supported}`, async () => {
        const claude = new DiagnosticAdapter('claude', true, 'subscription');
        (claude as ExecAdapter).compatibility = async () => ({
          provider: 'claude',
          cliVersion: '1.2.3',
          transport: 'exec',
          evidence,
          features: { turns: 'supported' },
          missingFlags: [],
          knownIssues: [],
          responsePolicy: { supported, missing: supported ? [] : ['--strict-mcp-config'] },
        });

        const report = await doctor({ runtime: new Runtime({ adapters: [claude] }) });
        const provider = report.providers[0]!;

        expect(provider.capabilityEvidence?.respond).toEqual({
          support: !supported ? 'none' : evidence === 'live-contract' ? 'full' : 'unknown',
          sources: ['compatibility-manifest'],
        });
        expect(provider.warnings.some(warning => warning.code === 'RESPOND_POLICY_UNSUPPORTED')).toBe(!supported);
      });
    }
  }

  it('marks an unregistered control transport unavailable and names its token', async () => {
    const runtime = new Runtime({ adapters: [new DiagnosticAdapter('codex', true, 'api-key')] });

    const report = await doctor({ runtime });

    expect(report.providers[0]?.transports[1]).toMatchObject({
      kind: 'control',
      available: false,
      detail: expect.stringContaining('codexAppServerV1'),
    });
  });

  it('does not run auth when a provider is missing', async () => {
    const missing = new DiagnosticAdapter('claude', false, 'subscription');
    let authCalls = 0;
    missing.auth = async () => {
      authCalls += 1;
      return { authenticated: false, source: 'unknown' as const };
    };
    const runtime = new Runtime({ adapters: [missing] });

    const report = await doctor({ runtime });

    expect(authCalls).toBe(0);
    expect(report.providers[0]?.installation.installed).toBe(false);
  });
});
