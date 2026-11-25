import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rename, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLAUDE_CONTROL_CAPABILITY_VERDICTS } from '../../src/adapters/claude-control/session.js';
import type {
  ExecAdapter,
  ExecTurnRequest,
  ProtocolResult,
} from '../../src/adapters/provider.js';
import {
  AdapterRegistry,
  CONTROL_TRANSPORTS,
  EXEC_TRANSPORT_TOKENS,
  PinnedExecAdapter,
  assertExperimentalApiEnabled,
  controlSessionUnavailableMessage,
  createExecutablePin,
  experimentalGates,
  type ControlAdapterRegistration,
  type ExecutablePin,
} from '../../src/core/registry.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { assessCliCompatibility } from '../../src/compatibility/manifest.js';
import type { AuthStatus } from '../../src/public/types.js';
import {
  CliNotInstalledError,
  RequiredTransportUnavailableError,
  UnsupportedCapabilityError,
} from '../../src/public/errors.js';

class FakeAdapter implements ExecAdapter {
  readonly id;
  readonly requests: ExecTurnRequest[] = [];
  detectCalls = 0;
  path: string;
  version = '1.0.0';
  authSource: AuthStatus['source'] = 'subscription';
  compatibilityImpl: ExecAdapter['compatibility'];

  constructor(id: 'claude' | 'codex' = 'claude', path = `/bin/${id}`) {
    this.id = id;
    this.path = path;
    this.compatibilityImpl = undefined;
  }

  async detect() {
    this.detectCalls += 1;
    return { installed: true, path: this.path, version: this.version };
  }

  async auth() {
    return { authenticated: true, source: this.authSource };
  }

  async models() {
    return [];
  }

  async compatibility(env: NodeJS.ProcessEnv, version: string) {
    return this.compatibilityImpl?.(env, version);
  }

  async execute(request: ExecTurnRequest): Promise<ProtocolResult> {
    this.requests.push(request);
    return {
      completed: true,
      failed: false,
      refused: false,
      sessionId: request.sessionId ?? `${this.id}-session`,
      text: 'ok',
      events: [{ type: 'message.completed', text: 'ok' }],
      nativeEvents: [],
    };
  }
}

function claudeControlRegistration(
  overrides: Partial<ControlAdapterRegistration> = {},
): ControlAdapterRegistration {
  return {
    token: 'claudeControlV1',
    provider: 'claude',
    packageName: '@open-agent-runtime/claude-control',
    adapterVersion: '0.1.0',
    capabilityVerdicts: CLAUDE_CONTROL_CAPABILITY_VERDICTS,
    evidenceSource: 'sdk-capability',
    sdkVersion: '0.3.252',
    protocolVersion: 'claude-agent-sdk-query',
    ...overrides,
  };
}

describe('AdapterRegistry', () => {
  it('lists versioned transport tokens for explicit registrations only', () => {
    const registry = new AdapterRegistry();
    registry.registerExec({ adapter: new FakeAdapter('claude') });
    registry.registerExec({ adapter: new FakeAdapter('codex') });
    expect(registry.tokens()).toEqual(['claudeExecV1', 'codexExecV1']);

    registry.registerControl(claudeControlRegistration());
    expect(registry.tokens()).toContain('claudeControlV1');
    expect(registry.control('codex')).toBeUndefined();
  });

  it('rejects a control token that does not match its provider', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.registerControl(claudeControlRegistration({ provider: 'codex' })))
      .toThrow(TypeError);
  });

  it('rejects an exec adapter whose id names no known provider, so doctor never meets an unknown token', () => {
    const registry = new AdapterRegistry();
    for (const id of ['gemini', 'toString', '__proto__', '']) {
      const adapter = new FakeAdapter('claude');
      Object.defineProperty(adapter, 'id', { value: id });
      expect(() => registry.registerExec({ adapter })).toThrow(TypeError);
      expect(() => registry.registerExec({ adapter })).toThrow(/claude, codex/);
    }
    expect(registry.tokens()).toEqual([]);
  });

  it('rejects duplicate registrations', () => {
    const registry = new AdapterRegistry();
    registry.registerExec({ adapter: new FakeAdapter('claude') });
    expect(() => registry.registerExec({ adapter: new FakeAdapter('claude') })).toThrow(TypeError);
    registry.registerControl(claudeControlRegistration());
    expect(() => registry.registerControl(claudeControlRegistration())).toThrow(TypeError);
  });

  it('treats a missing control adapter as normal and names the token and shipped factory', () => {
    const registry = new AdapterRegistry();
    registry.registerExec({ adapter: new FakeAdapter('codex') });
    expect(registry.control('codex')).toBeUndefined();
    expect(() => registry.requireControl('codex')).toThrow(RequiredTransportUnavailableError);
    expect(() => registry.requireControl('codex'))
      .toThrow(/codexAppServerV1.*createCodexControlRegistration/);
  });

  it('carries an optional session factory and names the gap when one is absent', () => {
    const registry = new AdapterRegistry();
    registry.registerControl(claudeControlRegistration());
    expect(registry.control('claude')?.createSession).toBeUndefined();

    const wired = new AdapterRegistry();
    const createSession = async () => {
      throw new Error('not called');
    };
    wired.registerControl(claudeControlRegistration({ createSession }));
    expect(wired.control('claude')?.createSession).toBe(createSession);

    expect(controlSessionUnavailableMessage('codex'))
      .toMatch(/codexAppServerV1.*no session factory.*createCodexControlRegistration/);
  });

  it('exposes the static token map without scanning anything', () => {
    expect(EXEC_TRANSPORT_TOKENS).toEqual({ claude: 'claudeExecV1', codex: 'codexExecV1' });
    expect(CONTROL_TRANSPORTS.claude.token).toBe('claudeControlV1');
    expect(CONTROL_TRANSPORTS.codex.token).toBe('codexAppServerV1');
  });
});

describe('experimental gates', () => {
  it('defaults both gates to false and keeps them independent', () => {
    expect(experimentalGates(undefined)).toEqual({ control: false, api: false });
    expect(experimentalGates({ experimentalControl: true }))
      .toEqual({ control: true, api: false });
    expect(experimentalGates({ experimentalApi: true }))
      .toEqual({ control: false, api: true });
  });

  it('refuses dynamic tools without the explicit experimentalApi opt-in', () => {
    const gates = experimentalGates({ experimentalControl: true });
    expect(() => assertExperimentalApiEnabled(gates, 'codex'))
      .toThrow(UnsupportedCapabilityError);
    expect(() => assertExperimentalApiEnabled(experimentalGates({ experimentalApi: true }), 'codex'))
      .not.toThrow();
  });
});

describe('control routing through Agent.ready()', () => {
  it('negotiates a control plan from verdicts supplied at registration', async () => {
    const runtime = new Runtime({
      adapters: [new FakeAdapter('claude')],
      controlAdapters: [claudeControlRegistration()],
    });
    const agent = new Agent({
      model: 'opus-5',
      capabilities: { interactiveApprovals: 'required' },
      providerOptions: { experimentalControl: true },
    }, runtime);

    const readiness = await agent.ready();
    expect(readiness.plan).toMatchObject({
      provider: 'claude',
      transport: 'control',
      fingerprint: {
        adapterVersion: '0.1.0',
        cliVersion: '1.0.0',
        sdkVersion: '0.3.252',
        protocolVersion: 'claude-agent-sdk-query',
      },
      capabilities: {
        interactiveApprovals: {
          support: 'full',
          evidence: [{ source: 'sdk-capability', fingerprint: expect.stringContaining('claude') }],
        },
        steering: { support: 'none' },
      },
    });
  });

  it('fails closed when a required capability has only unknown evidence', async () => {
    const runtime = new Runtime({
      adapters: [new FakeAdapter('claude')],
      controlAdapters: [claudeControlRegistration()],
    });
    const agent = new Agent({
      model: 'opus-5',
      capabilities: { subagentLifecycle: 'required' },
      providerOptions: { experimentalControl: true },
    }, runtime);

    await expect(agent.ready()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('does not enable control from registration alone; experimentalControl is an explicit opt-in', async () => {
    const runtime = new Runtime({
      adapters: [new FakeAdapter('claude')],
      controlAdapters: [claudeControlRegistration()],
    });
    const agent = new Agent({
      model: 'opus-5',
      capabilities: { interactiveApprovals: 'required' },
    }, runtime);

    await expect(agent.ready()).rejects.toThrow(/experimentalControl/);
  });

  it('names the missing token and package when control is required but unregistered', async () => {
    const runtime = new Runtime({ adapters: [new FakeAdapter('codex')] });
    const agent = new Agent({
      model: 'gpt-5.2-codex',
      capabilities: { steering: 'required' },
      providerOptions: { experimentalControl: true },
    }, runtime);

    await expect(agent.ready()).rejects.toBeInstanceOf(RequiredTransportUnavailableError);
    await expect(agent.ready()).rejects.toThrow(/codexAppServerV1/);
  });

  it('builds the plan without opening a thread or starting a turn', async () => {
    const adapter = new FakeAdapter('claude');
    adapter.execute = async () => {
      throw new Error('discovery must not start a turn');
    };
    const runtime = new Runtime({
      adapters: [adapter],
      controlAdapters: [claudeControlRegistration()],
    });
    const readiness = await new Agent({
      model: 'opus-5',
      providerOptions: { experimentalControl: true },
      capabilities: { processPersistence: 'required' },
    }, runtime).ready();

    expect(readiness.plan.transport).toBe('control');
  });
});

describe('executable identity pinning', () => {
  let workDir: string | undefined;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  async function makeExecutable(): Promise<string> {
    workDir = await mkdtemp(join(tmpdir(), 'oar-pin-'));
    const path = join(await realpath(workDir), 'fake-cli');
    await writeFile(path, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
    return path;
  }

  it.each(['1.0.0', '1.0.1'])('rechecks response controls when the binary changes to version %s', async version => {
    const path = await makeExecutable(), adapter = new FakeAdapter('claude', path);
    const help = '--print --output-format --model --session-id --verbose --system-prompt --safe-mode --tools --allowed-tools --strict-mcp-config --permission-mode dontAsk';
    let supported = true;
    adapter.compatibilityImpl = async () => assessCliCompatibility('claude', adapter.version, { main: supported ? help : help.replace('--safe-mode', '') });
    const agent = new Agent({ model: 'opus-5', instructions: 'Respond only.', context: { profile: 'clean' },
      permissions: { mode: 'respond' }, providerOptions: { claude: { tools: [], systemPromptMode: 'replace' } } }, new Runtime({ adapters: [adapter] }));
    await agent.send('first');
    supported = false; adapter.version = version;
    await writeFile(path, '#!/bin/sh\necho changed\n', { mode: 0o755 });
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    await expect(agent.send('second')).rejects.toThrow(UnsupportedCapabilityError);
    expect(adapter.requests).toHaveLength(1);
  });

  it('does not inherit subscription authentication from the replaced response binary', async () => {
    const path = await makeExecutable(), adapter = new FakeAdapter('claude', path);
    adapter.compatibilityImpl = async () => assessCliCompatibility('claude', adapter.version, { main:
      '--print --output-format --model --session-id --verbose --system-prompt --safe-mode --tools --allowed-tools --strict-mcp-config --permission-mode dontAsk' });
    const agent = new Agent({ model: 'opus-5', requireAuth: 'subscription', instructions: 'Respond only.', context: { profile: 'clean' },
      permissions: { mode: 'respond' }, providerOptions: { claude: { tools: [], systemPromptMode: 'replace' } } }, new Runtime({ adapters: [adapter] }));
    await agent.send('first'); adapter.authSource = 'api-key';
    await writeFile(path, '#!/bin/sh\necho changed auth\n', { mode: 0o755 });
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    await expect(agent.send('second')).rejects.toMatchObject({ code: 'UNEXPECTED_AUTH_SOURCE' });
    expect(adapter.requests).toHaveLength(1);
  });

  it('returns no pin for a path that does not resolve to a file', async () => {
    expect(await createExecutablePin(`/nonexistent/${randomUUID()}`)).toBeUndefined();
    expect(await createExecutablePin(undefined)).toBeUndefined();
  });

  it('records realpath and digest once and does not re-probe while identity holds', async () => {
    const path = await makeExecutable();
    const pin = await createExecutablePin(path, '1.0.0');
    expect(pin).toMatchObject({ realpath: expect.any(String), digest: expect.any(String) });

    const inner = new FakeAdapter('claude', path);
    let reprobes = 0;
    const pinned = new PinnedExecAdapter(inner, pin as ExecutablePin, async (_env, previous) => {
      reprobes += 1;
      return previous;
    });

    await pinned.execute(request(path));
    await pinned.execute(request(path));
    expect(reprobes).toBe(0);
    expect(inner.requests).toHaveLength(2);
  });

  it('re-probes instead of running under the old verdict when the executable changes', async () => {
    const path = await makeExecutable();
    const pin = await createExecutablePin(path, '1.0.0');
    const inner = new FakeAdapter('claude', path);
    let reprobes = 0;
    const pinned = new PinnedExecAdapter(inner, pin as ExecutablePin, async () => {
      reprobes += 1;
      const next = await createExecutablePin(path, '1.0.0');
      if (!next) throw new CliNotInstalledError('claude', { retryable: false });
      return next;
    });

    await pinned.execute(request(path));
    await writeFile(path, '#!/bin/sh\necho 2.0.0\n', { mode: 0o755 });
    await utimes(path, new Date(), new Date(Date.now() + 5_000));
    await pinned.execute(request(path));

    expect(reprobes).toBe(1);
    expect(inner.requests).toHaveLength(2);
    expect(pinned.pin.digest).not.toBe((pin as ExecutablePin).digest);
  });

  it('rehashes when the inode or ctime change and re-probes a same-size swap that restored mtime', async () => {
    const path = await makeExecutable();
    const fixed = new Date('2026-01-01T00:00:00Z');
    await utimes(path, fixed, fixed);
    const pin = await createExecutablePin(path, '1.0.0') as ExecutablePin;
    expect(pin).toMatchObject({ ino: expect.any(Number), ctimeMs: expect.any(Number) });
    const inner = new FakeAdapter('claude', path);
    const reprobed: string[] = [];
    const pinned = new PinnedExecAdapter(inner, pin, async (_env, previous) => {
      reprobed.push(previous.digest);
      const next = await createExecutablePin(path, '1.0.0');
      if (!next) throw new CliNotInstalledError('claude', { retryable: false });
      return next;
    });

    // Metadata-only change (ctime moves, bytes do not): rehash, same digest, no re-probe.
    await chmod(path, 0o700);
    await pinned.execute(request(path));
    expect(reprobed).toEqual([]);
    expect(pinned.pin.digest).toBe(pin.digest);

    // Replaced through rename with identical bytes and mtime (new inode): still the same binary.
    await writeFile(`${path}.next`, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
    await utimes(`${path}.next`, fixed, fixed);
    await rename(`${path}.next`, path);
    await pinned.execute(request(path));
    expect(reprobed).toEqual([]);

    // Same size, mtime put back: only the digest reveals the swap.
    await writeFile(path, '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
    await utimes(path, fixed, fixed);
    await pinned.execute(request(path));
    expect(reprobed).toEqual([pin.digest]);
    expect(pinned.pin.digest).not.toBe(pin.digest);
    expect(inner.requests).toHaveLength(3);
  });

  it('fails closed when the pinned executable disappears and re-probe cannot recover', async () => {
    const path = await makeExecutable();
    const pin = await createExecutablePin(path, '1.0.0');
    const pinned = new PinnedExecAdapter(new FakeAdapter('claude', path), pin as ExecutablePin, async () => {
      throw new CliNotInstalledError('claude', { retryable: false });
    });

    await rm(path);
    await expect(pinned.execute(request(path))).rejects.toBeInstanceOf(CliNotInstalledError);
  });

  it('pins the resolved binary into the Agent fingerprint and revalidates later turns', async () => {
    const path = await makeExecutable();
    const adapter = new FakeAdapter('claude', path);
    const runtime = new Runtime({ adapters: [adapter] });
    const agent = new Agent({ model: 'opus-5' }, runtime);

    const readiness = await agent.ready();
    expect(readiness.plan.fingerprint.executableRealpath).toBe(path);
    expect(readiness.plan.fingerprint.executableDigest).toMatch(/^[0-9a-f]{64}$/);
    const detectsAfterReady = adapter.detectCalls;

    await agent.send('first');
    await writeFile(path, '#!/bin/sh\necho 1.0.0 updated\n', { mode: 0o755 });
    await utimes(path, new Date(), new Date(Date.now() + 5_000));
    await agent.send('second');

    // The changed binary forced a re-probe before the second turn ran.
    expect(adapter.detectCalls).toBe(detectsAfterReady + 1);
    expect(adapter.requests.map(({ mode }) => mode)).toEqual(['open', 'resume']);
  });
});

function request(path: string): ExecTurnRequest {
  return {
    mode: 'open',
    modelId: 'claude-opus-5',
    cwd: process.cwd(),
    prompt: 'hello',
    env: { PATH: path },
    contextArgs: [],
    permissionArgs: [],
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  };
}
