import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent, Runtime, ExecutionHaltedError, createClaudeProvider, createCodexProvider,
  type ExecTurnRequest, type ProcessRequest, type ProcessRunner,
} from '../../src/index.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';
import { runProcess } from '../../src/process/run-process.js';
import { resolveBinary, resolveBinaryCandidates, type LaunchTarget } from '../../src/process/resolve-binary.js';

vi.mock('../../src/process/run-process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/process/run-process.js')>(), runProcess: vi.fn(),
}));
vi.mock('../../src/process/resolve-binary.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/process/resolve-binary.js')>(),
  resolveBinary: vi.fn(), resolveBinaryCandidates: vi.fn(),
}));

const cases = [
  { id: 'claude', factory: createClaudeProvider, version: '2.1.251', model: 'claude-opus-5' },
  { id: 'codex', factory: createCodexProvider, version: '0.149.0', model: 'gpt-5.4' },
] as const;
const fixtures = {
  claude: await readFile(new URL('../fixtures/claude/success-2.1.251.jsonl', import.meta.url), 'utf8'),
  codex: await readFile(new URL('../fixtures/codex/success-0.149.0.jsonl', import.meta.url), 'utf8'),
};
const claudeHelp = '--print --output-format --model --session-id --verbose --resume --fork-session --json-schema --include-partial-messages --safe-mode --permission-mode';
const codexHelp = '--json --model --output-schema --ignore-user-config --ignore-rules';

function recordingRunner(id: 'claude' | 'codex', text = 'runner-a') {
  return vi.fn<ProcessRunner>(async request => {
    let stdout: string;
    if (request.args.includes('--version')) stdout = id === 'claude' ? 'Claude Code 2.1.251' : 'codex-cli 0.149.0';
    else if (request.args.includes('--help')) stdout = id === 'claude' ? claudeHelp
      : `${codexHelp}${request.args.includes('resume') || request.args.includes('fork') ? '' : ' --sandbox'}`;
    else if (request.args.includes('status')) stdout = id === 'claude'
      ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'Logged in using ChatGPT';
    else stdout = fixtures[id].replaceAll(id === 'claude' ? 'Hola' : 'Tests en verde.', text);
    request.onStdout?.(Buffer.from(stdout));
    return { code: 0, signal: null, stdout, stderr: '', durationMs: 1 };
  });
}

describe.each(cases)('$id built-in provider runner', ({ id, factory, version, model }) => {
  let directory: string;
  let target: LaunchTarget;
  let bound: LaunchTarget;
  let env: Record<string, string>;
  const defaultRunner = vi.mocked(runProcess);
  beforeEach(async () => {
    vi.clearAllMocks();
    defaultRunner.mockImplementation(async () => { throw new Error('Unexpected native process boundary'); });
    directory = await mkdtemp(join(tmpdir(), 'oar-builtin-runner-'));
    target = { command: join(directory, 'original.exe'), argsPrefix: ['--fixture-prefix'] };
    bound = { command: join(directory, 'bound.exe'), argsPrefix: ['--bound-prefix'] };
    await Promise.all([target, bound].map(value => writeFile(value.command, 'fixture executable identity\n', { mode: 0o700 })));
    vi.mocked(resolveBinary).mockImplementation(() => target);
    vi.mocked(resolveBinaryCandidates).mockImplementation(() => [target]);
    env = { PATH: directory, HOME: directory, USERPROFILE: directory };
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  function turn(): ExecTurnRequest {
    return { mode: 'open', modelId: model, cwd: directory, prompt: 'fixture only', env,
      contextArgs: [], permissionArgs: [], timeoutMs: 1000, maxOutputBytes: 1024 * 1024 };
  }
  function agent(runtime: Runtime) {
    return new Agent({ model, transport: 'exec', cwd: directory,
      environment: { mode: 'explicit', variables: env } }, runtime);
  }
  async function operations(adapter: ExecAdapter, expectedText: string) {
    expect(await adapter.detect(env)).toMatchObject({ installed: true, version });
    expect(await adapter.auth(env)).toMatchObject({ authenticated: true, source: 'subscription' });
    expect((await adapter.compatibility!(env, version))?.features.turns).toBe('supported');
    const result = await adapter.execute(turn());
    expect(result.completed).toBe(true);
    expect(result.text).toBe(expectedText);
    const items = [];
    for await (const item of adapter.stream!(turn())) items.push(item);
    expect(items).toContainEqual(expect.objectContaining({ kind: 'event' }));
    expect(items).toContainEqual({ kind: 'result', result: expect.objectContaining({ completed: true, text: expectedText }) });
  }
  function expectTarget(requests: ProcessRequest[], expected: LaunchTarget) {
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.command).toBe(expected.command);
      expect(request.args.slice(0, expected.argsPrefix.length)).toEqual(expected.argsPrefix);
    }
  }

  it('separates native probes from generation and captures both runners through target pinning', async () => {
    const runner = recordingRunner(id, 'generation');
    const probeRunner = recordingRunner(id, 'probe');
    const options: { runner: ProcessRunner; probeRunner: ProcessRunner } = { runner, probeRunner };
    const registration = factory(options);
    options.runner = async () => { throw Error('mutated generation runner'); };
    options.probeRunner = async () => { throw Error('mutated probe runner'); };
    for (const [adapter, expected] of [[registration.exec.adapter, target], [registration.exec.withTarget!(bound), bound]] as const) {
      runner.mockClear(); probeRunner.mockClear();
      await operations(adapter, 'generation');
      expect(runner).toHaveBeenCalledTimes(2);
      expect(probeRunner).toHaveBeenCalledTimes(id === 'claude' ? 3 : 5);
      expectTarget(runner.mock.calls.map(([request]) => request), expected);
      expectTarget(probeRunner.mock.calls.map(([request]) => request), expected);
      expect(probeRunner.mock.calls.every(([request]) => request.args.some(arg => ['--version', '--help', 'status'].includes(arg)))).toBe(true);
    }
    expect(defaultRunner).not.toHaveBeenCalled();
  });

  it.each([false, true])('propagates a genuine probe halt without falling back to missing CLI, abort=%s', async abort => {
    const error = new ExecutionHaltedError(), controller = new AbortController();
    const runner = recordingRunner(id);
    const registration = factory({ runner, probeRunner: async () => { if (abort) controller.abort(); throw error; } });
    await expect(registration.exec.adapter.detect(env, { signal: controller.signal, deadline: Date.now() + 1000, remainingMs: () => 1000 })).rejects.toBe(error);
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses an invalid explicit probe runner before constructing a provider', () => {
    expect(() => factory({ runner: recordingRunner(id), probeRunner: null } as never)).toThrow(TypeError);
  });

  it('uses the injected runner for original and target-bound provider operations', async () => {
    const runner = recordingRunner(id);
    const registration = factory({ runner });
    await operations(registration.exec.adapter, 'runner-a');
    expectTarget(runner.mock.calls.map(([request]) => request), target);
    runner.mockClear();
    await operations(registration.exec.withTarget!(bound), 'runner-a');
    expectTarget(runner.mock.calls.map(([request]) => request), bound);
    expect(defaultRunner).not.toHaveBeenCalled();
  });

  it('keeps the injected runner when Agent pins a launch target', async () => {
    const runner = recordingRunner(id);
    const subject = agent(new Runtime({ providers: [factory({ runner })] }));
    const readiness = await subject.ready();
    const pinned = { command: await realpath(target.command), argsPrefix: target.argsPrefix };
    expect(readiness.plan.fingerprint.executableRealpath).toBe(pinned.command);
    expect(readiness.plan.fingerprint.executableDigest).toBe(createHash('sha256').update('fixture executable identity\n').digest('hex'));
    vi.mocked(resolveBinary).mockReturnValue(bound);
    vi.mocked(resolveBinaryCandidates).mockReturnValue([bound]);
    runner.mockClear();
    const session = await subject.openSession();
    try { expect((await session.send('fixture only')).text).toBe('runner-a'); }
    finally { await session.close(); }
    expectTarget(runner.mock.calls.map(([request]) => request), pinned);
    expect(defaultRunner).not.toHaveBeenCalled();
  });

  it('captures the runner before caller options mutate', async () => {
    const runnerA = recordingRunner(id), runnerB = recordingRunner(id, 'runner-b');
    const options: { runner?: ProcessRunner } = { runner: runnerA };
    const registration = factory(options);
    options.runner = runnerB;
    expect((await registration.exec.adapter.execute(turn())).text).toBe('runner-a');
    Object.assign(options, { runner: undefined });
    await operations(registration.exec.withTarget!(bound), 'runner-a');
    expect(runnerB).not.toHaveBeenCalled();
    expect(defaultRunner).not.toHaveBeenCalled();
  });

  it('isolates injected registrations from each other', async () => {
    const runnerA = recordingRunner(id), runnerB = recordingRunner(id, 'runner-b');
    const first = agent(new Runtime({ providers: [factory({ runner: runnerA })] }));
    const second = agent(new Runtime({ providers: [factory({ runner: runnerB })] }));
    const sessionA = await first.openSession(), sessionB = await second.openSession();
    try {
      runnerB.mockClear();
      expect((await sessionA.send('first')).text).toBe('runner-a');
      expect(runnerB).not.toHaveBeenCalled();
      runnerA.mockClear();
      expect((await sessionB.send('second')).text).toBe('runner-b');
      expect(runnerA).not.toHaveBeenCalled();
    } finally { await Promise.all([sessionA.close(), sessionB.close()]); }
    expect(defaultRunner).not.toHaveBeenCalled();
  });

  it('keeps default provider behavior without runner options', async () => {
    defaultRunner.mockImplementation(recordingRunner(id));
    const registrations = [factory(), factory({}), factory({ runner: undefined } as unknown as { runner?: ProcessRunner })];
    const runtime = new Runtime();
    expect(runtime.providers()).toEqual(['claude', 'codex', 'gemini', 'antigravity']);
    expect(defaultRunner).not.toHaveBeenCalled();
    for (const registration of registrations) await operations(registration.exec.adapter, 'runner-a');
    await operations(runtime.adapter(id), 'runner-a');
    expect(defaultRunner).toHaveBeenCalled();
    expect(runtime.resolveModel(model).provider).toBe(id);
  });

  it('rejects invalid supplied runners before any process boundary', () => {
    for (const runner of [null, 0, 'runner', {}]) {
      expect(() => factory({ runner } as unknown as { runner?: ProcessRunner })).toThrow(TypeError);
    }
    expect(defaultRunner).not.toHaveBeenCalled();
    expect(resolveBinaryCandidates).not.toHaveBeenCalled();
  });
});
