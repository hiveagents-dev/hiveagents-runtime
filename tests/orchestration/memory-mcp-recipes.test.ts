import { describe, expect, it } from 'vitest';

import { buildClaudeExecArgs } from '../../src/adapters/claude/exec-adapter.js';
import {
  agentDbMcpServer,
  claudeMcpConfig,
  ruvectorMcpServer,
  type McpServerRecipe,
} from '../../src/orchestration/memory/mcp-recipes.js';

const request = {
  mode: 'open' as const, modelId: 'claude-opus-5', cwd: '/tmp/repo', prompt: 'hello', env: {},
  contextArgs: [], permissionArgs: ['--permission-mode', 'plan'], timeoutMs: 1_000, maxOutputBytes: 1_000,
};

describe('AgentDB MCP recipe', () => {
  it('pins the version and sets the database and an explicit profile', () => {
    expect(agentDbMcpServer({ version: '3.10.1', databasePath: '/var/agents/a1/agentdb.db', profile: 'readonly' })).toEqual({
      name: 'agentdb',
      command: 'npx',
      args: ['-y', 'agentdb@3.10.1', 'mcp', 'start'],
      env: { AGENTDB_PATH: '/var/agents/a1/agentdb.db', AGENTDB_MCP_PROFILE: 'readonly' },
    });
    for (const profile of ['retrieval', 'learning'] as const) {
      expect(agentDbMcpServer({ version: '3.10.1', databasePath: '/d.db', profile, name: 'memory_a1' }))
        .toMatchObject({ name: 'memory_a1', env: { AGENTDB_MCP_PROFILE: profile } });
    }
  });

  it('accepts Windows and UNC absolute paths and exact prereleases', () => {
    for (const databasePath of ['C:\\agents\\a1.db', 'D:/agents/a1.db', '\\\\host\\share\\a1.db']) {
      expect(agentDbMcpServer({ version: '3.0.0-alpha.20', databasePath, profile: 'readonly' }).env.AGENTDB_PATH).toBe(databasePath);
    }
  });

  it.each(['latest', 'alpha', '^3.10.1', '~3.10.1', '3.10', '3', '3.x', '>=3.0.0', '3.10.1 || 3.10.0', 'v3.10.1',
    ' 3.10.1', '03.10.1', '3.10.1+build', '3.10.1-01', '', 3101])('refuses the version %j', (version) => {
    expect(() => agentDbMcpServer({ version, databasePath: '/d.db', profile: 'readonly' } as never)).toThrow(/exact semver/);
  });

  it.each(['agentdb.db', './agentdb.db', '../a.db', '~/a.db', 'C:a.db', '', ' /a.db', '/a\0.db', 42])(
    'refuses the database path %j', (databasePath) => {
      expect(() => agentDbMcpServer({ version: '3.10.1', databasePath, profile: 'readonly' } as never)).toThrow(/absolute path/);
    });

  it('refuses unknown and destructive profiles, bad names and unknown options', () => {
    for (const profile of ['admin', 'READONLY', undefined, '']) {
      expect(() => agentDbMcpServer({ version: '3.10.1', databasePath: '/d.db', profile } as never)).toThrow(/profile/);
    }
    for (const name of ['', 'has space', 'a.b', 'x'.repeat(65), 7]) {
      expect(() => agentDbMcpServer({ version: '3.10.1', databasePath: '/d.db', profile: 'readonly', name } as never))
        .toThrow(/server name/);
    }
    expect(() => agentDbMcpServer({ version: '3.10.1', databasePath: '/d.db', profile: 'readonly', env: {} } as never))
      .toThrow(/do not accept: env/);
    expect(() => agentDbMcpServer(null as never)).toThrow(TypeError);
  });
});

describe('RuVector MCP recipe', () => {
  it('pins the version and uses the read-only profile', () => {
    expect(ruvectorMcpServer({ version: '0.3.27', profile: 'readonly' })).toEqual({
      name: 'ruvector',
      command: 'npx',
      args: ['-y', 'ruvector@0.3.27', 'mcp', 'start'],
      env: { RUVECTOR_MCP_PROFILE: 'readonly' },
    });
  });

  it('sets no policy only when asked for the unrestricted surface and its shared store is acknowledged', () => {
    expect(ruvectorMcpServer({ version: '0.3.27', profile: 'unrestricted', name: 'vectors', sharedStoreAcknowledged: true }))
      .toEqual({ name: 'vectors', command: 'npx', args: ['-y', 'ruvector@0.3.27', 'mcp', 'start'], env: {} });
  });

  // R2-11: the server stores in <cwd or ~>/.ruvector, so agents sharing a directory share one store.
  it('refuses unrestricted without the shared-store acknowledgement', () => {
    for (const sharedStoreAcknowledged of [undefined, false]) {
      expect(() => ruvectorMcpServer({ version: '0.3.27', profile: 'unrestricted', sharedStoreAcknowledged } as never))
        .toThrow(/shared per working directory or home.*sharedStoreAcknowledged: true/);
    }
    expect(() => ruvectorMcpServer({ version: '0.3.27', profile: 'unrestricted', sharedStoreAcknowledged: 'yes' } as never))
      .toThrow(/true or false/);
    expect(ruvectorMcpServer({ version: '0.3.27', profile: 'readonly', sharedStoreAcknowledged: false }).env)
      .toEqual({ RUVECTOR_MCP_PROFILE: 'readonly' });
  });

  it('refuses ranges, latest, unknown profiles and the unverified storage option', () => {
    for (const version of ['latest', '^0.3.27', '0.3', '*']) {
      expect(() => ruvectorMcpServer({ version, profile: 'readonly' })).toThrow(/exact semver/);
    }
    expect(() => ruvectorMcpServer({ version: '0.3.27', profile: 'admin' } as never)).toThrow(/profile/);
    expect(() => ruvectorMcpServer({ version: '0.3.27', profile: 'readonly', storagePath: '/s' } as never))
      .toThrow(/do not accept: storagePath/);
  });
});

// R2-3: npx pins only the top-level package; a lockfile-installed binary pins the whole tree.
describe('pre-installed executable launch form', () => {
  const bin = '/opt/oar/node_modules/.bin';

  it('runs the absolute binary with the server arguments and no npx', () => {
    expect(agentDbMcpServer({ executable: `${bin}/agentdb`, databasePath: '/var/a1.db', profile: 'readonly' })).toEqual({
      name: 'agentdb', command: `${bin}/agentdb`, args: ['mcp', 'start'],
      env: { AGENTDB_PATH: '/var/a1.db', AGENTDB_MCP_PROFILE: 'readonly' },
    });
    expect(ruvectorMcpServer({ executable: 'C:\\oar\\node_modules\\.bin\\ruvector.cmd', profile: 'readonly' }))
      .toEqual({ name: 'ruvector', command: 'C:\\oar\\node_modules\\.bin\\ruvector.cmd', args: ['mcp', 'start'],
        env: { RUVECTOR_MCP_PROFILE: 'readonly' } });
  });

  it('needs exactly one of version and executable, and an absolute executable', () => {
    expect(() => agentDbMcpServer({ version: '3.10.1', executable: `${bin}/agentdb`, databasePath: '/d.db', profile: 'readonly' } as never))
      .toThrow(/exactly one of version/);
    expect(() => ruvectorMcpServer({ profile: 'readonly' } as never)).toThrow(/exactly one of version/);
    for (const executable of ['agentdb', 'node_modules/.bin/agentdb', './agentdb', '', ' /a', 7]) {
      expect(() => agentDbMcpServer({ executable, databasePath: '/d.db', profile: 'readonly' } as never))
        .toThrow(/executable must be an absolute path/);
    }
  });

  it('is accepted by claudeMcpConfig, which still refuses relative commands', () => {
    const recipe = agentDbMcpServer({ executable: `${bin}/agentdb`, databasePath: '/var/a1.db', profile: 'learning' });
    expect(JSON.parse(claudeMcpConfig([recipe])).mcpServers.agentdb)
      .toEqual({ command: `${bin}/agentdb`, args: ['mcp', 'start'], env: { AGENTDB_PATH: '/var/a1.db', AGENTDB_MCP_PROFILE: 'learning' } });
    for (const command of ['agentdb', './bin/agentdb', 'npx ', '']) {
      expect(() => claudeMcpConfig([{ name: 'x', command, args: [], env: {} }])).toThrow(/malformed/);
    }
  });
});

describe('recipes are frozen', () => {
  it('cannot be altered after construction', () => {
    const recipe = agentDbMcpServer({ version: '3.10.1', databasePath: '/d.db', profile: 'readonly' });
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(Object.isFrozen(recipe.args)).toBe(true);
    expect(Object.isFrozen(recipe.env)).toBe(true);
    expect(() => { (recipe.args as string[]).push('--evil'); }).toThrow(TypeError);
    expect(() => { (recipe.env as Record<string, string>).AGENTDB_MCP_PROFILE = 'admin'; }).toThrow(TypeError);
    expect(Object.isFrozen(ruvectorMcpServer({ version: '0.3.27', profile: 'unrestricted', sharedStoreAcknowledged: true }).env))
      .toBe(true);
  });
});

describe('claudeMcpConfig', () => {
  const agentdb = agentDbMcpServer({ version: '3.10.1', databasePath: '/var/a1.db', profile: 'readonly' });
  const ruvector = ruvectorMcpServer({ version: '0.3.27', profile: 'readonly' });

  it('produces the mcpServers JSON shape and round-trips it', () => {
    const config = claudeMcpConfig([agentdb, ruvector]);
    expect(JSON.parse(config)).toEqual({ mcpServers: {
      agentdb: { command: 'npx', args: ['-y', 'agentdb@3.10.1', 'mcp', 'start'],
        env: { AGENTDB_PATH: '/var/a1.db', AGENTDB_MCP_PROFILE: 'readonly' } },
      ruvector: { command: 'npx', args: ['-y', 'ruvector@0.3.27', 'mcp', 'start'], env: { RUVECTOR_MCP_PROFILE: 'readonly' } },
    } });
    expect(Object.keys(JSON.parse(config).mcpServers.agentdb)).toEqual(['command', 'args', 'env']);
  });

  it('is accepted by the Claude exec adapter as one literal --mcp-config argument', () => {
    const config = claudeMcpConfig([agentdb]);
    const args = buildClaudeExecArgs({ ...request, providerOptions: { strictMcpConfig: true, mcpConfigs: [config] } }, 'id');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(config);
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.agentdb.args).toEqual(agentdb.args);
  });

  it('refuses duplicate names, empty input and malformed recipes', () => {
    const second = agentDbMcpServer({ version: '3.10.1', databasePath: '/var/a2.db', profile: 'learning' });
    expect(() => claudeMcpConfig([agentdb, second])).toThrow(/Duplicate MCP server name: agentdb/);
    expect(() => claudeMcpConfig([])).toThrow(/at least one/);
    for (const recipe of [null, { name: 'x', command: 'sh', args: [], env: {} },
      { name: 'x', command: 'npx', args: [1], env: {} }, { name: 'x', command: 'npx', args: [], env: { A: 1 } },
      { name: 'x', command: 'npx', args: [], env: [] }, { name: '../x', command: 'npx', args: [], env: {} }]) {
      expect(() => claudeMcpConfig([recipe as unknown as McpServerRecipe])).toThrow(TypeError);
    }
  });
});
