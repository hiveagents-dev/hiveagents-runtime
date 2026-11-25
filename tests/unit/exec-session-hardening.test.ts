import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeExecArgs, ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { buildCodexExecArgs, CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { AdapterStreamItem, ExecAdapter, ExecTurnRequest, ProcessRunner, ProtocolResult } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { AbortError, SessionMismatchError, TimeoutError } from '../../src/public/errors.js';
import type { AgentOptions } from '../../src/public/types.js';

const ok = (sessionId: string): ProtocolResult => ({
  completed: true, failed: false, refused: false, sessionId, text: 'ok', events: [], nativeEvents: [],
});
const usageLimit: ProtocolResult = {
  completed: false, failed: true, refused: false, text: '', events: [], nativeEvents: [],
  failure: { kind: 'usage-limit', message: 'rate limit' },
};

class FakeAdapter implements ExecAdapter {
  readonly id = 'claude' as const;
  readonly requests: ExecTurnRequest[] = [];
  executeImpl: (request: ExecTurnRequest, call: number) => Promise<ProtocolResult> =
    async (request) => ok(request.sessionId ?? 'native-session');
  streamImpl: (request: ExecTurnRequest) => AsyncIterable<AdapterStreamItem> = async function* () {};
  async detect() { return { installed: true, path: '/bin/claude', version: '1.0.0' }; }
  async auth() { return { authenticated: true, source: 'subscription' as const }; }
  async models() { return []; }
  async execute(request: ExecTurnRequest) {
    this.requests.push(request);
    return this.executeImpl(request, this.requests.length);
  }
  async *stream(request: ExecTurnRequest) {
    this.requests.push(request);
    yield* this.streamImpl(request);
  }
}

function setup(options: Partial<AgentOptions> = {}) {
  const adapter = new FakeAdapter();
  return { adapter, agent: new Agent({ model: 'opus-5', ...options }, new Runtime({ adapters: [adapter] })) };
}

/** A CLI that, like a real process group, takes a moment to die after the abort. */
function dyingCli(ms = 50) {
  const cli = {
    alive: false,
    overlapped: false,
    /** First call hangs until aborted; later calls record whether they ran over the dying process. */
    execute: (request: ExecTurnRequest, call: number): Promise<ProtocolResult> => {
      if (cli.alive) cli.overlapped = true;
      if (call > 1) return Promise.resolve(ok(request.sessionId ?? 'native-session'));
      cli.alive = true;
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => setTimeout(() => {
          cli.alive = false;
          reject(new AbortError({ retryable: true }));
        }, ms), { once: true });
      });
    },
  };
  return cli;
}

describe('an environment credential that outranks the CLI login', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  const login = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' };
  const reply = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: '', durationMs: 0 });
  const claude = (status: object) => new ClaudeExecAdapter({
    target: { command: '/fixture/claude', argsPrefix: [] }, runner: async () => reply(JSON.stringify(status)),
  });
  const codex = () => new CodexExecAdapter({
    target: { command: '/fixture/codex', argsPrefix: [] }, runner: async () => reply('Logged in using ChatGPT\n'),
  });

  it('reports api-key when Claude says a key will be used, and drops the plan that would not pay', async () => {
    const auth = await claude({ ...login, apiKeySource: 'ANTHROPIC_API_KEY' }).auth({});
    expect(auth).toEqual({ authenticated: true, source: 'api-key' });
  });

  it('reports api-key for ANTHROPIC_AUTH_TOKEN, which auth status does not reveal', async () => {
    await expect(claude(login).auth({ ANTHROPIC_AUTH_TOKEN: 'x' })).resolves.toMatchObject({ source: 'api-key' });
  });

  it.each([
    ['a named profile', { ANTHROPIC_PROFILE: 'work' }],
    ['federation', { ANTHROPIC_FEDERATION_RULE_ID: 'r', ANTHROPIC_ORGANIZATION_ID: 'o' }],
  ])('reports api-key for %s, which auth status does not reveal', async (_name, env) => {
    await expect(claude(login).auth(env)).resolves.toMatchObject({ source: 'api-key' });
  });

  it.each([
    ['no key', login, {}],
    ['apiKeySource none', { ...login, apiKeySource: 'none' }, {}],
    ['an empty token', login, { ANTHROPIC_AUTH_TOKEN: '' }],
    ['an incomplete federation', login, { ANTHROPIC_FEDERATION_RULE_ID: 'r' }],
  ])('keeps a claude.ai login as subscription with %s', async (_name, status, env) => {
    await expect(claude(status).auth(env)).resolves.toEqual({
      authenticated: true, source: 'subscription', account: { plan: 'max' },
    });
  });

  it('keeps a setup-token login as subscription', async () => {
    await expect(claude({ loggedIn: true, authMethod: 'oauth_token' }).auth({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }))
      .resolves.toMatchObject({ source: 'subscription' });
  });

  it('reports api-key for CODEX_API_KEY, which codex exec sends over a saved ChatGPT login', async () => {
    await expect(codex().auth({ CODEX_API_KEY: 'x' })).resolves.toMatchObject({ source: 'api-key' });
  });

  it.each([
    ['no key', {}],
    ['OPENAI_API_KEY, which codex exec ignores', { OPENAI_API_KEY: 'x' }],
    ['an empty CODEX_API_KEY', { CODEX_API_KEY: '' }],
  ])('keeps a ChatGPT login as subscription with %s', async (_name, env) => {
    await expect(codex().auth(env)).resolves.toMatchObject({ source: 'subscription' });
  });

  it.each([
    ['refuses', { mode: 'explicit' as const, variables: { ANTHROPIC_API_KEY: 'x' } }, true],
    ['admits', { mode: 'explicit' as const, variables: {} }, false],
  ])('%s requireAuth subscription depending on what the turn environment carries', async (_name, environment, refused) => {
    const directory = await mkdtemp(join(tmpdir(), 'oar-auth-env-'));
    directories.push(directory);
    const path = join(directory, 'fixture-cli');
    await writeFile(path, 'never executed');
    const inference: string[] = [];
    const runner: ProcessRunner = async (request) => {
      if (request.args.includes('--version')) return reply('2.1.228');
      if (request.args.includes('auth')) {
        return reply(JSON.stringify({ ...login, ...(request.env.ANTHROPIC_API_KEY ? { apiKeySource: 'ANTHROPIC_API_KEY' } : {}) }));
      }
      if (request.args.includes('--help')) return reply('--print --output-format --model --session-id --verbose --permission-mode');
      inference.push(request.args.join(' '));
      return reply('');
    };
    const adapter = new ClaudeExecAdapter({ target: { command: path, argsPrefix: [] }, runner });
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', environment }, new Runtime({ adapters: [adapter] }));
    if (refused) await expect(agent.ready()).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
    else await expect(agent.ready()).resolves.toBeDefined();
    expect(inference).toEqual([]);
  });
});

describe('a persisted SessionRef id, which becomes a CLI argument', () => {
  const unsafe = [
    ['a skip-permissions flag', '--dangerously-skip-permissions'],
    ['a short flag', '-x'],
    ['the codex last selector', '--last'],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\0b'],
    ['nothing', ''],
    ['an absolute transcript path', '/tmp/forged.jsonl'],
    ['a relative transcript path', 'forged.jsonl'],
    ['a URL', 'https://example.test/session'],
    ['a Windows path', 'C:\\forged'],
    ['a dash lookalike at the start', '\u2013flag'],
    ['an oversized value', 'x'.repeat(513)],
  ] as const;

  it.each(unsafe)('refuses %s before any turn', async (_name, id) => {
    const { adapter, agent } = setup();
    const session = await agent.openSession();
    await session.send('establish');
    const calls = adapter.requests.length;
    await expect(new Agent({ model: 'opus-5' }, new Runtime({ adapters: [adapter] }))
      .openSession({ resume: { ...session.export(), id } })).rejects.toBeInstanceOf(SessionMismatchError);
    expect(adapter.requests).toHaveLength(calls);
  });

  it.each(['019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b', 'thread_abc.1'])('still resumes the opaque id %s', async (id) => {
    const { adapter, agent } = setup();
    const session = await agent.openSession();
    await session.send('establish');
    const resumed = await new Agent({ model: 'opus-5' }, new Runtime({ adapters: [adapter] }))
      .openSession({ resume: { ...session.export(), id } });
    await resumed.send('continue');
    expect(adapter.requests.at(-1)).toMatchObject({ mode: 'resume', sessionId: id });
  });

  const request = (mode: 'resume' | 'fork', sessionId: string): ExecTurnRequest => ({
    mode, sessionId, modelId: 'm', cwd: '/tmp', prompt: 'p', env: {}, contextArgs: [], permissionArgs: [],
    timeoutMs: 1000, maxOutputBytes: 1024,
  });

  it.each(['resume', 'fork'] as const)('never builds %s argv from a flag-shaped id, even one a provider reported', (mode) => {
    expect(() => buildClaudeExecArgs(request(mode, '--dangerously-skip-permissions'), 'new')).toThrow(TypeError);
    expect(() => buildCodexExecArgs(request(mode, '--last'), undefined)).toThrow(TypeError);
    expect(buildClaudeExecArgs(request(mode, 'native-id'), 'new')).toContain('native-id');
    expect(buildCodexExecArgs(request(mode, 'native-id'), undefined)).toContain('native-id');
  });
});

describe('a native session the CLI no longer has', () => {
  // Shapes captured from claude 2.1.228 and codex 0.153.4 resuming an id that does not exist.
  const missing = '00000000-0000-4000-8000-000000000000';
  const claudeRun = (args: readonly string[]) => args.includes('--resume')
    ? { code: 1, signal: null, durationMs: 0, stderr: `No conversation found with session ID: ${missing}\n`,
        stdout: `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: missing, errors: [`No conversation found with session ID: ${missing}`] })}\n` }
    : { code: 0, signal: null, durationMs: 0, stderr: '',
        stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: missing, result: 'OK' })}\n` };

  it.each([['claude', 'execute'], ['claude', 'stream'], ['codex', 'execute']] as const)('%s %s reports it as not retryable, unlike an outage', async (provider, path) => {
    const request: ExecTurnRequest = {
      mode: 'resume', sessionId: missing, modelId: 'm', cwd: '/tmp', prompt: 'p', env: {}, contextArgs: [], permissionArgs: [],
      timeoutMs: 1000, maxOutputBytes: 1024 * 1024,
    };
    const target = { command: '/fixture/cli', argsPrefix: [] };
    const adapter = provider === 'claude'
      ? new ClaudeExecAdapter({ target, runner: async (r) => { const out = claudeRun(r.args); r.onStdout?.(Buffer.from(out.stdout)); return out; } })
      : new CodexExecAdapter({ target, runner: async () => ({
          code: 1, signal: null, durationMs: 0, stdout: '',
          stderr: `Error: thread/resume: thread/resume failed: no rollout found for thread id ${missing} (code -32600)\n`,
        }) });
    let result: ProtocolResult | undefined;
    if (path === 'execute') result = await adapter.execute(request);
    else for await (const item of adapter.stream(request)) if (item.kind === 'result') result = item.result;
    expect(result?.failure?.kind).toBe('session-not-found');
  });

  it('stops retry loops: the Agent surfaces SESSION_NOT_FOUND, not a retryable outage', async () => {
    const { adapter, agent } = setup();
    adapter.executeImpl = async (request, call) => call === 1 ? ok('native-session') : {
      ...usageLimit, failure: { kind: 'session-not-found', message: 'gone' },
    };
    await agent.send('establish');
    await expect(agent.send('gone')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', context: { retryable: false } });
  });
});

describe('recovering after a failed exec turn', () => {
  it('names its provider before the first turn confirms a session', async () => {
    const { agent } = setup();
    const session = await agent.openSession();
    expect(session.ref).toBeUndefined();
    expect(session.provider).toBe('claude');
  });

  it('lets the next Agent.send continue the native session after a usage limit', async () => {
    const { adapter, agent } = setup();
    adapter.executeImpl = async (request, call) => call === 2 ? usageLimit : ok(request.sessionId ?? 'native-session');
    await agent.send('establish');
    await expect(agent.send('limited')).rejects.toMatchObject({ code: 'USAGE_LIMIT' });
    await expect(agent.send('retry')).resolves.toMatchObject({ status: 'completed' });
    expect(adapter.requests.at(-1)).toMatchObject({ mode: 'resume', sessionId: 'native-session' });
  });

  it('opens a session on the next send when the failed turn never confirmed one', async () => {
    const { adapter, agent } = setup();
    adapter.executeImpl = async (_request, call) => call === 1 ? usageLimit : ok('native-session');
    await expect(agent.send('limited')).rejects.toMatchObject({ code: 'USAGE_LIMIT' });
    await expect(agent.send('retry')).resolves.toMatchObject({ status: 'completed' });
    expect(adapter.requests.at(-1)).toMatchObject({ mode: 'open' });
  });

  it('waits for a timed-out CLI to die so the next send cannot overlap it', async () => {
    const { adapter, agent } = setup();
    const cli = dyingCli();
    adapter.executeImpl = cli.execute;
    await expect(agent.send('slow', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(agent.send('retry')).resolves.toMatchObject({ status: 'completed' });
    expect(cli.overlapped).toBe(false);
  });

  it('sees through the subscription wrapper when waiting for the dying CLI', async () => {
    const { adapter, agent } = setup({ requireAuth: 'subscription' });
    const cli = dyingCli(), controller = new AbortController();
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
    adapter.executeImpl = (request, call) => { const actual = cli.execute(request, call); if (call === 1) started(); return actual; };
    // Exercise a genuinely started dying CLI; a 20ms readiness timeout could skip its first invocation under load.
    const pending = agent.send('slow', { signal: controller.signal }); void pending.catch(() => {});
    await running; controller.abort(new TimeoutError({ retryable: true }));
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(agent.send('retry')).resolves.toMatchObject({ status: 'completed' });
    expect(cli.overlapped).toBe(false);
  });

  it('continues after an abandoned Agent.stream only once its CLI has died', async () => {
    const { adapter, agent } = setup();
    const cli = dyingCli();
    adapter.streamImpl = async function* (request) {
      cli.alive = true;
      const execution = new Promise<void>((resolve) => {
        request.signal?.addEventListener('abort', () => setTimeout(() => { cli.alive = false; resolve(); }, 50), { once: true });
      });
      try {
        yield { kind: 'session' as const, sessionId: 'stream-session' };
        await execution;
      } finally { if (request.awaitSettlement) await execution; }
    };
    for await (const _event of agent.stream('abandon')) break;
    adapter.executeImpl = async (request) => {
      if (cli.alive) cli.overlapped = true;
      return ok(request.sessionId ?? 'native-session');
    };
    await expect(agent.send('retry')).resolves.toMatchObject({ status: 'completed' });
    expect(cli.overlapped).toBe(false);
    expect(adapter.requests.at(-1)).toMatchObject({ mode: 'resume', sessionId: 'stream-session' });
  });

  it('keeps refusing while a noncooperative CLI may still own the transcript', async () => {
    const { adapter, agent } = setup();
    adapter.executeImpl = () => new Promise(() => {});
    // Warm the cached readiness first, and leave the deadline room: under a loaded full suite a few
    // milliseconds can pass before the CLI ever runs, and then no CLI would own the transcript.
    await agent.ready();
    await expect(agent.send('hang', { timeoutMs: 250 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(agent.send('overlap', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'SESSION_INTERRUPTED' });
    expect(adapter.requests).toHaveLength(1);
  });

  it('lets an explicit Session heal a failed turn through reconcile, and only through it', async () => {
    const { adapter, agent } = setup();
    adapter.executeImpl = async (request, call) => call === 2 ? usageLimit : ok(request.sessionId ?? 'native-session');
    const session = await agent.openSession();
    await session.send('establish');
    await expect(session.send('limited')).rejects.toMatchObject({ code: 'USAGE_LIMIT' });
    await expect(session.send('refused')).rejects.toMatchObject({ code: 'SESSION_INTERRUPTED' });
    await expect(session.reconcile()).resolves.toBe('idle');
    await expect(session.send('retry')).resolves.toMatchObject({ status: 'completed' });
  });

  it('keeps a fork child unknown until its own CLI has died', async () => {
    const { adapter, agent } = setup();
    const parent = await agent.openSession();
    await parent.send('parent');
    const cli = { alive: false };
    adapter.streamImpl = async function* (request) {
      cli.alive = true;
      const died = new Promise<void>((resolve) => {
        request.signal?.addEventListener('abort', () => setTimeout(() => { cli.alive = false; resolve(); }, 50), { once: true });
      });
      try {
        yield { kind: 'session' as const, sessionId: 'child' };
        await died;
      } finally { if (request.awaitSettlement) await died; }
    };
    const fork = await parent.startFork('branch', { timeoutMs: 5000 });
    void fork.turn.result.catch(() => undefined);
    await fork.turn.interrupt();
    await expect(fork.session.reconcile()).resolves.toBe('idle');
    expect(cli.alive).toBe(false);
  });

  it('never heals a fork child whose CLI ignores the abort', async () => {
    const { adapter, agent } = setup();
    const parent = await agent.openSession();
    await parent.send('parent');
    adapter.streamImpl = async function* () {
      yield { kind: 'session' as const, sessionId: 'child' };
      await new Promise(() => {});
    };
    const fork = await parent.startFork('branch', { timeoutMs: 20 });
    await expect(fork.turn.result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(fork.session.reconcile()).resolves.toBe('unknown');
  });

  it('observes the pending next() of a stream iterator that has no return()', async () => {
    const { adapter, agent } = setup();
    let alive = false;
    let overlapped = false;
    Object.assign(adapter, { stream: (request: ExecTurnRequest): AsyncIterable<AdapterStreamItem> => ({
      [Symbol.asyncIterator]() {
        alive = true;
        return {
          next: () => new Promise<IteratorResult<AdapterStreamItem>>((resolve) => {
            request.signal?.addEventListener('abort', () => setTimeout(() => {
              alive = false;
              resolve({ done: true, value: undefined });
            }, 50), { once: true });
          }),
        };
      },
    }) });
    adapter.executeImpl = async (request) => {
      if (alive) overlapped = true;
      return ok(request.sessionId ?? 'native-session');
    };
    await expect((async () => { for await (const _event of agent.stream('hang', { timeoutMs: 20 })) { /* consume */ } })())
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(agent.send('retry')).resolves.toMatchObject({ status: 'completed' });
    expect(overlapped).toBe(false);
  });

  it('answers a typed error when the Agent is closed while it was reconciling', async () => {
    const { adapter, agent } = setup();
    adapter.executeImpl = dyingCli().execute;
    await expect(agent.send('slow', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const retry = agent.send('retry');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await agent.close();
    await expect(retry).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
  });

  it('does not reopen a session closed while it was reconciling', async () => {
    const { adapter, agent } = setup();
    const cli = dyingCli();
    adapter.executeImpl = cli.execute;
    const session = await agent.openSession();
    await expect(session.send('slow', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const reconciling = session.reconcile();
    await session.close();
    await expect(reconciling).resolves.toBe('closed');
  });
});
