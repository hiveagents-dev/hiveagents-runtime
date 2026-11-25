import { normalizeContextPolicy } from '../../core/context.js';
import { UnsupportedCapabilityError } from '../../public/errors.js';
import type { ControlSessionRequest } from '../../session/control-session.js';
import type { SdkQueryOptions } from './sdk.js';

/** Translate only verified SDK options; never silently discard an exec option. */
export function claudeQueryOptions(request: ControlSessionRequest): SdkQueryOptions {
  if (request.providerOptions && Object.keys(request.providerOptions).length > 0) {
    throw new UnsupportedCapabilityError(
      { provider: 'claude', transport: 'control', retryable: false },
      'Claude providerOptions are currently supported only by the exec transport',
    );
  }
  const context = normalizeContextPolicy(request.context);
  return {
    systemPrompt: {
      type: 'preset', preset: 'claude_code',
      ...(request.instructions === undefined ? {} : { append: request.instructions }),
    },
    ...(context.profile === 'project' ? { settingSources: ['project', 'local'] } : {}),
    ...(context.profile === 'clean' ? { extraArgs: { 'safe-mode': null } } : {}),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    additionalDirectories: request.envelope.filesystem.readonlyRoots.filter((root) => root !== request.cwd),
  };
}
