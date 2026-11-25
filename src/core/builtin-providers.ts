import { createAntigravityCliProvider } from '../adapters/antigravity/registration.js';
import { createGeminiCliProvider } from '../adapters/gemini/registration.js';
import { ClaudeExecAdapter } from '../adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../adapters/codex/exec-adapter.js';
import type { ProcessRunner } from '../adapters/provider.js';
import type { LaunchTarget } from '../process/resolve-binary.js';
import { UnexpectedAuthSourceError } from '../public/errors.js';
import type { BuiltinProviderId } from '../public/types.js';
import { translateContext } from './context.js';
import { compatibilityModels, resolveModel } from './models.js';
import { translatePermissions } from './permissions.js';
import type { ProviderRegistration } from './provider-registration.js';
import { EXEC_TRANSPORT_TOKENS, RUNTIME_ADAPTER_VERSION } from './registry.js';
import { assertRespondPolicy } from './respond-policy.js';

function builtin(id: BuiltinProviderId, options: { runner?: ProcessRunner; probeRunner?: ProcessRunner } = {}): ProviderRegistration {
  const runner = options.runner;
  const probeRunner = options.probeRunner;
  if (runner !== undefined && typeof runner !== 'function') throw new TypeError('runner must be a function');
  if (probeRunner !== undefined && typeof probeRunner !== 'function') throw new TypeError('probeRunner must be a function');
  const create = (target?: LaunchTarget) => {
    const adapterOptions = { ...(runner === undefined ? {} : { runner }), ...(probeRunner === undefined ? {} : { probeRunner }), ...(target === undefined ? {} : { target }) };
    return id === 'claude' ? new ClaudeExecAdapter(adapterOptions) : new CodexExecAdapter(adapterOptions);
  };
  return {
    apiVersion: 1, id,
    exec: { adapter: create(), token: EXEC_TRANSPORT_TOKENS[id], adapterVersion: RUNTIME_ADAPTER_VERSION,
      withTarget: create },
    modelCatalog: compatibilityModels(id),
    resolveModel: (nativeId) => resolveModel(`${id}/${nativeId}`),
    execCapabilities: { tokenDeltas: id === 'claude' ? 'unverified' : 'unsupported' },
    translateContext: (requested) => translateContext(id, requested),
    translatePermissions: (requested, transport) => translatePermissions(id, requested, transport),
    validateOptions: (options, transport) => {
      assertRespondPolicy(options, id, transport);
      const config = id === 'codex' && options.requireAuth === 'subscription' ? options.providerOptions?.codex?.config : undefined;
      if (config && (config.profile !== undefined || config.openai_base_url !== undefined || (config.model_provider ?? 'openai') !== 'openai')) throw new UnexpectedAuthSourceError(id, {
        transport, retryable: false, sanitizedDiagnostics: { detectedSource: 'provider-config' } });
    },
  };
}
export function createClaudeProvider(options?: { runner?: ProcessRunner; probeRunner?: ProcessRunner }): ProviderRegistration { return builtin('claude', options); }
export function createCodexProvider(options?: { runner?: ProcessRunner; probeRunner?: ProcessRunner }): ProviderRegistration { return builtin('codex', options); }

/** Fresh registrations for the four provider CLIs shipped with the SDK. */
export function createDefaultProviders(): ProviderRegistration[] {
  return [createClaudeProvider(), createCodexProvider(), createGeminiCliProvider(), createAntigravityCliProvider()];
}
