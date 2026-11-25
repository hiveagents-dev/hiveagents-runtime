import { UnknownProviderError } from '../public/errors.js';
import type {
  ContextPolicy,
  ContextSourceReport,
  ProviderId,
} from '../public/types.js';

export interface ContextTranslation {
  args: string[];
  unsupported: string[];
  warnings: string[];
  report: ContextSourceReport;
}

export function normalizeContextPolicy(policy: ContextPolicy = {}): Required<ContextPolicy> {
  return {
    profile: policy.profile ?? 'native',
    memory: policy.memory ?? 'inherit',
  };
}

export function translateContext(
  provider: ProviderId,
  requested: ContextPolicy = {},
): ContextTranslation {
  if (provider !== 'claude' && provider !== 'codex') throw new UnknownProviderError(provider);
  const policy = normalizeContextPolicy(requested);
  const args: string[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  const active: string[] = [];
  const inactive: string[] = [];
  const unavoidable = ['admin-managed-policy'];
  const unknown: string[] = [];

  if (provider === 'claude') {
    if (policy.profile === 'native') {
      active.push('user-settings', 'project-settings', 'discovered-instructions', 'skills', 'hooks', 'plugins', 'mcp');
    } else if (policy.profile === 'project') {
      args.push('--setting-sources', 'project,local');
      active.push('project-settings', 'local-settings', 'discovered-instructions');
      inactive.push('user-settings');
      unknown.push('provider-memory');
    } else {
      args.push('--safe-mode');
      inactive.push('discovered-instructions', 'skills', 'hooks', 'plugins', 'mcp', 'provider-memory');
      active.push('authentication', 'model-selection', 'built-in-tools', 'permissions');
    }

    if (policy.memory === 'read-only') unsupported.push('memory.read-only');
    if (policy.memory === 'off' && policy.profile !== 'clean') {
      unsupported.push('memory.off-without-clean-profile');
    }
  } else {
    if (policy.profile === 'native') {
      active.push('user-config', 'project-config', 'AGENTS.md', 'rules', 'skills', 'hooks', 'plugins', 'mcp');
    } else if (policy.profile === 'project') {
      args.push('--ignore-user-config');
      inactive.push('user-config');
      active.push('project-config', 'AGENTS.md', 'rules');
      unsupported.push('context.project.global-instructions');
    } else {
      args.push('--ignore-user-config', '--ignore-rules');
      inactive.push('user-config', 'rules');
      unsupported.push('context.clean.project-instructions', 'context.clean.plugins-skills-hooks-mcp');
      unknown.push('AGENTS.md', 'plugins', 'skills', 'hooks', 'mcp');
    }

    if (policy.memory === 'off') {
      args.push('--disable', 'memories');
      inactive.push('provider-memory');
    } else if (policy.memory === 'read-only') {
      unsupported.push('memory.read-only');
    } else {
      unknown.push('provider-memory');
    }
  }

  if (unsupported.length > 0) {
    warnings.push(`Context policy is not fully enforceable by ${provider} exec`);
  }

  return {
    args,
    unsupported,
    warnings,
    report: {
      profile: policy.profile,
      memory: policy.memory,
      active: [...new Set(active)],
      inactive: [...new Set(inactive)],
      unavoidable,
      unknown: [...new Set(unknown)],
    },
  };
}
