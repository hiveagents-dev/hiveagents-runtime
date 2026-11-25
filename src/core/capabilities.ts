import {
  RequiredTransportUnavailableError,
  UnsupportedCapabilityError,
} from '../public/errors.js';
import { controlUnavailableMessage } from './registry.js';
import type {
  CapabilityRequirements,
  CapabilitySupport,
  ProviderId,
  SessionPersistence,
  TransportKind,
  TransportPreference,
} from '../public/types.js';

const CONTROL_ONLY: ReadonlyArray<keyof CapabilityRequirements> = [
  'interactiveApprovals',
  'userInputDuringTurn',
  'steering',
  'inProcessTools',
  'dynamicPermissions',
  'sessionInspection',
  'checkpointOrRollback',
  // Ningún exec CLI confirma un fork sin prompt; exigirlo debe rutear a control
  // en vez de elegir exec y fallar cerrado después.
  'forkWithoutPrompt',
];

export interface TransportSelectionInput {
  provider: ProviderId;
  execCapabilities?: Readonly<Record<string, CapabilitySupport>> | undefined;
  preference: TransportPreference;
  requirements: CapabilityRequirements;
  persistence: SessionPersistence;
  controlAvailable: boolean;
  /** A control adapter is registered but the experimentalControl gate is off. */
  controlRegistered?: boolean;
}

function controlUnavailable(input: TransportSelectionInput, detail: string): never {
  if (input.controlRegistered ?? false) {
    throw new UnsupportedCapabilityError(
      { provider: input.provider, transport: 'control', retryable: false },
      `${detail}; the ${input.provider} control adapter is registered but requires the explicit experimentalControl opt-in`,
    );
  }
  throw new RequiredTransportUnavailableError(
    { provider: input.provider, transport: 'control', retryable: false },
    `${detail}; ${controlUnavailableMessage(input.provider)}`,
  );
}

function requiredControlCapabilities(input: TransportSelectionInput): string[] {
  const required = CONTROL_ONLY.filter((name) => {
    const value = input.requirements[name];
    return value === true || value === 'required';
  });
  const processPersistence = input.requirements.processPersistence;
  if (input.persistence === 'process' || processPersistence === true || processPersistence === 'required') {
    required.push('processPersistence');
  }
  const deltas = input.requirements.messageDeltas ?? input.requirements.tokenDeltas;
  if ((input.execCapabilities?.messageDeltas === 'unsupported' || input.execCapabilities?.tokenDeltas === 'unsupported' || input.provider === 'codex') && (deltas === true || deltas === 'required')) {
    required.push('messageDeltas');
  }
  return [...new Set(required)];
}

export function selectTransport(input: TransportSelectionInput): TransportKind {
  const requiresControl = requiredControlCapabilities(input);

  if (input.preference === 'exec' && requiresControl.length > 0) {
    throw new UnsupportedCapabilityError(
      { provider: input.provider, transport: 'exec', retryable: false },
      `Exec transport cannot provide: ${requiresControl.join(', ')}`,
    );
  }

  if (input.preference === 'control') {
    if (!input.controlAvailable) {
      controlUnavailable(input, 'Control transport was explicitly requested');
    }
    return 'control';
  }

  if (requiresControl.length > 0) {
    if (!input.controlAvailable) {
      controlUnavailable(input, `Capabilities require control transport: ${requiresControl.join(', ')}`);
    }
    return 'control';
  }

  return 'exec';
}
