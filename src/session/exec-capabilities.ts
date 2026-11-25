import type { CapabilitySupport, ProviderId } from '../public/types.js';

/** Provider evidence cannot advertise channels the exec host cannot transport. */
export function buildExecFeatures(
  reported: Record<string, CapabilitySupport> = {},
  provider: ProviderId,
  streaming: boolean,
): Record<string, CapabilitySupport> {
  const deltas = streaming
    ? reported.messageDeltas ?? reported.tokenDeltas ?? (provider === 'codex' ? 'unsupported' : 'unverified')
    : 'unsupported';
  return {
    turns: 'unverified',
    resume: 'unverified',
    forkWithPrompt: 'unverified',
    structuredOutput: 'unverified',
    ...reported,
    tokenDeltas: deltas,
    messageDeltas: deltas,
    forkWithoutPrompt: 'unsupported',
    images: 'unsupported',
    files: 'unsupported',
    interactiveApprovals: 'unsupported',
    userInputDuringTurn: 'unsupported',
    steering: 'unsupported',
    inProcessTools: 'unsupported',
    dynamicPermissions: 'unsupported',
    sessionInspection: 'unsupported',
    checkpointOrRollback: 'unsupported',
    processPersistence: 'unsupported',
  };
}
