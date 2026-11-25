import type { ControlAdapterRegistration } from '../core/registry.js';
import type {
  CapabilityStatus,
  CapabilitySupport,
  EnforcementReport,
  PermissionIntent,
  PermissionModeCeiling,
  SafetyEnvelope,
  TransportKind,
} from '../public/types.js';

/**
 * Compiles what a `Session` will actually be opened under: the negotiated
 * capability verdicts and the immutable SafetyEnvelope. Both are derived from
 * evidence gathered during readiness, never from adapter internals.
 */

const PERMISSION_MODE_CEILINGS: Record<PermissionIntent['mode'], PermissionModeCeiling> = {
  analyze: 'plan',
  respond: 'default',
  edit: 'acceptEdits',
  unrestricted: 'bypassPermissions',
};

/** Keep the public legacy report scoped to the selected transport too. */
export function controlFeatures(registration: ControlAdapterRegistration): Record<string, CapabilitySupport> {
  const features = Object.fromEntries(Object.entries(registration.capabilityVerdicts).map(([name, support]) => [
    name, support === 'full' ? 'supported' : support === 'none' ? 'unsupported'
      : support === 'unknown' ? 'unverified' : 'partial',
  ])) as Record<string, CapabilitySupport>;
  features.tokenDeltas = features.messageDeltas ?? 'unverified';
  return features;
}

function statusFromLegacy(support: CapabilitySupport, fingerprint: string): CapabilityStatus {
  const normalized = support === 'supported'
    ? 'full'
    : support === 'unsupported' ? 'none' : support === 'unverified' ? 'unknown' : 'partial';
  return {
    support: normalized,
    evidence: [{ source: 'compatibility-manifest', fingerprint }],
  };
}

export function negotiateCapabilities(input: {
  transport: TransportKind;
  registration: ControlAdapterRegistration | undefined;
  features: Record<string, CapabilitySupport>;
  fingerprint: string;
}): Record<string, CapabilityStatus> {
  const { registration } = input;
  const negotiated: Record<string, CapabilityStatus> = input.transport === 'control' && registration
    ? Object.fromEntries(
        Object.entries(registration.capabilityVerdicts).map(([name, support]) => [
          name,
          {
            support,
            evidence: [{ source: registration.evidenceSource, fingerprint: input.fingerprint }],
          } satisfies CapabilityStatus,
        ]),
      )
    : Object.fromEntries(
        Object.entries(input.features).map(([name, support]) => [
          name,
          statusFromLegacy(support, input.fingerprint),
        ]),
      );
  // Exec token deltas are the runtime's message-delta channel; expose the
  // portable name so requirements negotiate against one vocabulary.
  if (negotiated.tokenDeltas && !negotiated.messageDeltas) {
    negotiated.messageDeltas = negotiated.tokenDeltas;
  }
  return negotiated;
}

export function buildSafetyEnvelope(input: {
  cwd: string;
  permissions: PermissionIntent;
  environmentVariables: string[];
  executableRealpath: string;
  modelId: string;
  enforcedBy: EnforcementReport['effective']['enforcedBy'];
  tools?: string[];
  /** MCP server names and config-layer markers (see `mcp-envelope.ts`); absent means none. */
  mcpServers?: string[];
}): SafetyEnvelope {
  const { permissions } = input;
  return {
    authorityEpoch: crypto.randomUUID(),
    filesystem: {
      readonlyRoots: [input.cwd, ...(permissions.additionalDirectories ?? [])],
      writableRoots: permissions.mode === 'analyze' || permissions.mode === 'respond'
        ? []
        : [input.cwd, ...(permissions.additionalDirectories ?? [])],
    },
    network: permissions.network === 'allow' ? [{ protocol: 'https', host: '*' }] : [],
    tools: [...(input.tools ?? [])],
    executables: input.executableRealpath ? [input.executableRealpath] : [],
    mcpServers: [...(input.mcpServers ?? [])],
    environmentVariables: input.environmentVariables,
    settingsPersistence: 'none',
    enforcedBy: input.enforcedBy,
    permissionModeCeiling: PERMISSION_MODE_CEILINGS[permissions.mode],
    modelAllowlist: [input.modelId],
  };
}
