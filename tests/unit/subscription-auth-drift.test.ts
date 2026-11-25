import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { buildCodexExecArgs } from '../../src/adapters/codex/exec-adapter.js';
import { codexControlConfiguration } from '../../src/adapters/codex-control/configuration.js';
import { createCodexProvider } from '../../src/core/builtin-providers.js';
import { SubscriptionExecAdapter } from '../../src/core/subscription-exec.js';
import type { ExecAdapter, ExecTurnRequest, ProcessRunner, ProtocolResult } from '../../src/adapters/provider.js';
import type { AuthStatus, ProviderId, TurnOptions } from '../../src/public/types.js';

const HELP = '--print --output-format --model --session-id --verbose --resume --fork-session --json-schema --include-partial-messages --safe-mode --permission-mode --system-prompt --tools --allowed-tools --strict-mcp-config dontAsk';
const success = (): ProtocolResult => ({ completed: true, failed: false, refused: false, sessionId: 'fixture-session', text: 'OK', events: [], nativeEvents: [] });
async function dispatch(session: Pick<Agent, 'send' | 'stream'>, stream: boolean, prompt: string, options?: TurnOptions): Promise<void> {
  if (!stream) { await session.send(prompt, options); return; }
  for await (const _event of session.stream(prompt, options)) { /* Consume the actual stream path. */ }
}
function fixture(provider: ProviderId, stream: boolean, requireAuth: 'subscription' | 'any' = 'subscription', mode: 'analyze' | 'unrestricted' = 'analyze') {
  let auth: AuthStatus = { authenticated: true, source: 'subscription' }, probes = 0;
  const calls: ExecTurnRequest[] = [], checked: NodeJS.ProcessEnv[] = [];
  let beforeAuth: (() => Promise<void>) | undefined;
  const adapter: ExecAdapter = {
    id: provider,
    detect: async () => ({ installed: true }), models: async () => [],
    auth: async env => { probes++; checked.push(env); await beforeAuth?.(); return auth; },
    execute: async request => { calls.push(request); return success(); },
    ...(stream ? { stream: async function* (request: ExecTurnRequest) { calls.push(request); yield { kind: 'result' as const, result: success() }; } } : {}),
  };
  const agent = new Agent({ model: provider === 'claude' ? 'opus-5' : 'gpt-5.2-codex', requireAuth, permissions: { mode },
    environment: { mode: 'explicit', variables: { AUTH_FIXTURE: 'same-environment' } } }, new Runtime({ adapters: [adapter] }));
  return { agent, calls, checked, get probes() { return probes; }, setAuth: (next: AuthStatus) => { auth = next; }, waitAuth: (wait: () => Promise<void>) => { beforeAuth = wait; } };
}

describe('subscription authentication stays required across exec turns', () => {
  for (const provider of ['claude', 'codex'] as const) for (const stream of [false, true]) {
    it(`${provider} ${stream ? 'stream' : 'execute'} refuses a changed source before the second inference`, async () => {
      const f = fixture(provider, stream);
      try {
        const session = await f.agent.openSession(); await dispatch(session, stream, 'first');
        f.setAuth({ authenticated: true, source: 'api-key' });
        await expect(dispatch(session, stream, 'second')).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE', context: { provider, retryable: false } });
        expect(f.calls).toHaveLength(1);
        expect(f.probes).toBe(3); // Readiness and one check for each attempted turn.
        expect(f.checked[1]).toBe(f.calls[0]?.env);
        expect(f.checked[2]).toBe(f.calls[0]?.env);
        await session.close();
      } finally { await f.agent.close(); }
    });
  }
  for (const stream of [false, true]) {
    it(`${stream ? 'stream' : 'execute'} never starts inference after authentication used the turn deadline`, async () => {
      const f = fixture('claude', stream);
      try {
        await f.agent.ready(); f.waitAuth(() => new Promise(resolve => setTimeout(resolve, 40)));
        await expect(dispatch(f.agent, stream, 'expired while checking auth', { timeoutMs: 5 }))
          .rejects.toMatchObject({ code: 'TIMEOUT', context: { provider: 'claude', transport: 'exec', retryable: true } });
        expect(f.calls).toHaveLength(0); expect(f.probes).toBe(2);
      } finally { await f.agent.close(); }
    });
    it(`${stream ? 'stream' : 'execute'} forwards only the remaining inference time after authentication`, async () => {
      const f = fixture('claude', stream);
      try {
        await f.agent.ready(); f.waitAuth(() => new Promise(resolve => setTimeout(resolve, 20)));
        await dispatch(f.agent, stream, 'has time remaining', { timeoutMs: 2_000 });
        expect(f.calls).toHaveLength(1); expect(f.calls[0]?.timeoutMs).toBeGreaterThan(0);
        expect(f.calls[0]?.timeoutMs).toBeLessThanOrEqual(1_985);
        expect(Number.isInteger(f.calls[0]?.timeoutMs)).toBe(true);
      } finally { await f.agent.close(); }
    });
  }
  for (const auth of [{ authenticated: false, source: 'unknown' }, { authenticated: true, source: 'unknown' }, { authenticated: true, source: 'cloud-provider' }] as AuthStatus[]) {
    it(`fails closed for authenticated=${auth.authenticated}, source=${auth.source}`, async () => {
      const f = fixture('codex', true);
      try {
        await f.agent.ready(); f.setAuth(auth);
        await expect(f.agent.send('no inference')).rejects.toMatchObject({ code: auth.authenticated ? 'UNEXPECTED_AUTH_SOURCE' : 'NOT_AUTHENTICATED' });
        expect(f.calls).toHaveLength(0);
      } finally { await f.agent.close(); }
    });
  }
  it('retains subscription success and checks before each reused turn', async () => {
    const f = fixture('claude', true);
    try {
      await f.agent.send('first'); await f.agent.send('second');
      expect(f.calls).toHaveLength(2); expect(f.probes).toBe(3);
    } finally { await f.agent.close(); }
  });
  for (const mode of ['analyze', 'unrestricted'] as const) it(`does not add a per-turn restriction to requireAuth:any with ${mode} permissions`, async () => {
    const f = fixture('claude', true, 'any', mode);
    try {
      await f.agent.send('first'); f.setAuth({ authenticated: true, source: 'api-key' }); await f.agent.send('second');
      expect(f.calls).toHaveLength(2); expect(f.probes).toBe(1);
    } finally { await f.agent.close(); }
  });
  it('does not probe or infer if the turn was already aborted', async () => {
    const f = fixture('claude', true), controller = new AbortController();
    try {
      await f.agent.ready(); controller.abort();
      await expect(f.agent.send('cancelled', { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
      expect(f.calls).toHaveLength(0); expect(f.probes).toBe(1);
    } finally { await f.agent.close(); }
  });
  it('does not infer when cancellation arrives during the fresh authentication check', async () => {
    const f = fixture('claude', true), controller = new AbortController(); let release: (() => void) | undefined;
    try {
      await f.agent.ready(); f.waitAuth(() => new Promise<void>(resolve => { release = resolve; }));
      const result = f.agent.send('cancel in auth', { signal: controller.signal })
        .then(value => ({ value }), error => ({ error }));
      await new Promise<void>(resolve => setImmediate(resolve));
      controller.abort(); release?.(); expect(await result).toMatchObject({ error: { code: 'ABORTED' } });
      expect(f.calls).toHaveLength(0); expect(f.probes).toBe(2);
    } finally { release?.(); await f.agent.close(); }
  });
  for (const mode of ['analyze', 'respond'] as const) it(`real Claude adapter enforces ${mode} subscription across a local login change`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oar-auth-subscription-')), path = join(directory, 'fixture-cli');
    await writeFile(path, 'never executed');
    let source = 'claude.ai', probes = 0; const inferenceSources: string[] = [];
    const adapter = new ClaudeExecAdapter({ target: { command: path, argsPrefix: [] }, runner: async request => {
      let stdout: string;
      if (request.args.includes('--version')) stdout = '2.1.228';
      else if (request.args.includes('auth')) { probes++; stdout = JSON.stringify({ loggedIn: true, authMethod: source }); expect(request.stdin).toBe(''); }
      else if (request.args.includes('--help')) stdout = HELP;
      else { inferenceSources.push(source); stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture', result: 'OK' }) + '\n'; request.onStdout?.(Buffer.from(stdout)); }
      return { code: 0, signal: null, stdout, stderr: '', durationMs: 0 };
    } });
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', permissions: { mode },
      ...(mode === 'respond' ? { context: { profile: 'clean' as const }, instructions: 'Return OK.', providerOptions: { claude: { tools: [], systemPromptMode: 'replace' as const } } } : {}) }, new Runtime({ adapters: [adapter] }));
    try {
      const session = await agent.openSession(); await session.send('first'); source = 'api_key';
      await expect(session.send('second')).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
      expect(inferenceSources).toEqual(['claude.ai']); expect(probes).toBe(3); await session.close();
    } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('the subscription check answers for the turn, not for the host process', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  const FLAGS = '--print --output-format --model --session-id --verbose --resume --fork-session --json-schema --include-partial-messages --safe-mode --permission-mode';
  const login = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' };
  const helper = { ...login, apiKeySource: 'apiKeyHelper' };
  const reply = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: '', durationMs: 0 });
  const isolated = (directory: string) => ({ mode: 'explicit' as const, variables: { CLAUDE_CONFIG_DIR: join(directory, 'user') } });

  async function claudeFixture(status: (args: readonly string[], cwd: string) => object) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-turn-auth-')));
    directories.push(directory);
    const path = join(directory, 'fixture-cli');
    await writeFile(path, 'never executed');
    const probes: { args: readonly string[]; cwd: string }[] = [];
    const turns: string[] = [];
    const runner: ProcessRunner = async (request) => {
      if (request.args.includes('--version')) return reply('2.1.228');
      if (request.args.includes('--help')) return reply(FLAGS);
      if (request.args.includes('auth')) {
        probes.push({ args: request.args, cwd: request.cwd });
        return reply(JSON.stringify(status(request.args, request.cwd)));
      }
      turns.push(request.cwd);
      return reply(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fixture', result: 'OK' })}\n`);
    };
    return { directory, probes, turns, runtime: new Runtime({ adapters: [new ClaudeExecAdapter({ target: { command: path, argsPrefix: [] }, runner })] }) };
  }

  it('sees an apiKeyHelper from the settings of the turn directory', async () => {
    const fixture = await claudeFixture((_args, cwd) => cwd === process.cwd() ? login : helper);
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: isolated(fixture.directory) }, fixture.runtime);
    await expect(agent.ready()).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
  });

  it('sees credentials from providerOptions.claude.settings', async () => {
    const fixture = await claudeFixture((args) => args.includes('--settings') ? helper : login);
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', environment: { mode: 'explicit', variables: {} },
      providerOptions: { claude: { settings: { apiKeyHelper: '/fixture/helper' } } } }, fixture.runtime);
    await expect(agent.ready()).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
  });

  it('does not refuse a helper that the turn profile will not load', async () => {
    const fixture = await claudeFixture((args) => args.includes('--setting-sources') ? login : helper);
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', context: { profile: 'project' }, environment: { mode: 'explicit', variables: {} } }, fixture.runtime);
    await expect(agent.ready()).resolves.toBeDefined();
  });

  it('asks again with the turn configuration right before each turn', async () => {
    let helperAppeared = false;
    const fixture = await claudeFixture((_args, cwd) => helperAppeared && cwd !== process.cwd() ? helper : login);
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: { mode: 'explicit', variables: {} } }, fixture.runtime);
    const session = await agent.openSession();
    await session.send('first');
    helperAppeared = true;
    await expect(session.send('second')).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
    expect(fixture.turns).toHaveLength(1);
  });

  it('leaves the plain probe alone when no subscription is required', async () => {
    const fixture = await claudeFixture(() => login);
    const agent = new Agent({ model: 'opus-5', cwd: fixture.directory, environment: { mode: 'explicit', variables: {} },
      providerOptions: { claude: { settings: { apiKeyHelper: '/fixture/helper' } } } }, fixture.runtime);
    await agent.ready();
    expect(fixture.probes[0]).toEqual({ args: ['auth', 'status', '--json'], cwd: process.cwd() });
  });

  // Observed on the wire with 2.1.228: these blocks supply the credential while `auth status` keeps naming the login.
  it.each([
    ['settings.json', 'ANTHROPIC_API_KEY'],
    ['settings.json', 'ANTHROPIC_AUTH_TOKEN'],
    ['settings.local.json', 'ANTHROPIC_API_KEY'],
    ['settings.json', 'ANTHROPIC_BASE_URL'],
  ])('sees the env block of %s setting %s in the turn directory', async (file, name) => {
    const fixture = await claudeFixture(() => login);
    await mkdir(join(fixture.directory, '.claude'));
    await writeFile(join(fixture.directory, '.claude', file), JSON.stringify({ env: { [name]: 'x' } }));
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: isolated(fixture.directory) }, fixture.runtime);
    await expect(agent.ready()).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
  });

  it.each([
    ['an inline object', () => ({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } })],
    ['a JSON string', () => JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } })],
    ['a path relative to the turn', () => 'turn-settings.json'],
  ])('sees a bearer token passed through settings as %s, despite the oauth_token status', async (_name, settings) => {
    const fixture = await claudeFixture(() => ({ loggedIn: true, authMethod: 'oauth_token' }));
    await writeFile(join(fixture.directory, 'turn-settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }));
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: isolated(fixture.directory),
      providerOptions: { claude: { settings: settings() } } }, fixture.runtime);
    await expect(agent.ready()).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
  });

  it.each([
    ['native', undefined, true],
    ['project', { profile: 'project' as const }, false],
  ])('honours user-level settings only when the %s profile loads them', async (_name, context, refused) => {
    const fixture = await claudeFixture(() => login);
    await mkdir(join(fixture.directory, 'user'));
    await writeFile(join(fixture.directory, 'user', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: isolated(fixture.directory),
      ...(context ? { context } : {}) }, fixture.runtime);
    if (refused) await expect(agent.ready()).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
    else await expect(agent.ready()).resolves.toBeDefined();
  });

  it.each([
    ['unrelated variables', JSON.stringify({ env: { MCP_TIMEOUT: '1' } })],
    ['an empty value', JSON.stringify({ env: { ANTHROPIC_API_KEY: '' } })],
    ['a malformed file, which the CLI tolerates too', '{not json'],
  ])('still admits the login with %s in the project settings', async (_name, contents) => {
    const fixture = await claudeFixture(() => login);
    await mkdir(join(fixture.directory, '.claude'));
    await writeFile(join(fixture.directory, '.claude', 'settings.json'), contents);
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: isolated(fixture.directory) }, fixture.runtime);
    await expect(agent.ready()).resolves.toBeDefined();
  });

  it('names a settings path it cannot read instead of reporting a lost login', async () => {
    const fixture = await claudeFixture(() => login);
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', cwd: fixture.directory, environment: isolated(fixture.directory),
      providerOptions: { claude: { settings: 'missing.json' } } }, fixture.runtime);
    await expect(agent.ready()).rejects.toThrow(/settings/i);
    await expect(agent.ready()).rejects.not.toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });

  it('reads no settings file when no subscription is required', async () => {
    const fixture = await claudeFixture(() => login);
    await mkdir(join(fixture.directory, '.claude'));
    await writeFile(join(fixture.directory, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    const agent = new Agent({ model: 'opus-5', cwd: fixture.directory, environment: isolated(fixture.directory) }, fixture.runtime);
    await expect(agent.ready()).resolves.toBeDefined();
  });

  const codexRequest: ExecTurnRequest = {
    mode: 'open', modelId: 'm', cwd: '/tmp', prompt: 'p', env: {}, contextArgs: [], permissionArgs: [],
    timeoutMs: 1000, maxOutputBytes: 1024, providerOptions: { config: { web_search: 'disabled' } },
  };

  it('pins the billing provider of a Codex turn, overriding config.toml', () => {
    const args = buildCodexExecArgs({ ...codexRequest, requireSubscription: true }, undefined);
    const pin = args.indexOf('model_provider="openai"');
    expect(args[pin - 1]).toBe('--config');
    expect(pin).toBeLessThan(args.indexOf('exec'));
    expect(pin).toBeGreaterThan(args.indexOf('web_search="disabled"'));
    expect(buildCodexExecArgs(codexRequest, undefined)).not.toContain('model_provider="openai"');
  });

  it('marks both exec paths so the adapter can pin the turn', async () => {
    const seen: ExecTurnRequest[] = [];
    const inner: ExecAdapter = {
      id: 'codex', detect: async () => ({ installed: true }), models: async () => [],
      auth: async () => ({ authenticated: true, source: 'subscription' }),
      execute: async (request) => { seen.push(request); return success(); },
      stream: async function* (request) { seen.push(request); yield { kind: 'result' as const, result: success() }; },
    };
    const wrapped = new SubscriptionExecAdapter(inner);
    await wrapped.execute(codexRequest);
    for await (const _item of wrapped.stream!(codexRequest)) { /* consume */ }
    expect(seen.map((request) => request.requireSubscription)).toEqual([true, true]);
  });

  it.each([
    ['another provider', { model_provider: 'evil' }, true],
    ['a config profile', { profile: 'p' }, true],
    ['another OpenAI endpoint', { openai_base_url: 'http://x.example/v1' }, true],
    ['the billing provider itself', { model_provider: 'openai' }, false],
    ['unrelated settings', { web_search: 'disabled' }, false],
  ])('judges a Codex config selecting %s before any probe', (_name, config, refused) => {
    const validate = () => createCodexProvider().validateOptions(
      { model: 'gpt-5.6-sol', requireAuth: 'subscription', providerOptions: { codex: { config } } }, 'exec');
    if (refused) expect(validate).toThrow(expect.objectContaining({ code: 'UNEXPECTED_AUTH_SOURCE' }));
    else expect(validate).not.toThrow();
  });

  it('does not restrict a Codex config when no subscription is required', () => {
    expect(() => createCodexProvider().validateOptions(
      { model: 'gpt-5.6-sol', providerOptions: { codex: { config: { model_provider: 'ollama' } } } }, 'exec')).not.toThrow();
  });

  it('pins a Codex control process too', () => {
    const request = { cwd: '/w', envelope: { filesystem: { readonlyRoots: [], writableRoots: [] }, permissionModeCeiling: 'plan' } };
    const pinned = codexControlConfiguration({ ...request, requireSubscription: true } as never).args;
    expect(pinned.slice(0, 2)).toEqual(['--config', 'model_provider="openai"']);
    expect(codexControlConfiguration(request as never).args).not.toContain('model_provider="openai"');
  });
});
