import { translateContext } from '../../core/context.js';
import { CODEX_LOGIN_PROVIDER_ARGS } from '../codex/exec-adapter.js';
import { UnsupportedCapabilityError } from '../../public/errors.js';
import type { ControlSessionRequest } from '../../session/control-session.js';

const SAFE_CONFIG = new Set(['web_search', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity']);

/** Authority-owned settings cannot be overridden through raw provider config. */
export function codexControlConfiguration(request: ControlSessionRequest): {
  args: string[];
  params: Record<string, unknown>;
} {
  const options = request.providerOptions ?? {};
  if ((request.context?.profile ?? 'native') !== 'native'
    || request.envelope.filesystem.readonlyRoots.some((root) => root !== request.cwd)
    || request.envelope.filesystem.writableRoots.some((root) => root !== request.cwd)) {
    throw new UnsupportedCapabilityError(
      { provider: 'codex', transport: 'control', retryable: false },
      'Codex control currently supports native context and the working-directory root only',
    );
  }
  const config = options.config;
  const invalid = Object.keys(options).some((key) => key !== 'config')
    || (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config)))
    || Object.keys(config ?? {}).some((key) => !SAFE_CONFIG.has(key));
  if (invalid) {
    throw new UnsupportedCapabilityError(
      { provider: 'codex', transport: 'control', retryable: false },
      'Codex control providerOptions accepts only supported non-authority config keys',
    );
  }
  const mode = request.envelope.permissionModeCeiling;
  const sandbox = mode === 'bypassPermissions' ? 'danger-full-access'
    : mode === 'acceptEdits' ? 'workspace-write' : 'read-only';
  return {
    args: [...(request.requireSubscription ? CODEX_LOGIN_PROVIDER_ARGS : []), ...translateContext('codex', request.context).args, 'app-server', '--stdio'],
    params: Object.freeze({
      sandbox,
      approvalPolicy: mode === 'bypassPermissions' ? 'never' : 'on-request',
      ...(request.resume === undefined ? { ephemeral: request.persistence === 'process' } : {}),
      ...(request.instructions === undefined ? {} : { developerInstructions: request.instructions }),
      config: Object.freeze({
        ...(config as Record<string, unknown> | undefined),
        ...(request.effort === undefined ? {} : { model_reasoning_effort: request.effort }),
      }),
    }),
  };
}
