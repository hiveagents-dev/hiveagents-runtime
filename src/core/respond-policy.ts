import { isAuthenticationConfirmed } from './auth-evidence.js';
import type { AgentOptions, AuthStatus, ProviderId, TransportKind } from '../public/types.js';
import { NotAuthenticatedError, UnexpectedAuthSourceError, UnsupportedCapabilityError } from '../public/errors.js';
import type { CliCompatibilityAssessment } from '../compatibility/manifest.js';

export function assertRespondAuth(options: AgentOptions, auth: AuthStatus): void {
  if (!isAuthenticationConfirmed(auth)) throw new NotAuthenticatedError('claude', { retryable: false });
  if (options.requireAuth === 'subscription' && auth.source !== 'subscription') {
    throw new UnexpectedAuthSourceError('claude', { retryable: false, sanitizedDiagnostics: { detectedSource: auth.source } });
  }
}

export function assertRespondCompatibility(options: AgentOptions, compatibility?: CliCompatibilityAssessment): void {
  if (options.permissions?.mode === 'respond' && compatibility?.responsePolicy?.supported !== true) {
    throw new UnsupportedCapabilityError({ provider: 'claude', transport: 'exec', retryable: false },
      `respond requires verified CLI flags: ${compatibility?.responsePolicy?.missing.join(', ') ?? 'response policy was not probed'}`);
  }
}

/** A non-coding response must not inherit the permissions of a coding session.
 * These invariants are mandatory even when optional capability checks are relaxed.
 */
export function assertRespondPolicy(options: AgentOptions, provider: ProviderId, transport: TransportKind): void {
  if (options.permissions?.mode !== 'respond') return;
  const claude = options.providerOptions?.claude;
  const tools = claude?.tools;
  const valid = provider === 'claude' && transport === 'exec'
    && options.context?.profile === 'clean'
    && typeof options.instructions === 'string' && options.instructions.trim().length > 0
    && claude?.systemPromptMode === 'replace'
    && Array.isArray(tools) && tools.every(tool => tool === 'WebSearch')
    && claude.settings === undefined && !claude.mcpConfigs?.length
    && claude.strictMcpConfig !== false
    && !options.permissions.additionalDirectories?.length;
  if (!valid) throw new UnsupportedCapabilityError({ provider, transport, retryable: false },
    'respond requires Claude exec, clean context, replacement instructions, tools [] or [WebSearch], and no settings, MCP or additional directories');
}
