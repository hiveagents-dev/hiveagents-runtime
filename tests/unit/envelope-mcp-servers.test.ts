import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { APPLICATION_TOOL_SERVER } from '../../src/adapters/claude-control/tools.js';
import { buildCodexExecArgs } from '../../src/adapters/codex/exec-adapter.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { CONTROL_TRANSPORTS, type ControlAdapterRegistration } from '../../src/core/registry.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import type { AgentOptions } from '../../src/public/types.js';
import {
  CLAUDE_APPLICATION_TOOL_SERVER, CLAUDE_SETTINGS_MCP_MARKER, CODEX_USER_CONFIG_MARKER, INLINE_MCP_CONFIG_MARKER,
  envelopeMcpServers, mcpServersFromClaudeConfigs, mcpServersFromCodexConfig,
} from '../../src/session/mcp-envelope.js';
import { buildSafetyEnvelope } from '../../src/session/negotiation.js';

function execAdapter(id: 'claude' | 'codex'): ExecAdapter {
  return {
    id,
    detect: vi.fn(async () => ({ installed: true })),
    auth: vi.fn(async () => ({ authenticated: true, source: 'subscription' as const })),
    models: async () => [],
    execute: vi.fn(async () => ({ completed: true, failed: false, refused: false, text: 'ok', events: [], nativeEvents: [] })),
  };
}

function controlRegistration(provider: 'claude' | 'codex'): ControlAdapterRegistration {
  return {
    token: CONTROL_TRANSPORTS[provider].token, provider, packageName: CONTROL_TRANSPORTS[provider].packageName,
    adapterVersion: '0.1.0', evidenceSource: 'sdk-capability', capabilityVerdicts: { messageDeltas: 'full', inProcessTools: 'partial' },
    createSession: async () => { throw new Error('not opened by readiness'); },
  };
}

async function envelopeFor(options: AgentOptions) {
  const runtime = new Runtime({ adapters: [execAdapter('claude'), execAdapter('codex')],
    controlAdapters: [controlRegistration('claude'), controlRegistration('codex')] });
  const agent = new Agent(options, runtime);
  try {
    return (await agent.ready()).plan.envelope;
  } finally {
    await agent.close();
  }
}

describe('mcpServersFromClaudeConfigs', () => {
  it('lists inline server names, marks paths by absolute location and drops duplicates', () => {
    expect(mcpServersFromClaudeConfigs([
      '{"mcpServers":{"agentdb":{"command":"npx"},"ruvector":{"command":"npx"}}}',
      'servers.json',
      '/etc/mcp/shared.json',
      '  {"mcpServers":{"agentdb":{}}}',
      'servers.json',
    ], '/work/repo')).toEqual(['agentdb', 'ruvector', 'config:/work/repo/servers.json', 'config:/etc/mcp/shared.json']);
  });

  it('keeps an empty server map empty and keeps unparsable inline text visible', () => {
    expect(mcpServersFromClaudeConfigs(['{"mcpServers":{}}'], '/w')).toEqual([]);
    for (const config of ['{not json', '{"servers":{}}', '{"mcpServers":[]}', '{"mcpServers":null}']) {
      expect(mcpServersFromClaudeConfigs([config], '/w')).toEqual([INLINE_MCP_CONFIG_MARKER]);
    }
  });

  it('reports nothing for absent or malformed option values, which the exec adapter refuses later', () => {
    for (const configs of [undefined, null, 'servers.json', {}, [], [42, null, '', '   ']]) {
      expect(mcpServersFromClaudeConfigs(configs, '/w')).toEqual([]);
    }
  });
});

describe('buildSafetyEnvelope mcpServers', () => {
  const base = { cwd: '/tmp', permissions: { mode: 'analyze' as const }, environmentVariables: [],
    executableRealpath: '/bin/claude', modelId: 'opus', enforcedBy: ['harness' as const] };

  it('defaults to none and copies what it is given', () => {
    expect(buildSafetyEnvelope(base).mcpServers).toEqual([]);
    const servers = ['agentdb'];
    const envelope = buildSafetyEnvelope({ ...base, mcpServers: servers });
    expect(envelope.mcpServers).toEqual(['agentdb']);
    servers.push('late');
    expect(envelope.mcpServers).toEqual(['agentdb']);
  });
});

describe('mcpServersFromCodexConfig', () => {
  it('lists mcp_servers tables and dotted mcp_servers.<name> keys once each', () => {
    expect(mcpServersFromCodexConfig({
      model_verbosity: 'low',
      mcp_servers: { agentdb: { command: 'npx' }, ruvector: {} },
      'mcp_servers.agentdb.env': { AGENTDB_PATH: '/a.db' },
      'mcp_servers.notes': { command: '/bin/notes' },
      'mcp_servers.search.args': ['x'],
      mcp_servers_file: '/x.toml',
    })).toEqual(['agentdb', 'ruvector', 'notes', 'search']);
  });

  it('marks an mcp_servers value that is not a table and ignores absent or malformed configs', () => {
    for (const value of ['x', 1, [], null]) expect(mcpServersFromCodexConfig({ mcp_servers: value })).toEqual([INLINE_MCP_CONFIG_MARKER]);
    for (const config of [undefined, null, 'mcp_servers', [], { mcp_servers: {} }]) expect(mcpServersFromCodexConfig(config)).toEqual([]);
  });
});

describe('readiness envelope reflects MCP servers', () => {
  const inline = '{"mcpServers":{"agentdb":{"command":"npx","args":["-y","agentdb@3.10.1","mcp","start"],"env":{}}}}';

  it('lists Claude exec mcpConfigs servers', async () => {
    const cwd = await realpath(tmpdir());
    const envelope = await envelopeFor({ model: 'opus-5', transport: 'exec', cwd,
      providerOptions: { claude: { strictMcpConfig: true, mcpConfigs: [inline, 'more.json'] } } });
    expect(envelope.mcpServers).toEqual(['agentdb', `config:${join(cwd, 'more.json')}`]);
  });

  // Intended change: without --strict-mcp-config or --safe-mode the CLI also loads its own MCP settings.
  it('marks Claude exec settings servers unless strictMcpConfig or the clean profile excludes them', async () => {
    expect((await envelopeFor({ model: 'opus-5', transport: 'exec' })).mcpServers).toEqual([CLAUDE_SETTINGS_MCP_MARKER]);
    expect((await envelopeFor({ model: 'opus-5', transport: 'exec', context: { profile: 'project' } })).mcpServers)
      .toEqual([CLAUDE_SETTINGS_MCP_MARKER]);
    expect((await envelopeFor({ model: 'opus-5', transport: 'exec', providerOptions: { claude: { mcpConfigs: [inline] } } }))
      .mcpServers).toEqual(['agentdb', CLAUDE_SETTINGS_MCP_MARKER]);
    expect((await envelopeFor({ model: 'opus-5', transport: 'exec', providerOptions: { claude: { strictMcpConfig: true } } }))
      .mcpServers).toEqual([]);
    expect((await envelopeFor({ model: 'opus-5', transport: 'exec', context: { profile: 'clean' } })).mcpServers).toEqual([]);
    // `respond` emits --strict-mcp-config through its permission arguments.
    expect(envelopeMcpServers({ provider: 'claude', transport: 'exec', cwd: '/w', providerOptions: undefined,
      contextArgs: [], permissionArgs: ['--permission-mode', 'dontAsk', '--strict-mcp-config'], applicationTools: 0 })).toEqual([]);
  });

  // R2-9: the servers Codex exec receives through --config were delivered but not listed.
  it('lists Codex exec config servers that reach --config, and marks the user config.toml unless ignored', async () => {
    const config = { mcp_servers: { agentdb: { command: 'npx', args: ['-y', 'agentdb@3.10.1', 'mcp', 'start'] } },
      'mcp_servers.notes.command': '/bin/notes' };
    const args = buildCodexExecArgs({ mode: 'open', modelId: 'gpt-5.4', cwd: '/w', prompt: 'x', env: {}, contextArgs: [],
      permissionArgs: [], timeoutMs: 1000, maxOutputBytes: 1024, providerOptions: { config } }, undefined);
    expect(args.filter((arg) => arg.startsWith('mcp_servers'))).toHaveLength(2);
    expect((await envelopeFor({ model: 'codex/gpt-5.4', transport: 'exec', providerOptions: { codex: { config } } })).mcpServers)
      .toEqual(['agentdb', 'notes', CODEX_USER_CONFIG_MARKER]);
    expect((await envelopeFor({ model: 'codex/gpt-5.4', transport: 'exec',
      providerOptions: { codex: { config, ignoreUserConfig: true } } })).mcpServers).toEqual(['agentdb', 'notes']);
  });

  it('marks only the Codex user config for an agent that injects nothing, and drops it when the profile ignores it', async () => {
    expect((await envelopeFor({ model: 'codex/gpt-5.4', transport: 'exec' })).mcpServers).toEqual([CODEX_USER_CONFIG_MARKER]);
    expect((await envelopeFor({ model: 'codex/gpt-5.4', transport: 'exec',
      providerOptions: { claude: { mcpConfigs: [inline] } } })).mcpServers).toEqual([CODEX_USER_CONFIG_MARKER]);
    expect((await envelopeFor({ model: 'codex/gpt-5.4', transport: 'exec', context: { profile: 'project' },
      permissions: { mode: 'analyze', strict: false } })).mcpServers).toEqual([]);
    expect((await envelopeFor({ model: 'codex/gpt-5.4', transport: 'exec',
      providerOptions: { codex: { ignoreUserConfig: true } } })).mcpServers).toEqual([]);
  });

  // R3-6: Claude control registers its in-process server for application tools.
  it('lists the Claude control application tool server only when the agent has tools', async () => {
    expect(CLAUDE_APPLICATION_TOOL_SERVER).toBe(APPLICATION_TOOL_SERVER);
    const tool = { name: 'read_note', description: 'read', inputSchema: { type: 'object' as const }, timeoutMs: 100,
      maxOutputBytes: 100, authorize: () => true, execute: () => null };
    const control = { experimentalControl: true, experimentalApi: true };
    const withTools = await envelopeFor({ model: 'opus-5', transport: 'control', providerOptions: control, tools: [tool] });
    expect(withTools.mcpServers).toEqual([APPLICATION_TOOL_SERVER]);
    expect(withTools.tools).toEqual(['read_note']);
    expect((await envelopeFor({ model: 'opus-5', transport: 'control', providerOptions: control })).mcpServers).toEqual([]);
  });

  it('lists no MCP server for Codex control dynamic tools, only the user config it always loads', async () => {
    const tool = { name: 'read_note', description: 'read', inputSchema: { type: 'object' as const }, timeoutMs: 100,
      maxOutputBytes: 100, authorize: () => true, execute: () => null };
    const envelope = await envelopeFor({ model: 'codex/gpt-5.4', transport: 'control',
      providerOptions: { experimentalControl: true, experimentalApi: true }, tools: [tool] });
    expect(envelope.mcpServers).toEqual([CODEX_USER_CONFIG_MARKER]);
    expect(envelope.tools).toEqual(['read_note']);
  });
});
