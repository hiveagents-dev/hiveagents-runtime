import { UnknownProviderError } from '../public/errors.js';
import type {
  EnforcementReport,
  PermissionIntent,
  ProviderId,
  TransportKind,
} from '../public/types.js';

export interface PermissionTranslation {
  args: string[];
  report: EnforcementReport;
}

export function translatePermissions(
  provider: ProviderId,
  requested: PermissionIntent,
  transport: TransportKind = 'exec',
): PermissionTranslation {
  if (provider !== 'claude' && provider !== 'codex') throw new UnknownProviderError(provider);
  if (requested.mode === 'respond' && (provider !== 'claude' || transport !== 'exec')) {
    throw new TypeError('respond is only supported by Claude exec');
  }
  if (!['analyze', 'respond', 'edit', 'unrestricted'].includes(requested.mode)) {
    throw new TypeError('Unknown permission mode');
  }
  const args: string[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  const enforcedBy: EnforcementReport['effective']['enforcedBy'] = [];
  let filesystem = 'unknown';
  let network = 'provider-default';
  let approvals = 'non-interactive';

  if (provider === 'claude') {
    if (requested.mode === 'respond') {
      args.push('--permission-mode', 'dontAsk', '--strict-mcp-config');
      filesystem = 'no filesystem tools; harness tool restriction, not an OS sandbox';
      approvals = 'deny-unapproved';
      enforcedBy.push('harness');
    } else if (requested.mode === 'analyze') {
      args.push('--permission-mode', 'plan');
      filesystem = 'provider plan mode; write prevention is not an OS sandbox';
      enforcedBy.push('harness');
    } else if (requested.mode === 'edit') {
      args.push('--permission-mode', 'acceptEdits');
      filesystem = 'provider edit permissions within configured roots';
      enforcedBy.push('harness');
      warnings.push('Exec cannot answer interactive approval requests');
    } else {
      args.push('--dangerously-skip-permissions');
      filesystem = 'unrestricted';
      network = 'unrestricted';
      approvals = 'bypassed';
      warnings.push('Claude permission checks are bypassed');
    }
    if (requested.network === 'deny') unsupported.push('network.deny');
    if (requested.network === 'allow') network = 'provider-default; not guaranteed';
  } else {
    // Exec has no channel to answer an approval, and a Codex config may hand approvals to a reviewer model
    // (`approvals_reviewer`), which would then decide whether a command leaves the sandbox. `never` rejects every
    // escalation request instead, whatever the config says (measured with codex-cli 0.153.4). Control answers
    // approvals itself through the app-server and does not use these arguments.
    const never = transport === 'exec' ? ['--ask-for-approval', 'never'] : [];
    if (requested.mode === 'analyze') {
      args.push('--sandbox', 'read-only', ...never);
      filesystem = 'read-only sandbox';
      enforcedBy.push('sandbox');
      if (never.length) approvals = 'never; escalation requests are rejected';
    } else if (requested.mode === 'edit') {
      args.push('--sandbox', 'workspace-write', ...never);
      filesystem = 'workspace-write sandbox';
      enforcedBy.push('sandbox');
      if (never.length) approvals = 'never; escalation requests are rejected';
      warnings.push('Exec cannot answer interactive approval requests');
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
      filesystem = 'unrestricted';
      network = 'unrestricted';
      approvals = 'bypassed';
      warnings.push('Codex approvals and sandbox are bypassed');
    }
    if (requested.network === 'deny') unsupported.push('network.deny');
    if (requested.network === 'allow') network = 'provider-default; not guaranteed';
  }

  for (const directory of requested.additionalDirectories ?? []) {
    args.push('--add-dir', directory);
  }

  if (requested.minimumEnforcement && !enforcedBy.includes(requested.minimumEnforcement)) {
    unsupported.push(`minimumEnforcement.${requested.minimumEnforcement}`);
  }

  if (transport === 'control' && requested.mode !== 'unrestricted') {
    // Claude control answers canUseTool within the session's permission mode. Codex control asks
    // on-request, but accepting a command or file-change escalation would leave the sandbox: below
    // an unrestricted session the bridge can only decline them (codex-control/approval-policy.ts).
    approvals = provider === 'claude'
      ? 'interactive'
      : 'interactive; decline-only for command and file-change escalations below unrestricted';
    const execWarning = warnings.indexOf('Exec cannot answer interactive approval requests');
    if (execWarning !== -1) warnings.splice(execWarning, 1);
  }

  return {
    args,
    report: {
      requested: { ...requested },
      effective: { filesystem, network, approvals, enforcedBy },
      unsupported,
      warnings,
    },
  };
}
