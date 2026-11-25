import { findCompatibilityEntry, type CliCompatibilityAssessment } from '../compatibility/manifest.js';
import { buildEnvironment } from '../core/environment.js';
import {
  controlUnavailableMessage,
} from '../core/registry.js';
import { defaultRuntime, type Runtime } from '../core/runtime.js';
import type {
  AuthStatus,
  CapabilitySupport,
  DoctorReport,
  EnvironmentPolicy,
  ProviderDoctorReport,
  RuntimeWarning,
  SupportLevel,
} from './types.js';

export interface DoctorOptions {
  runtime?: Runtime;
  environment?: EnvironmentPolicy;
}

function supportFromLegacy(support: CapabilitySupport): SupportLevel {
  return support === 'supported'
    ? 'full'
    : support === 'unsupported' ? 'none' : support === 'unverified' ? 'unknown' : 'partial';
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const runtime = options.runtime ?? defaultRuntime;
  const env = buildEnvironment(options.environment ?? { mode: 'inherit' });
  const providers: ProviderDoctorReport[] = [];

  for (const provider of runtime.providers()) {
    const adapter = runtime.adapter(provider);
    const installation = await adapter.detect(env);
    const auth: AuthStatus = installation.installed
      ? await adapter.auth(env)
      : { authenticated: false, source: 'unknown' };
    const visibleModels = await runtime.models(provider);
    const source = visibleModels[0]?.source ?? 'compatibility-catalog';
    const warnings: RuntimeWarning[] = auth.state === 'unknown' ? [{ code: 'AUTH_UNVERIFIED', message: 'Authentication is unverified from local configuration' }] : [];
    let assessment: CliCompatibilityAssessment | undefined;
    if (installation.version) {
      try {
        assessment = await adapter.compatibility?.(env, installation.version);
        const manifestEntry = findCompatibilityEntry(provider, 'exec', installation.version);
        if (assessment?.missingFlags.length) {
          warnings.push({
            code: 'CLI_FLAGS_MISSING',
            message: `${provider} ${installation.version} is missing flags: ${assessment.missingFlags.join(', ')}`,
          });
        } else if (assessment && assessment.evidence !== 'live-contract') {
          warnings.push({
            code: 'HELP_PROBED_ONLY',
            message: `${provider} ${installation.version} flags are visible but live contracts are unverified`,
          });
        } else if (!manifestEntry) {
          warnings.push({
            code: 'UNVERIFIED_CLI_VERSION',
            message: `${provider} ${installation.version} is outside the tested manifest ranges`,
          });
        } else if (!assessment && manifestEntry.evidence !== 'live-contract') {
          warnings.push({
            code: 'HELP_PROBED_ONLY',
            message: `${provider} ${installation.version} has only manifest-level help evidence`,
          });
        }
        if (assessment?.responsePolicy?.supported === false) {
          const { missing } = assessment.responsePolicy;
          warnings.push({
            code: 'RESPOND_POLICY_UNSUPPORTED',
            message: `${provider} ${installation.version} cannot enforce the respond policy; missing: ${missing.join(', ')}`,
            providerMetadata: { missing: [...missing] },
          });
        }
      } catch {
        warnings.push({
          code: 'COMPATIBILITY_PROBE_FAILED',
          message: `${provider} ${installation.version} help probe failed`,
        });
      }
    }

    const control = runtime.controlRegistration(provider);
    const capabilityEvidence: NonNullable<ProviderDoctorReport['capabilityEvidence']> = {};
    if (assessment) {
      for (const [name, support] of Object.entries(assessment.features)) {
        capabilityEvidence[name] = {
          support: supportFromLegacy(support),
          sources: ['compatibility-manifest'],
        };
      }
    }
    if (assessment?.responsePolicy) {
      // Only a tested live contract proves behaviour; flags or unverified claims do not.
      capabilityEvidence.respond = {
        support: !assessment.responsePolicy.supported
          ? 'none'
          : assessment.evidence === 'live-contract' ? 'full' : 'unknown',
        sources: ['compatibility-manifest'],
      };
    }
    if (control) {
      for (const [name, support] of Object.entries(control.capabilityVerdicts)) {
        const existing = capabilityEvidence[name];
        capabilityEvidence[name] = {
          support,
          sources: [...new Set([...(existing?.sources ?? []), control.evidenceSource])],
        };
      }
    }

    providers.push({
      provider,
      installation,
      auth,
      transports: [
        {
          kind: 'exec',
          available: installation.installed,
          detail: `token ${runtime.registration(provider).exec.token}`,
        },
        control
          ? {
              kind: 'control',
              available: true,
              detail: `token ${control.token} registered (${control.packageName}); experimentalControl opt-in required`,
            }
          : {
              kind: 'control',
              available: false,
              detail: controlUnavailableMessage(provider),
            },
      ],
      models: {
        provider,
        source,
        models: visibleModels,
        fetchedAt: new Date().toISOString(),
      },
      memory: 'unknown',
      instructionSources: [],
      warnings,
      fingerprint: {
        adapterVersion: control?.adapterVersion ?? runtime.registration(provider).exec.adapterVersion,
        cliVersion: installation.version ?? 'unknown',
        executableRealpath: installation.realpath ?? installation.path ?? '',
        ...(control?.protocolVersion === undefined ? {} : { protocolVersion: control.protocolVersion }),
        ...(control?.sdkVersion === undefined ? {} : { sdkVersion: control.sdkVersion }),
      },
      ...(Object.keys(capabilityEvidence).length === 0 ? {} : { capabilityEvidence }),
    });
  }

  return { generatedAt: new Date().toISOString(), providers };
}
