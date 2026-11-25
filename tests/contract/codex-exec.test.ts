import { access, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexExecAdapter, UnsupportedCapabilityError } from '../../src/index.js';
import { buildCodexExecArgs } from '../../src/adapters/codex/exec-adapter.js';

/** Decodes the escapes a TOML basic string may hold; anything else is not a string this adapter emits. */
function decodeTomlBasic(literal: string): string {
  const named: Record<string, string> = { '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };
  return literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escape: string) => {
    if (escape[0] === 'u' || escape[0] === 'U') return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if (!(escape in named)) throw new Error(`Not a TOML escape: \\${escape}`);
    return named[escape]!;
  });
}

const base = {
  mode: 'open' as const,
  modelId: 'gpt-5.6-sol',
  cwd: '/tmp/repo',
  prompt: 'hello',
  env: {},
  contextArgs: [],
  permissionArgs: ['--sandbox', 'read-only'],
  timeoutMs: 1_000,
  maxOutputBytes: 1_000,
};

describe('Codex exec argv', () => {
  it('opens a session with prompt stdin marker last', () => {
    expect(buildCodexExecArgs(base, undefined)).toEqual([
      '--model', 'gpt-5.6-sol',
      '--cd', '/tmp/repo',
      '--sandbox', 'read-only',
      'exec',
      '--json',
      '-',
    ]);
  });

  it('uses explicit resume and fork subcommands with stable argv ordering', () => {
    const resume = buildCodexExecArgs({ ...base, mode: 'resume', sessionId: 'old-id' }, undefined);
    expect(resume).toEqual(expect.arrayContaining(['--sandbox', 'read-only', 'exec', 'resume', '--json']));
    expect(resume.indexOf('--sandbox')).toBeLessThan(resume.indexOf('exec'));
    expect(resume).not.toContain('--color');
    expect(resume.slice(-2))
      .toEqual(['old-id', '-']);

    expect(buildCodexExecArgs({ ...base, mode: 'fork', sessionId: 'old-id' }, undefined))
      .toEqual(expect.arrayContaining(['exec', 'fork', '--json']));
  });

  it('uses a secure schema file path and reasoning config', () => {
    expect(buildCodexExecArgs({ ...base, effort: 'xhigh' }, '/tmp/schema path.json'))
      .toEqual(expect.arrayContaining([
        '--output-schema', '/tmp/schema path.json',
        '--config', 'model_reasoning_effort="xhigh"',
      ]));
  });

  it('forwards provider config as TOML on open, resume and fork without shell evaluation', () => {
    const config = {
      'features.shell_tool': false,
      tools: { web_search: { search_context_size: 'low' } },
      shell_environment_policy: { include_only: ['PATH', 'HOME'], set: { LITERAL: '$(uname) `id`\n¿ñ?' } },
      model_context_window: 12345,
    };
    for (const mode of ['open', 'resume', 'fork'] as const) {
      const args = buildCodexExecArgs({ ...base, mode, ...(mode !== 'open' ? { sessionId: 'old' } : {}),
        providerOptions: { config, skipGitRepoCheck: true } }, undefined);
      expect(args).toContain('features.shell_tool=false');
      expect(args).toContain('tools={ "web_search" = { "search_context_size" = "low" } }');
      expect(args).toContain('shell_environment_policy={ "include_only" = ["PATH", "HOME"], "set" = { "LITERAL" = "$(uname) `id`\\n¿ñ?" } }');
      expect(args).toContain('model_context_window=12345');
      expect(args.indexOf('--config')).toBeLessThan(args.indexOf('exec'));
      expect(args).toContain('--skip-git-repo-check');
      expect(args.at(-1)).toBe('-');
    }
  });

  it('rejects unsupported config values and malformed keys instead of silently dropping them', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const config of [null, [], { key: undefined }, { key: null }, { key: NaN }, { key: Infinity },
      { key: 9007199254740992 }, { key: () => false }, { key: new Date() }, { key: cycle },
      { key: '\ud800' }, { 'tools=0\nother': true }, { key: 'x'.repeat(65537) }, { key: [, true] }]) {
      expect(() => buildCodexExecArgs({ ...base, providerOptions: { config } }, undefined)).toThrow(TypeError);
    }
  });

  it('passes the generated config argv into the actual adapter runner', async () => {
    let seen: string[] = [];
    const adapter = new CodexExecAdapter({ target: { command: '/safe/codex', argsPrefix: [] },
      runner: async (request) => {
        seen = request.args;
        return { code: 0, signal: null, stdout: '{"type":"turn.completed"}', stderr: '', durationMs: 1 };
      } });
    await adapter.execute({ ...base, providerOptions: { config: { 'features.shell_tool': false } } });
    expect(seen).toContain('features.shell_tool=false');
  });

  it.skipIf(process.env.OAR_CODEX_CONFIG_SMOKE !== '1')('installed strict parser accepts generated TOML and rejects the unverified no-tools key without inference', () => {
    // Config resolves this nonexistent provider before creating an inference client.
    // Thus even valid TOML cannot initiate a model turn or spend.
    const probe = (config: Record<string, unknown>) => spawnSync('codex', buildCodexExecArgs({
      ...base, cwd: process.cwd(),
      contextArgs: ['--strict-config', '--ignore-user-config', '--ignore-rules'],
      providerOptions: { skipGitRepoCheck: true, config: { model_provider: 'r2_no_provider_config_probe', ...config } },
    }, undefined), { input: 'configuration validation only', encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
    const accepted = probe({ tools: { web_search: { search_context_size: 'low' } } });
    expect(accepted.status).toBe(1);
    expect(accepted.stderr).toContain('Model provider `r2_no_provider_config_probe` not found');
    const unsupported = probe({ 'tools.disable_defaults': true });
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('unknown configuration field `tools.disable_defaults`');
    expect(accepted.stdout).toBe('');
    expect(unsupported.stdout).toBe('');
  });

  it('closes the owner setup and session files on request, on open, resume and fork, once per flag', () => {
    const closed = { ignoreUserConfig: true, ignoreRules: true, ephemeral: true };
    for (const mode of ['open', 'resume', 'fork'] as const) {
      const args = buildCodexExecArgs({ ...base, mode, ...(mode !== 'open' ? { sessionId: 'old' } : {}), providerOptions: closed }, undefined);
      const exec = args.indexOf('exec');
      for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral']) {
        expect(args.filter((arg) => arg === flag)).toHaveLength(1);
        expect(args.indexOf(flag)).toBeGreaterThan(exec);
      }
      expect(args.at(-1)).toBe('-');
    }
    // A clean context already emits two of them: they are not repeated (the CLI refuses a repeated flag).
    const clean = buildCodexExecArgs({ ...base, contextArgs: ['--ignore-user-config', '--ignore-rules'], providerOptions: closed }, undefined);
    expect(clean.filter((arg) => arg.startsWith('--ignore') || arg === '--ephemeral')).toEqual(['--ignore-user-config', '--ignore-rules', '--ephemeral']);
    expect(buildCodexExecArgs({ ...base, providerOptions: { ignoreUserConfig: false } }, undefined)).not.toContain('--ignore-user-config');
    expect(() => buildCodexExecArgs({ ...base, providerOptions: { ephemeral: 'yes' } }, undefined)).toThrow(TypeError);
  });

  it('sends instructions in the developer role through developer_instructions, never in the prompt', () => {
    const args = buildCodexExecArgs({ ...base, instructions: 'Sos Recepción.' }, undefined);
    const entry = args[args.indexOf('--config') + 1]!;
    expect(entry).toBe('developer_instructions="Sos Recepci\\u00f3n."');
    expect(args.indexOf(entry)).toBeLessThan(args.indexOf('exec'));
    expect(args.at(-1)).toBe('-');
    expect(args.join('\n')).not.toContain('Sos Recepción.');
  });

  it('keeps hostile instruction text inside one TOML basic string', () => {
    const hostile = [
      'plain', 'a "quoted" word', 'line\nbreak\r\nand\ttab', '"]\nmodel_provider = "x"', 'back\\slash \\" \\\\"',
      'nul \u0000 bell \u0007 esc \u001b del \u007f c1 \u0085', 'ls \u2028 ps \u2029 bom \ufeff', 'astral 🙂 𝄞 \u{10ffff}',
      "'''\"\"\"${x}$(id)`id`", '\\u0041 \\U00000041 \\x41',
    ];
    for (const text of hostile) {
      const args = buildCodexExecArgs({ ...base, instructions: text }, undefined);
      const entries = args.filter((arg) => arg.startsWith('developer_instructions='));
      expect(entries).toHaveLength(1);
      const literal = entries[0]!.slice('developer_instructions='.length);
      // Printable ASCII only, one string: every quote inside is escaped and the value is exactly that string.
      expect(literal).toMatch(/^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\btnfr]|\\u[0-9a-f]{4}|\\U[0-9a-f]{8})*"$/);
      expect(decodeTomlBasic(literal)).toBe(text);
    }
  });

  it('refuses instructions it cannot deliver as given instead of dropping or prefixing them', () => {
    for (const mode of ['resume', 'fork'] as const) {
      // A resumed session replays the developer instructions it started with and does not send new ones.
      expect(() => buildCodexExecArgs({ ...base, mode, sessionId: 'old-id', instructions: 'x' }, undefined)).toThrow(UnsupportedCapabilityError);
    }
    expect(() => buildCodexExecArgs({ ...base, instructions: 'x', providerOptions: { config: { developer_instructions: 'y' } } }, undefined)).toThrow(TypeError);
    expect(() => buildCodexExecArgs({ ...base, instructions: 'lone \ud800' }, undefined)).toThrow(TypeError);
    expect(() => buildCodexExecArgs({ ...base, instructions: 'x'.repeat(65_536) }, undefined)).toThrow(TypeError);
    expect(buildCodexExecArgs({ ...base, instructions: '' }, undefined)).not.toContain('--config');
  });

  it('creates owner-only schema artifacts and removes them after execution', async () => {
    let schemaPath: string | undefined;
    let fileMode: number | undefined;
    let directoryMode: number | undefined;
    const adapter = new CodexExecAdapter({
      target: { command: '/safe/codex', argsPrefix: [] },
      runner: async (request) => {
        const index = request.args.indexOf('--output-schema');
        schemaPath = request.args[index + 1];
        fileMode = (await stat(schemaPath as string)).mode & 0o777;
        directoryMode = (await stat(dirname(schemaPath as string))).mode & 0o777;
        return {
          code: 0,
          signal: null,
          stdout: [
            '{"type":"thread.started","thread_id":"secure-schema"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
            '{"type":"turn.completed"}',
          ].join('\n'),
          stderr: '',
          durationMs: 1,
        };
      },
    });

    await adapter.execute({ ...base, outputSchema: { type: 'object' } });

    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    await expect(access(schemaPath as string)).rejects.toThrow();
  });

  it('parses the schema-constrained final message as structured output', async () => {
    let providerSchema: unknown;
    const adapter = new CodexExecAdapter({
      target: { command: '/safe/codex', argsPrefix: [] },
      runner: async (request) => {
        const schemaIndex = request.args.indexOf('--output-schema');
        providerSchema = JSON.parse(await readFile(request.args[schemaIndex + 1] as string, 'utf8'));
        return {
          code: 0,
          signal: null,
          stdout: [
            '{"type":"thread.started","thread_id":"structured"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}',
            '{"type":"turn.completed"}',
          ].join('\n'),
          stderr: '',
          durationMs: 1,
        };
      },
    });

    await expect(adapter.execute({ ...base, outputSchema: {
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
    } })).resolves.toMatchObject({ output: { ok: true } });
    expect(providerSchema).toMatchObject({
      properties: { ok: { type: 'boolean', const: true } },
    });
  });

  it('classifies a non-JSON trusted-directory rejection from stderr', async () => {
    const adapter = new CodexExecAdapter({
      target: { command: '/safe/codex', argsPrefix: [] },
      runner: async () => ({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'Not inside a trusted directory and --skip-git-repo-check was not specified.',
        durationMs: 1,
      }),
    });

    await expect(adapter.execute(base)).resolves.toMatchObject({
      failed: true,
      failure: { kind: 'untrusted-workspace' },
    });
  });
});
