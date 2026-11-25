import { describe, expect, it } from 'vitest';
import { assertRespondPolicy, assertRespondCompatibility } from '../../src/core/respond-policy.js';
import { assessCliCompatibility } from '../../src/compatibility/manifest.js';
import { buildSafetyEnvelope } from '../../src/session/negotiation.js';
import type { AgentOptions } from '../../src/public/types.js';

const safe: AgentOptions = { model: 'claude/sonnet', transport: 'exec', instructions: 'Deliver the final answer. Never contact anyone.',
  context: { profile: 'clean', memory: 'off' }, permissions: { mode: 'respond', strict: false },
  providerOptions: { claude: { tools: [], systemPromptMode: 'replace' } } };

describe('non-coding response boundary', () => {
  it('requires the installed CLI to advertise all response controls, including dontAsk', () => {
    const help = '--system-prompt --safe-mode --tools --allowed-tools --strict-mcp-config --permission-mode dontAsk';
    expect(() => assertRespondCompatibility(safe, assessCliCompatibility('claude', '2.1.228', { main: help }))).not.toThrow();
    for (const flag of help.split(' ')) expect(() => assertRespondCompatibility(safe,
      assessCliCompatibility('claude', '2.1.228', { main: help.replace(flag, '') }))).toThrow();
    expect(() => assertRespondCompatibility(safe)).toThrow();
  });
  it('permits no tools or search, retaining no writable roots', () => {
    for (const tools of [[], ['WebSearch']]) expect(() => assertRespondPolicy({ ...safe,
      providerOptions: { claude: { ...safe.providerOptions!.claude, tools } } }, 'claude', 'exec')).not.toThrow();
    expect(buildSafetyEnvelope({ cwd: '/tmp', permissions: { mode: 'respond' }, environmentVariables: [],
      executableRealpath: '/bin/claude', modelId: 'sonnet', enforcedBy: ['harness'] }).filesystem.writableRoots).toEqual([]);
  });
  it('refuses expanded authority even with strict false', () => {
    for (const claude of [{ tools: ['Bash'] }, { tools: ['Read'] }, { tools: ['WebFetch'] }, { tools: undefined },
      { settings: {} }, { mcpConfigs: ['servers.json'] }, { strictMcpConfig: false }, { systemPromptMode: 'append' }]) {
      expect(() => assertRespondPolicy({ ...safe, providerOptions: { claude: { ...safe.providerOptions!.claude, ...claude } } } as AgentOptions,
        'claude', 'exec')).toThrow();
    }
    for (const changes of [{ context: { profile: 'project' } }, { instructions: '' },
      { permissions: { mode: 'respond', strict: false, additionalDirectories: ['/tmp'] } }]) {
      expect(() => assertRespondPolicy({ ...safe, ...changes } as AgentOptions, 'claude', 'exec')).toThrow();
    }
    expect(() => assertRespondPolicy(safe, 'codex', 'exec')).toThrow();
    expect(() => assertRespondPolicy(safe, 'claude', 'control')).toThrow();
  });
});
