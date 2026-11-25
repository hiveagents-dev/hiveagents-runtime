import { authenticationState } from '../core/auth-evidence.js';
import type { AuthStatus, DoctorReport, ProviderId, RuntimeWarning } from '../public/types.js';

const providers: ReadonlySet<ProviderId> = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const authSources: ReadonlySet<AuthStatus['source']> = new Set([
  'subscription', 'api-key', 'cloud-provider', 'oauth', 'oss', 'unknown',
]);
const warningCodes: ReadonlySet<RuntimeWarning['code']> = new Set([
  'AUTH_UNVERIFIED', 'CLI_FLAGS_MISSING', 'HELP_PROBED_ONLY',
  'UNVERIFIED_CLI_VERSION', 'RESPOND_POLICY_UNSUPPORTED', 'COMPATIBILITY_PROBE_FAILED',
]);
const numericVersion = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;

/** Project the local report to a documented diagnostic format; never copy unbounded adapter metadata. */
export function shareDoctorReport(report: DoctorReport) {
  return {
    format: 1,
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    providers: report.providers.map(({ provider, installation, auth, transports, warnings }) => {
      const version = installation.version;
      return {
        provider: providers.has(provider) ? provider : 'custom',
        installation: {
          installed: installation.installed === true,
          ...(typeof version === 'string' && numericVersion.test(version) ? { version } : {}),
        },
        auth: {
          state: authenticationState(auth),
          source: authSources.has(auth.source) ? auth.source : 'unknown',
        },
        transports: transports.map(({ kind, available }) => ({ kind, available: available === true })),
        warningCodes: [...new Set(warnings.map(({ code }) => code).filter((code) => warningCodes.has(code)))],
      };
    }),
  };
}
