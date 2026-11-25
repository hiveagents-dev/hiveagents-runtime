import { describe, expect, it } from 'vitest';

import { buildClaudeExecArgs, ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';

const base = {
  mode: 'open' as const,
  modelId: 'claude-opus-5',
  cwd: '/tmp/repo',
  prompt: 'hello',
  env: {},
  contextArgs: ['--safe-mode'],
  permissionArgs: ['--permission-mode', 'plan'],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
};

describe('Claude exec argv', () => {
  it('can replace the coding persona for a non-coding business responder', () => {
    const args = buildClaudeExecArgs({ ...base, instructions: 'Deliver the finished analysis.',
      providerOptions: { systemPromptMode: 'replace', tools: [] },
      permissionArgs: ['--permission-mode', 'dontAsk', '--strict-mcp-config'],
    }, 'id');
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('plan');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowed-tools');
    expect(() => buildClaudeExecArgs({ ...base, providerOptions: { systemPromptMode: 'bogus' } }, 'id')).toThrow();
  });

  it('preapproves only public search for the research responder, without enabling coding tools', () => {
    const args = buildClaudeExecArgs({ ...base, providerOptions: { tools: ['WebSearch'], systemPromptMode: 'replace' },
      permissionArgs: ['--permission-mode', 'dontAsk'] }, 'id');
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('WebSearch');
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
  it('opens a native session with an SDK-generated id', () => {
    expect(buildClaudeExecArgs(base, 'new-id')).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', 'claude-opus-5',
      '--session-id', 'new-id',
      '--safe-mode',
      '--permission-mode', 'plan',
    ]);
  });

  it('resumes the provider transcript instead of replaying messages', () => {
    expect(buildClaudeExecArgs({ ...base, mode: 'resume', sessionId: 'old-id' }, 'unused'))
      .toEqual(expect.arrayContaining(['--resume', 'old-id']));
  });

  it('uses the native fork flag and requires the source session', () => {
    const args = buildClaudeExecArgs({ ...base, mode: 'fork', sessionId: 'old-id' }, 'unused');
    expect(args).toEqual(expect.arrayContaining(['--resume', 'old-id', '--fork-session']));
    expect(() => buildClaudeExecArgs({ ...base, mode: 'fork' }, 'unused')).toThrow();
  });

  it('passes instructions and schemas as argv values without shell interpolation', () => {
    const args = buildClaudeExecArgs({
      ...base,
      instructions: 'Use x > y & explain',
      effort: 'high',
      outputSchema: { type: 'object' },
    }, 'id');
    expect(args).toEqual(expect.arrayContaining([
      '--append-system-prompt', 'Use x > y & explain',
      '--effort', 'high',
      '--json-schema', '{"type":"object"}',
    ]));
  });

  it('preserves an explicit empty built-in tool list and isolates MCP from other configuration', () => {
    const args = buildClaudeExecArgs({ ...base, providerOptions: {
      tools: [], strictMcpConfig: true, mcpConfigs: ['{"mcpServers":{}}'],
    } }, 'id');
    expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(args).not.toContain('default');
    // Omitting the option preserves the existing provider-default behavior.
    expect(buildClaudeExecArgs(base, 'id')).not.toContain('--tools');
  });

  it('forwards explicit tools, settings and all MCP configs as separate literal argv', () => {
    const args = buildClaudeExecArgs({ ...base, providerOptions: {
      tools: ['Read', 'Grep'], strictMcpConfig: false,
      settings: { env: { LITERAL: '$(uname) & `id`' } }, mcpConfigs: ['/tmp/config one.json', '/tmp/config-two.json'],
    } }, 'id');
    expect(args).toContain('Read,Grep');
    expect(args).toContain('{"env":{"LITERAL":"$(uname) & `id`"}}');
    const index = args.indexOf('--mcp-config');
    expect(args.slice(index + 1, index + 3)).toEqual(['/tmp/config one.json', '/tmp/config-two.json']);
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('refuses malformed options and flag-shaped MCP/config values', () => {
    for (const providerOptions of [{ tools: '' }, { tools: ['--dangerously-skip-permissions'] },
      { strictMcpConfig: 'true' }, { mcpConfigs: ['--settings'] }, { mcpConfigs: [null] },
      { settings: [] }, { settings: '\0bad' }]) {
      expect(() => buildClaudeExecArgs({ ...base, providerOptions }, 'id')).toThrow(TypeError);
    }
  });

  it('the adapter runner receives the no-tools boundary, not just a prompt requesting it', async () => {
    let seen: string[] = [];
    const adapter = new ClaudeExecAdapter({ target: { command: '/safe/claude', argsPrefix: [] },
      runner: async (request) => {
        seen = request.args;
        return { code: 0, signal: null, stdout: '', stderr: '', durationMs: 1 };
      } });
    await adapter.execute({ ...base, providerOptions: { tools: [], strictMcpConfig: true, mcpConfigs: ['{"mcpServers":{}}'] } });
    expect(seen[seen.indexOf('--tools') + 1]).toBe('');
    expect(seen).toContain('--safe-mode');
    expect(seen).toContain('--strict-mcp-config');
  });
});
