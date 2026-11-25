import type { AuthStatus, ExecTurnRequest, ModelInfo, ProviderInstallation, ProviderRegistration } from '../../../src/index.js';
export function registrationFixture() {
  const requests: ExecTurnRequest[] = [];
  let auth: AuthStatus = { authenticated: true, source: 'subscription' };
  let installation: ProviderInstallation = { installed: true, version: '1.0.0' };
  const catalog: ModelInfo[] = [{ id: 'NativeCase', provider: 'fixture-provider', aliases: ['fixture'], source: 'explicit', availability: 'unverified' }];
  const adapter = {
    id: 'fixture-provider',
    detect: async () => installation,
    auth: async () => auth,
    models: async () => catalog,
    compatibility: async () => ({ provider: 'fixture-provider', cliVersion: '1.0.0', transport: 'exec' as const, evidence: 'live-contract' as const, features: { turns: 'supported' as const, resume: 'supported' as const, customCapability: 'supported' as const, structuredOutput: 'unverified' as const }, missingFlags: [], knownIssues: [] }),
    execute: async (request: ExecTurnRequest) => { requests.push(request); return { completed: true, failed: false, refused: false, sessionId: request.sessionId ?? 'opaque-session', text: request.modelId, events: [], nativeEvents: [] }; },
  };
  const registration: ProviderRegistration = { apiVersion: 1, id: 'fixture-provider', exec: { adapter, token: 'fixtureExecV1', adapterVersion: 'fixture-1', withTarget: () => adapter }, modelCatalog: catalog,
    resolveModel: (id) => ({ ...catalog[0]!, id }),
    translateContext: () => ({ args: ['--fixture-context'], unsupported: [], warnings: [], report: { profile: 'native', memory: 'inherit', active: [], inactive: [], unavoidable: [], unknown: [] } }),
    translatePermissions: (requested) => ({ args: ['--fixture-permissions'], report: { requested, effective: { filesystem: 'read-only', network: 'unknown', approvals: 'deny', enforcedBy: ['harness'] }, unsupported: [], warnings: [] } }),
    validateOptions: (options) => { if (options.instructions) throw new Error('Unsupported instructions'); },
  };
  return { registration, requests, setAuth: (value: AuthStatus) => { auth = value; }, setInstallation: (value: ProviderInstallation) => { installation = value; } };
}
