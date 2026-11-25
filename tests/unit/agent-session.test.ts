import { realpath } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { assessCliCompatibility } from '../../src/compatibility/manifest.js';

import {
  AbortError,
  Agent,
  Runtime,
  SessionBusyError,
  SessionInterruptedError,
  SessionMismatchError,
  SessionNotFoundError,
  StructuredOutputError,
  UnsupportedCliVersionError,
  UnsupportedCapabilityError,
  UnknownModelError,
  UntrustedWorkspaceError,
  type ExecAdapter,
  type ExecTurnRequest,
  type ProtocolResult,
} from '../../src/index.js';

class FakeAdapter implements ExecAdapter {
  readonly id;
  readonly requests: ExecTurnRequest[] = [];
  executeImpl: (request: ExecTurnRequest) => Promise<ProtocolResult>;
  streamImpl: ExecAdapter['stream'] | undefined;
  compatibilityImpl: ExecAdapter['compatibility'];

  constructor(id: 'claude' | 'codex' = 'claude') {
    this.id = id;
    this.streamImpl = undefined;
    this.compatibilityImpl = undefined;
    this.executeImpl = async (request) => success(
      request.mode === 'fork' ? 'forked-id' : request.sessionId ?? `${id}-session`,
    );
  }

  async detect() {
    return { installed: true, path: `/bin/${this.id}`, version: '1.0.0' };
  }

  async auth() {
    return { authenticated: true, source: 'subscription' as const };
  }

  async models() {
    return [];
  }

  async compatibility(env: NodeJS.ProcessEnv, version: string) {
    return this.compatibilityImpl?.(env, version);
  }

  async execute(request: ExecTurnRequest) {
    this.requests.push(request);
    return this.executeImpl(request);
  }

  async *stream(request: ExecTurnRequest) {
    this.requests.push(request);
    if (this.streamImpl) {
      yield* this.streamImpl(request);
      return;
    }
    yield { kind: 'result' as const, result: await this.executeImpl(request) };
  }
}

function success(sessionId: string, overrides: Partial<ProtocolResult> = {}): ProtocolResult {
  return {
    completed: true,
    failed: false,
    refused: false,
    sessionId,
    text: 'ok',
    events: [{ type: 'message.completed', text: 'ok' }],
    nativeEvents: [],
    ...overrides,
  };
}

function setup() {
  const claude = new FakeAdapter('claude');
  const codex = new FakeAdapter('codex');
  const runtime = new Runtime({ adapters: [claude, codex] });
  return { claude, codex, runtime };
}

describe('Agent and Session', () => {
  it('keeps response authority immutable after readiness and rejects incompatible controls before a turn', async () => {
    const { claude, runtime } = setup();
    claude.compatibilityImpl = async () => assessCliCompatibility('claude', '2.1.228', { main:
      '--print --output-format --model --session-id --verbose --system-prompt --safe-mode --tools --allowed-tools --strict-mcp-config --permission-mode dontAsk' });
    const tools: string[] = [];
    const options = { model: 'opus-5', transport: 'exec' as const, instructions: 'Answer only.',
      permissions: { mode: 'respond' as const }, context: { profile: 'clean' as const },
      providerOptions: { claude: { tools, systemPromptMode: 'replace' as const } } };
    const agent = new Agent(options, runtime);
    await agent.ready();
    tools.push('Bash');
    await agent.send('Deliver the answer');
    expect(claude.requests[0]?.providerOptions?.tools).toEqual([]);
    expect(claude.requests[0]?.permissionArgs).toContain('dontAsk');
    await expect(new Agent(options, runtime).send('bad boundary')).rejects.toThrow(UnsupportedCapabilityError);
    expect(claude.requests).toHaveLength(1);
  });
  it('returns a fingerprinted negotiated plan and never treats unknown as supported', async () => {
    const { runtime } = setup();
    const readiness = await new Agent({ model: 'opus-5' }, runtime).ready();

    expect(readiness.plan).toMatchObject({
      provider: 'claude',
      transport: 'exec',
      fingerprint: {
        cliVersion: '1.0.0',
        executableRealpath: '/bin/claude',
      },
      capabilities: {
        steering: { support: 'none' },
        turns: { support: 'unknown' },
      },
    });
  });

  it('compiles the permission intent into an envelope with mode ceiling and model allowlist', async () => {
    const { runtime } = setup();
    const readiness = await new Agent(
      { model: 'opus-5', permissions: { mode: 'edit' } },
      runtime,
    ).ready();

    expect(readiness.plan.envelope).toMatchObject({
      permissionModeCeiling: 'acceptEdits',
      modelAllowlist: ['claude-opus-5'],
    });

    const analyze = await new Agent({ model: 'opus-5' }, new Runtime({ adapters: [new FakeAdapter('claude')] })).ready();
    expect(analyze.plan.envelope.permissionModeCeiling).toBe('plan');
  });

  it('fails readiness closed when a required capability is only unknown on exec', async () => {
    const { runtime } = setup();
    const agent = new Agent(
      { model: 'opus-5', capabilities: { messageDeltas: 'required' } },
      runtime,
    );

    await expect(agent.ready()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('satisfies a required capability once compatibility evidence verifies it', async () => {
    const { claude, runtime } = setup();
    claude.compatibilityImpl = async () => ({
      provider: 'claude',
      cliVersion: '1.0.0',
      transport: 'exec',
      evidence: 'live-contract',
      features: { turns: 'supported', tokenDeltas: 'supported' },
      missingFlags: [],
      knownIssues: [],
    });
    const readiness = await new Agent(
      { model: 'opus-5', capabilities: { messageDeltas: 'required' } },
      runtime,
    ).ready();

    expect(readiness.plan.capabilities.messageDeltas).toMatchObject({ support: 'full' });
  });

  it('represents an exec session as pending until the provider confirms its native id', async () => {
    const { runtime } = setup();
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();

    expect(session.ref).toBeUndefined();
    expect(() => session.export()).toThrow(SessionNotFoundError);
    await expect(session.forkAndSend('branch')).rejects.toBeInstanceOf(SessionNotFoundError);

    const turn = await session.send('create');
    expect(session.ref).toEqual(turn.session);
  });

  it('fails readiness before inference when required CLI flags are absent', async () => {
    const { claude, runtime } = setup();
    claude.compatibilityImpl = async () => ({
      provider: 'claude',
      cliVersion: '1.0.0',
      transport: 'exec',
      evidence: 'help-probe',
      features: { turns: 'unsupported' },
      missingFlags: ['--output-format'],
      knownIssues: [],
    });

    await expect(new Agent({ model: 'opus-5' }, runtime).ready())
      .rejects.toBeInstanceOf(UnsupportedCliVersionError);
    expect(claude.requests).toHaveLength(0);
  });

  it('gates optional operations from observed CLI features', async () => {
    const { claude, runtime } = setup();
    claude.compatibilityImpl = async () => ({
      provider: 'claude',
      cliVersion: '1.0.0',
      transport: 'exec',
      evidence: 'help-probe',
      features: {
        turns: 'unverified',
        resume: 'unverified',
        forkWithPrompt: 'unsupported',
        structuredOutput: 'unsupported',
      },
      missingFlags: ['--fork-session', '--json-schema'],
      knownIssues: [],
    });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await session.send('create');

    await expect(session.forkAndSend('branch')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(session.send('json', { outputSchema: { type: 'object' } }))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(claude.requests).toHaveLength(1);
  });

  it('opens the implicit session lazily and resumes its native transcript', async () => {
    const { claude, runtime } = setup();
    const agent = new Agent({ model: 'opus-5' }, runtime);

    await agent.send('first');
    await agent.send('second');

    expect(claude.requests.map(({ mode }) => mode)).toEqual(['open', 'resume']);
    expect(claude.requests[1]?.sessionId).toBe('claude-session');
  });

  it('runs one-shot turns without replacing the implicit session', async () => {
    const { claude, runtime } = setup();
    const agent = new Agent({ model: 'opus-5' }, runtime);

    await agent.send('first');
    await agent.run('isolated');
    await agent.send('second');

    expect(claude.requests.map(({ mode }) => mode)).toEqual(['open', 'one-shot', 'resume']);
    expect(claude.requests[2]?.sessionId).toBe('claude-session');
  });

  it('rejects concurrent turns on one session instead of queueing', async () => {
    const { claude, runtime } = setup();
    let release!: (value: ProtocolResult) => void;
    claude.executeImpl = async () => new Promise((resolve) => { release = resolve; });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();

    const first = session.send('first');
    await expect(session.send('second')).rejects.toBeInstanceOf(SessionBusyError);
    release(success('session-id'));
    await first;
  });

  it('reserves the session synchronously when start returns an eager handle', async () => {
    const { claude, runtime } = setup();
    let release!: (value: ProtocolResult) => void;
    claude.executeImpl = async () => new Promise((resolve) => { release = resolve; });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();

    const first = session.start('first');
    expect(() => session.start('second')).toThrow(SessionBusyError);
    await expect(first.respond('missing', { kind: 'approval', decision: 'deny' }))
      .rejects.toBeInstanceOf(UnsupportedCapabilityError);
    release(success('session-id', { turnId: 'turn-1' }));

    await expect(first.turnId).resolves.toBe('turn-1');
    await expect(first.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('uses the same lazy implicit session for concurrent send calls', async () => {
    const { claude, runtime } = setup();
    let release!: (value: ProtocolResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    claude.executeImpl = async () => new Promise((resolve) => {
      release = resolve;
      markStarted();
    });
    const agent = new Agent({ model: 'opus-5' }, runtime);

    const first = agent.send('first');
    await expect(agent.send('second')).rejects.toBeInstanceOf(SessionBusyError);
    await started;
    release(success('session-id'));
    await first;
  });

  it('reserves an implicit Agent turn before asynchronous session opening', async () => {
    const { claude, runtime } = setup();
    let release!: (value: ProtocolResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    claude.executeImpl = async () => new Promise((resolve) => {
      release = resolve;
      markStarted();
    });
    const agent = new Agent({ model: 'opus-5' }, runtime);

    const first = agent.start('first');
    expect(() => agent.start('second')).toThrow(SessionBusyError);
    await started;
    release(success('session-id'));
    await expect(first.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('emits events before the provider process reaches its terminal result', async () => {
    const adapter = new FakeAdapter('claude');
    let release!: () => void;
    adapter.streamImpl = async function* () {
      yield { kind: 'session' as const, sessionId: 'stream-session' };
      yield { kind: 'event' as const, event: { type: 'message.delta' as const, text: 'partial' } };
      await new Promise<void>((resolve) => { release = resolve; });
      yield { kind: 'result' as const, result: success('stream-session', { text: 'partial done' }) };
    };
    const runtime = new Runtime({ adapters: [adapter] });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    const iterator = session.stream('stream')[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session.started' },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'message.delta', text: 'partial' },
      done: false,
    });
    const terminal = iterator.next();
    await expect(session.send('concurrent')).rejects.toBeInstanceOf(SessionBusyError);
    release();
    await expect(terminal).resolves.toMatchObject({
      value: { type: 'turn.completed' },
      done: false,
    });
  });

  it('aborts an abandoned stream and keeps its unconfirmed session unknown', async () => {
    const adapter = new FakeAdapter('claude');
    let aborted = false;
    adapter.streamImpl = async function* (request) {
      request.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      yield { kind: 'session' as const, sessionId: 'stream-session' };
      await new Promise(() => {});
    };
    const runtime = new Runtime({ adapters: [adapter] });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    const iterator = session.stream('stream')[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.();

    expect(aborted).toBe(true);
    expect(session.state).toBe('unknown');
    await expect(session.send('unsafe reuse')).rejects.toBeInstanceOf(SessionInterruptedError);
  });

  it('exports a confirmed ref and resumes it after a new Agent instance', async () => {
    const { runtime } = setup();
    const first = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await first.send('create');
    const ref = first.export();
    expect(first.identity).toMatchObject({
      id: ref.id,
      persistence: 'provider',
      transportEpoch: expect.any(String),
    });
    const resumed = await new Agent({ model: 'opus-5' }, runtime).openSession({ resume: ref });

    await resumed.send('continue');
    expect(resumed.ref).toEqual(ref);
  });

  it('records the model in SessionRef and warns when resume changes it', async () => {
    const { runtime } = setup();
    const source = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await source.send('create');
    const ref = source.export();
    expect(ref.model).toBe('claude-opus-5');

    const changed = await new Agent({ model: 'sonnet-5' }, runtime).openSession({ resume: ref });
    const turn = await changed.send('continue');
    expect(turn.warnings).toContainEqual(expect.objectContaining({ code: 'SESSION_MODEL_CHANGED' }));
  });

  it('rejects resume when provider or cwd do not match', async () => {
    const { runtime } = setup();
    const cwd = await realpath(process.cwd());
    const agent = new Agent({ model: 'opus-5' }, runtime);

    await expect(agent.openSession({
      resume: {
        schemaVersion: 1,
        provider: 'codex',
        id: 'wrong',
        cwd,
        transport: 'exec',
        persistence: 'provider',
        createdAt: new Date().toISOString(),
      },
    })).rejects.toBeInstanceOf(SessionMismatchError);
  });

  it('forks provider history with an explicit first turn and confirms a distinct child id', async () => {
    const { claude, runtime } = setup();
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await session.send('create');
    const fork = await session.forkAndSend('branch prompt');

    expect(claude.requests.at(-1)?.mode).toBe('fork');
    expect(claude.requests.at(-1)?.prompt).toBe('branch prompt');
    expect(fork.session.ref?.id).toBe('forked-id');
    expect(fork.session.ref?.id).not.toBe(session.ref?.id);
    expect(fork.turn.status).toBe('completed');
  });

  it('forkAndStart returns a settled handle whose child survives a failed first turn', async () => {
    const { claude, runtime } = setup();
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await session.send('create');
    const fork = await session.forkAndStart('branch prompt');

    expect(fork.session.ref?.id).toBe('forked-id');
    const turn = await fork.turn.result;
    expect(turn.status).toBe('completed');
    expect(await fork.turn.turnId).toBe(turn.id);
    // Un turn ya resuelto no puede recibir steering ni respuestas de interacción.
    expect(fork.turn.steer).toBeUndefined();
    await expect(fork.turn.respond('any', { kind: 'approval', decision: 'allow' }))
      .rejects.toBeTruthy();
    expect((await fork.turn.interrupt()).requested).toBe(false);
    expect(claude.requests.at(-1)?.mode).toBe('fork');
  });

  it('separates fork-with-prompt from promptless fork verdicts', async () => {
    const { claude, runtime } = setup();
    claude.compatibilityImpl = async () => ({
      provider: 'claude',
      cliVersion: '2.1.251',
      transport: 'exec',
      evidence: 'live-contract',
      features: { turns: 'supported', forkWithPrompt: 'supported', forkWithoutPrompt: 'unsupported' },
      missingFlags: [],
      knownIssues: [],
    });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await session.send('create');

    // El veredicto promptless no bloquea el fork con prompt, que ambos CLIs soportan.
    await expect(session.forkAndSend('branch prompt')).resolves.toMatchObject({
      turn: { status: 'completed' },
    });
  });

  it('rejects fork when the installed CLI cannot fork with a prompt', async () => {
    const { claude, runtime } = setup();
    claude.compatibilityImpl = async () => ({
      provider: 'claude',
      cliVersion: '1.0.0',
      transport: 'exec',
      evidence: 'help-probe',
      features: { turns: 'supported', forkWithPrompt: 'unsupported' },
      missingFlags: ['--fork-session'],
      knownIssues: [],
    });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await session.send('create');

    await expect(session.forkAndSend('branch prompt')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('marks an aborted session interrupted', async () => {
    const { claude, runtime } = setup();
    claude.executeImpl = async () => {
      throw new AbortError({ retryable: true });
    };
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();

    await expect(session.send('stop')).rejects.toBeInstanceOf(AbortError);
    expect(session.state).toBe('interrupted');
  });

  it('requires explicit reconciliation before resuming an interrupted session', async () => {
    const { claude, runtime } = setup();
    let calls = 0;
    claude.executeImpl = async (request) => {
      calls += 1;
      if (calls === 2) throw new AbortError({ retryable: true });
      return success(request.sessionId ?? 'recoverable-session');
    };
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
    await session.send('establish');
    await expect(session.send('interrupt')).rejects.toBeInstanceOf(AbortError);
    expect(session.state).toBe('interrupted');

    await expect(session.send('recover')).rejects.toBeInstanceOf(SessionInterruptedError);
    await expect(session.reconcile()).resolves.toBe('idle');
    await expect(session.send('recover')).resolves.toMatchObject({ status: 'completed' });
    expect(claude.requests.at(-1)).toMatchObject({
      mode: 'resume',
      sessionId: 'recoverable-session',
    });
  });

  it.each([
    ['unknown-model', UnknownModelError],
    ['untrusted-workspace', UntrustedWorkspaceError],
  ] as const)('maps %s provider failures to a typed public error', async (kind, ErrorType) => {
    const { claude, runtime } = setup();
    claude.executeImpl = async () => success('failed-session', {
      completed: false,
      failed: true,
      failure: { kind, message: kind },
    });
    const session = await new Agent({ model: 'opus-5' }, runtime).openSession();

    await expect(session.send('fail')).rejects.toBeInstanceOf(ErrorType);
  });

  it('validates structured output after the provider completes', async () => {
    const { claude, runtime } = setup();
    claude.executeImpl = async () => success('session', { output: { count: 'wrong' } });
    const agent = new Agent({ model: 'opus-5' }, runtime);

    await expect(agent.run('json', {
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
    })).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it.each(['send', 'stream'] as const)('preserves observed usage in %s schema failures, including zero but never invented usage', async (mode) => {
    for (const usage of [undefined, { inputTokens: 0, outputTokens: 0, costMeaning: 'unavailable' as const },
      { inputTokens: 1000, outputTokens: 200, costMeaning: 'provider-reported' as const, reportedCostUsd: 0.1,
        perModel: { 'claude-opus-5': { inputTokens: 1000, outputTokens: 200 } } }]) {
      const { claude, runtime } = setup();
      claude.executeImpl = async () => success('session', { output: { count: 'wrong' }, ...(usage ? { usage } : {}) });
      const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
      const options = { outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } };
      const events: unknown[] = [];
      const execute = async () => {
        if (mode === 'send') await session.send('json', options);
        else for await (const event of session.stream('json', options)) events.push(event);
      };
      try { await execute(); expect.fail('schema must reject'); }
      catch (error) {
        expect(error).toBeInstanceOf(StructuredOutputError);
        if (!(error instanceof StructuredOutputError)) throw error;
        expect(error.context.observedUsage).toEqual(usage);
        expect(Object.hasOwn(error.context, 'observedUsage')).toBe(usage !== undefined);
        expect(error.context.sanitizedDiagnostics).toMatchObject({ originalResponse: { count: 'wrong' } });
      }
      expect(events.filter(event => event && typeof event === 'object' && 'type' in event && event.type === 'turn.completed')).toHaveLength(0);
      expect(claude.requests).toHaveLength(1);
    }
  });

  it('does not serialize native provider payloads into a Turn by default', async () => {
    const { claude, runtime } = setup();
    claude.executeImpl = async () => success('session', {
      nativeEvents: [{ prompt: 'TOP_SECRET_PROMPT' }],
      terminalEvent: { result: 'TOP_SECRET_RESPONSE' },
    });

    const turn = await new Agent({ model: 'opus-5' }, runtime).send('run');

    expect(JSON.stringify(turn)).not.toContain('TOP_SECRET');
    expect(turn.providerMetadata).toEqual({ nativeEventCount: 1, terminalEventPresent: true });
  });

  it('rejects an invalid schema before launching the provider', async () => {
    const { claude, runtime } = setup();
    const agent = new Agent({ model: 'opus-5' }, runtime);

    await expect(agent.run('json', { outputSchema: { type: 'not-a-json-schema-type' } }))
      .rejects.toBeInstanceOf(StructuredOutputError);
    expect(claude.requests).toHaveLength(0);
  });
});

describe('Agent opening budget', () => {
  it('counts readiness in send timeout and never sends after late readiness', async () => {
    const {claude,runtime}=setup();
    let resolve!:()=>void;
    claude.auth=async()=>{await new Promise<void>((done)=>{resolve=done;});return {authenticated:true,source:'subscription'};};
    const agent=new Agent({model:'opus-5'},runtime);
    await expect(agent.send('late',{timeoutMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
    resolve();
    await new Promise((done)=>setTimeout(done,5));
    expect(claude.requests).toHaveLength(0);
  });
  it('counts readiness in one-shot timeout', async () => {
    const {claude,runtime}=setup();
    claude.auth=async()=>new Promise(()=>{});
    await expect(new Agent({model:'opus-5'},runtime).run('late',{timeoutMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
  });
});

describe('fork turn options', () => {
  it('forwards timeout and structured schema into a native fork', async () => {
    const {claude,runtime}=setup();const agent=new Agent({model:'opus-5'},runtime);const session=await agent.openSession();
    await session.send('parent');
    const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok']};
    claude.executeImpl=async()=>success('fork',{output:{ok:true}});
    const fork=await session.forkAndSend('branch',{timeoutMs:100,outputSchema:schema});
    expect(claude.requests.at(-1)).toMatchObject({mode:'fork',outputSchema:schema});
    expect(claude.requests.at(-1)!.timeoutMs).toBeLessThanOrEqual(100);
    expect(fork.turn.output).toEqual({ok:true});
  });
});
it('returns an exec fork after identity, before its stream terminal', async () => {
  const {claude,runtime}=setup();const session=await new Agent({model:'opus-5'},runtime).openSession();
  await session.send('parent');
  let finish!:()=>void;
  claude.streamImpl=async function*(){yield {kind:'session',sessionId:'stream-child'};yield {kind:'event',event:{type:'message.delta',text:'live'}};await new Promise<void>((resolve)=>{finish=resolve;});yield {kind:'result',result:success('stream-child')};};
  const fork=await session.startFork('branch',{timeoutMs:1000});
  expect(fork.session.export().id).toBe('stream-child');
  await expect(fork.session.send('overlap')).rejects.toMatchObject({code:'SESSION_BUSY'});
  const first=await fork.turn.events[Symbol.asyncIterator]().next();expect(first.value).toMatchObject({type:'message.delta',text:'live'});
  finish();await expect(fork.turn.result).resolves.toMatchObject({status:'completed'});
});
it('bounds noncooperative exec turns and refuses reuse until unresolved work is replaced', async () => {
  const {claude,runtime}=setup();const session=await new Agent({model:'opus-5'},runtime).openSession();
  claude.executeImpl=()=>new Promise(()=>{});
  await expect(session.send('hang',{timeoutMs:15})).rejects.toMatchObject({code:'TIMEOUT'});
  expect(session.state).toBe('unknown');
  await session.reconcile();
  await expect(session.send('overlap')).rejects.toMatchObject({code:'SESSION_INTERRUPTED'});
});
it('bounds a noncooperative exec stream and marks its session unknown', async () => {
 const {claude,runtime}=setup();const session=await new Agent({model:'opus-5'},runtime).openSession();
 claude.streamImpl=async function*(){await new Promise(()=>{});};
 const consume=(async()=>{for await(const _event of session.stream('hang',{timeoutMs:15})) { /* consume */ }})();
 await expect(consume).rejects.toMatchObject({code:'TIMEOUT'});expect(session.state).toBe('unknown');
});
it('keeps Agent.stream on the native streaming channel and aborts abandoned observation', async () => {
 const {claude,runtime}=setup();let aborted=false;
 claude.streamImpl=async function*(request){request.signal?.addEventListener('abort',()=>{aborted=true;},{once:true});yield {kind:'session',sessionId:'native-stream'};await new Promise(()=>{});};
 const agent=new Agent({model:'opus-5'},runtime);const iterator=agent.stream('stream')[Symbol.asyncIterator]();
 expect((await iterator.next()).value).toMatchObject({type:'session.started',session:{id:'native-stream'}});
 await iterator.return?.();expect(aborted).toBe(true);
});

it('returns the native exec iterator so provider finally cleanup runs after an early break', async () => {
  const { claude, runtime } = setup();
  let cleaned = false;
  claude.streamImpl = async function* () {
    try {
      yield { kind: 'session', sessionId: 'cleanup-session' };
      await new Promise(() => {});
    } finally { cleaned = true; }
  };
  const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
  for await (const event of session.stream('stream')) {
    expect(event.type).toBe('session.started');
    break;
  }
  expect(cleaned).toBe(true);
  expect(session.state).toBe('unknown');
});

it('bounds native iterator cleanup that ignores cancellation and preserves unknown state', async () => {
  const { claude, runtime } = setup();
  let cleanupStarted = false;
  let finishCleanup!: () => void;
  claude.streamImpl = async function* () {
    try { yield { kind: 'session', sessionId: 'hung-cleanup-session' }; }
    finally {
      cleanupStarted = true;
      await new Promise<void>((resolve) => { finishCleanup = resolve; });
    }
  };
  const session = await new Agent({ model: 'opus-5' }, runtime).openSession();
  for await (const _event of session.stream('stream', { timeoutMs: 30 })) break;
  expect(cleanupStarted).toBe(true);
  expect(session.state).toBe('unknown');
  await expect(session.send('unsafe reuse')).rejects.toBeInstanceOf(SessionInterruptedError);
  finishCleanup();
});
