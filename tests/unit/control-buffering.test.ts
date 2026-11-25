import { mkdtemp, open, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/public/agent.js';
import { Runtime } from '../../src/core/runtime.js';
import { createCodexControlRegistration, type CodexTransportStartOptions, type CodexControlTransport } from '../../src/adapters/codex-control/factory.js';
import { createClaudeControlRegistration } from '../../src/adapters/claude-control/factory.js';
import type { ClaudeAgentSdk, SdkCanUseTool, SdkQuery } from '../../src/adapters/claude-control/sdk.js';
import type { ControlBufferLimits } from '../../src/control/event-spool.js';
import type { AgentEvent, InteractionRequest } from '../../src/public/types.js';
import type { ControlSessionHandle } from '../../src/session/control-session.js';
import type { Session } from '../../src/session/session.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), realpath: vi.fn(original.realpath) };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class CodexFixture implements CodexControlTransport {
  hooks!: CodexTransportStartOptions;
  readonly finished = deferred<void>(); startGate: Promise<void> | undefined; readonly interruptRequests: unknown[] = []; failure: unknown; startError: Error | undefined; wire: unknown; turns = 0; interrupts = 0; interrupted = false;
  constructor(readonly count: number, readonly approval: boolean, readonly text: (index: number) => string) {}
  async request(method: string, params?: unknown): Promise<unknown> {
    if (method === 'thread/start') return { threadId: 'thread-1' };
    if (method === 'turn/start') {
      this.turns++;
      queueMicrotask(() => { void this.run().catch(error => { this.failure = error; }).finally(() => this.finished.resolve()); });
      await this.startGate; if (this.startError) throw this.startError; return { turnId: 'turn-1' };
    }
    if (method === 'turn/interrupt') {
      this.interruptRequests.push(params); this.interrupts++; this.interrupted = true;
      queueMicrotask(() => this.hooks.onNotification('turn/interrupted', { threadId: 'thread-1', turnId: 'turn-1' }));
    }
    return {};
  }
  async run(): Promise<void> {
    this.hooks.onNotification('turn/started', { threadId: 'thread-1', turnId: 'turn-1' });
    for (let index = 0; index < this.count && !this.interrupted; index++) this.hooks.onNotification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: this.text(index),
    });
    if (this.interrupted) return;
    if (this.approval) this.wire = await this.hooks.onServerRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'tool-1', command: ['fixture'], cwd: '/tmp',
    }, 1);
    this.hooks.onNotification('item/completed', { threadId: 'thread-1', item: { id: 'item-1', type: 'agent_message', text: 'done' } });
    this.hooks.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', usage: { input_tokens: 3, output_tokens: 4 } } });
  }
  async close(): Promise<void> {}
}
class ClaudeFixture implements ClaudeAgentSdk {
  queryGate: Promise<void> | undefined; queryEnd: 'eof' | 'error' | undefined; beforeTerminal: (() => void) | undefined;
  readonly finished = deferred<void>(); canUseTool: SdkCanUseTool | undefined; wire: unknown; turns = 0; queries = 0; interrupts = 0; failure: unknown; interrupted = false;
  constructor(readonly count: number, readonly approval: boolean, readonly text: (index: number) => string) {}
  query: ClaudeAgentSdk['query'] = ({ prompt, options }) => {
    const fixture = this; this.queries++; this.canUseTool = options?.canUseTool;
    const iterable = (async function* () {
      for await (const _message of prompt) {
        fixture.turns++;
        try {
          yield { type: 'system', subtype: 'init', session_id: 'native-1' };
          for (let index = 0; index < fixture.count && !fixture.interrupted; index++) yield { type: 'stream_event', event: { delta: { text: fixture.text(index) } } };
          if (fixture.approval && !fixture.interrupted) fixture.wire = await options!.canUseTool!('Read', { path: 'fixture' }, { signal: new AbortController().signal });
          fixture.beforeTerminal?.();
          yield { type: 'result', subtype: 'success', session_id: 'native-1', result: 'done', usage: { input_tokens: 3, output_tokens: 4 } };
        } catch (error) { fixture.failure = error; throw error; }
        finally { fixture.finished.resolve(); }
        await fixture.queryGate;
        if (fixture.queryEnd === 'eof') return;
        if (fixture.queryEnd === 'error') throw new Error('fixture query died between turns');
      }
    })();
    return Object.assign(iterable, { interrupt: async () => { fixture.interrupts++; fixture.interrupted = true; },
      setPermissionMode: async () => undefined, setModel: async () => undefined }) as SdkQuery;
  };
}

describe.each(['claude', 'codex'] as const)('%s primary control buffering', id => {
  let directory: string; const sessions: Session[] = [];
  beforeEach(async () => {
    vi.mocked(open).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open);
    vi.mocked(realpath).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath);
    directory = await mkdtemp(join(tmpdir(), 'oar-control-buffering-')); });
  afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); await rm(directory, { recursive: true, force: true }); });
  async function setup(count = 1800, approval = false, buffering: ControlBufferLimits = {}, text = (index: number) => `${index};`) {
    const fixture = id === 'codex' ? new CodexFixture(count, approval, text) : new ClaudeFixture(count, approval, text);
    const registration = fixture instanceof CodexFixture
      ? createCodexControlRegistration({ buffering: { directory, ...buffering }, startTransport: async hooks => { fixture.hooks = hooks; return fixture; } })
      : createClaudeControlRegistration({ sdk: fixture, buffering: { directory, ...buffering } });
    let control!: ControlSessionHandle;
    const createSession = registration.createSession!;
    registration.createSession = async request => { control = await createSession(request); return control; };
    const runtime = new Runtime({ adapters: [{ id, detect: async () => ({ installed: true }), auth: async () => ({ authenticated: true, source: 'subscription' }),
      models: async () => [], execute: async () => { throw new Error('No exec/provider process in this fixture'); } }], controlAdapters: [registration] });
    const session = await new Agent({ model: id === 'claude' ? 'claude-opus-5' : 'gpt-5.2-codex', transport: 'control', cwd: directory,
      environment: { mode: 'explicit', variables: { HOME: directory, PATH: directory } }, providerOptions: { experimentalControl: true } }, runtime).openSession();
    sessions.push(session); return { session, fixture, control };
  }
  it('delivers 5000 ordered events and services an approval and terminal while the UI is paused', async () => {
    const { session, fixture } = await setup(5000, true);
    let live: InteractionRequest | undefined;
    const iterator = session.stream('fixture', { onInteraction: async request => { live = request; return { kind: 'approval', decision: request.availableDecisions.includes('deny') ? 'deny' : 'decline' }; } })[Symbol.asyncIterator]();
    const first = await iterator.next(); await fixture.finished.promise;
    expect(fixture.failure).toBeUndefined(); expect(fixture.wire).toBeDefined();
    const events: AgentEvent[] = first.done ? [] : [first.value];
    for (;;) { const step = await iterator.next(); if (step.done) break; events.push(step.value); }
    expect(events.filter(event => event.type === 'message.delta').map(event => event.text)).toEqual(Array.from({ length: 5000 }, (_, index) => `${index};`));
    const interaction = events.find(event => event.type === 'interaction.requested');
    expect(interaction?.request.signal).toBe(live?.signal);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', turn: { text: 'done', usage: { inputTokens: 3, outputTokens: 4 } } });
    expect(await readdir(directory)).toEqual([]);
  }, 15_000); // 5000 disk-backed events also run under the full parallel fixture suite.
  it('fails typed and interrupts only the affected turn when its unread byte cap is reached', async () => {
    const { session, fixture } = await setup(1000, false, { maxPublicBytes: 1024 }, () => 'x'.repeat(300));
    await expect(session.send('fixture')).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(fixture.interrupts).toBeGreaterThan(0);
    await session.close(); expect(await readdir(directory)).toEqual([]);
  });
  it('denies late native approvals after a buffer failure without retaining new broker work', async () => {
    const { session, fixture } = await setup(1000, false, { maxPublicBytes: 1024 }, () => 'x'.repeat(300));
    let calls = 0;
    await expect(session.send('fixture', { onInteraction: async () => { calls++; return { kind: 'approval', decision: 'deny' }; } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    const wire = fixture instanceof CodexFixture
      ? fixture.hooks.onServerRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'late', command: ['fixture'], cwd: '/tmp' }, 9)
      : fixture.canUseTool!('Read', { path: 'late' }, { signal: new AbortController().signal });
    let late: unknown;
    void wire.then(result => { late = result; }, error => { late = error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(late).toMatchObject(fixture instanceof CodexFixture ? { decision: 'decline' } : { behavior: 'deny' });
    expect(calls).toBe(0);
  });
  it('cleans a primary wrapper return after its bounded native drain or close', async () => {
    const { session } = await setup(1800);
    const iterator = session.stream('fixture')[Symbol.asyncIterator](); await iterator.next(); await iterator.return?.();
    // Session's 1s cancellation grace may return before its native drain disposes files.
    if (id === 'claude') await expect(session.reconcile()).resolves.toBe('idle');
    else await session.close();
    expect(await readdir(directory)).toEqual([]);
  }, 15_000);
  it('observes a disk write failure while approval and public consumption are paused', async () => {
    const cause = Object.assign(new Error('fixture spool disk failure'), { code: 'EIO' });
    const { session, fixture } = await setup(10, true);
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const failed = deferred<void>(), delivered = deferred<void>();
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('.segment') && flags === 'wx') { await delivered.promise; failed.resolve(); throw cause; }
      return original.open(path, flags, mode);
    });
    const iterator = session.stream('fixture', { onInteraction: async () => { delivered.resolve(); return new Promise(() => {}); } })[Symbol.asyncIterator]();
    // Claude's first session event itself needs disk delivery, so observe its rejection now.
    const first = iterator.next(); void first.catch(() => undefined);
    await delivered.promise; await failed.promise; await fixture.finished.promise;
    expect(fixture.wire).toBeDefined(); expect(fixture.interrupts).toBeGreaterThan(0);
    await expect((async () => { await first; for (;;) { if ((await iterator.next()).done) return; } })()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', cause });
    await session.close(); expect(await readdir(directory)).toEqual([]);
  });
  it('disposes a direct adapter iterator on early return and cannot reuse its abandoned output', async () => {
    const { control, fixture } = await setup(1800);
    const turn = await control.startTurn({ input: 'fixture' });
    const iterator = turn.stream[Symbol.asyncIterator]();
    await iterator.next(); await iterator.return?.();
    expect(fixture.interrupts).toBeGreaterThan(0);
    expect(await readdir(directory)).toEqual([]);
    const next = (async () => { const turn = await control.startTurn({ input: 'must not launch' }); await turn.stream[Symbol.asyncIterator]().next(); })();
    await expect(next).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(fixture.turns).toBe(1);
  });
  it('cleans each completed turn before publishing completion and reuses a fresh buffer', async () => {
    const { session } = await setup(12);
    for (const input of ['first', 'second']) {
      const iterator = session.stream(input)[Symbol.asyncIterator]();
      for (;;) {
        const step = await iterator.next();
        expect(step.done).toBe(false);
        if (step.value?.type === 'turn.completed') break;
      }
      expect(await readdir(directory)).toEqual([]);
      await iterator.return?.();
    }
  });
  if (id === 'claude') it.each([['eof', 'idle'], ['error', 'idle'], ['eof', 'paused'], ['error', 'paused']] as const)('remembers query %s with %s output and rejects the next prompt before submission', async (queryEnd, timing) => {
    const { session, fixture } = await setup(1);
    if (!(fixture instanceof ClaudeFixture)) throw new Error('Claude fixture required');
    const idle = deferred<void>(); fixture.queryGate = idle.promise;
    const iterator = timing === 'paused' ? session.stream('first')[Symbol.asyncIterator]() : undefined;
    if (iterator) { await iterator.next(); await fixture.finished.promise; }
    else await expect(session.send('first')).resolves.toMatchObject({ text: 'done' });
    fixture.queryEnd = queryEnd; idle.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    if (iterator) {
      const events = []; for (;;) { const step = await iterator.next(); if (step.done) break; events.push(step.value); }
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed', turn: { text: 'done' } });
    }
    await expect(session.send('must not submit', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(fixture.turns).toBe(1); expect(fixture.queries).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });
  if (id === 'claude') it('retires pending and late approvals at the native terminal before UI drainage', async () => {
    const { session, fixture } = await setup(12);
    if (!(fixture instanceof ClaudeFixture)) throw new Error('Claude fixture required');
    const answer = deferred<{ kind: 'approval'; decision: string }>(); let live: InteractionRequest | undefined, calls = 0;
    let wire!: ReturnType<SdkCanUseTool>;
    fixture.beforeTerminal = () => { wire = fixture.canUseTool!('Read', { path: 'detached' }, { signal: new AbortController().signal }); };
    const iterator = session.stream('first', { onInteraction: request => { calls++; live = request; return answer.promise; } })[Symbol.asyncIterator]();
    await iterator.next(); await fixture.finished.promise;
    try {
      expect(live?.signal.aborted).toBe(true);
      await expect(wire).resolves.toMatchObject({ behavior: 'deny' });
      await expect(fixture.canUseTool!('Read', { path: 'late' }, { signal: new AbortController().signal })).resolves.toMatchObject({ behavior: 'deny' });
      expect(calls).toBe(1);
      await expect(session.send('overlap')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      const events = []; for (;;) { const step = await iterator.next(); if (step.done) break; events.push(step.value); }
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed', turn: { text: 'done', usage: { inputTokens: 3, outputTokens: 4 } } });
    } finally { fixture.beforeTerminal = undefined; answer.resolve({ kind: 'approval', decision: 'allow' }); await iterator.return?.(); }
    await expect(session.send('fresh next turn')).resolves.toMatchObject({ text: 'done' });
  });
  if (id === 'codex') it.each(['return', 'throw'] as const)('disposes a fresh iterator on %s before its first read', async action => {
    const { control, fixture } = await setup(12);
    const turn = await control.startTurn({ input: 'fixture' }), iterator = turn.stream[Symbol.asyncIterator]();
    if (action === 'return') await iterator.return?.();
    else await expect(iterator.throw?.(new Error('caller stopped'))).rejects.toThrow('caller stopped');
    expect(await readdir(directory)).toEqual([]);
    expect(control.state()).toBe('unknown');
    await expect(control.startTurn({ input: 'must not launch' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(fixture.turns).toBe(1);
  });
  if (id === 'codex') it('binds failure interruption to the turn receipt after early notifications', async () => {
    const { control, fixture } = await setup(1000, false, { maxPublicBytes: 1024 }, () => 'x'.repeat(300));
    if (!(fixture instanceof CodexFixture)) throw new Error('Codex fixture required');
    const receipt = deferred<void>(); fixture.startGate = receipt.promise;
    const pending = control.startTurn({ input: 'fixture' }); void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(control.state()).toBe('unknown'));
      expect(fixture.interruptRequests).toEqual([]);
    } finally { receipt.resolve(); }
    const turn = await pending;
    await expect((async () => { for await (const _item of turn.stream) {} })()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    await vi.waitFor(() => expect(fixture.interruptRequests).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]));
  });
  if (id === 'codex') it('keeps an earlier spool failure when the native start later rejects', async () => {
    const { control, fixture } = await setup(1000, false, { maxPublicBytes: 1024 }, () => 'x'.repeat(300));
    if (!(fixture instanceof CodexFixture)) throw new Error('Codex fixture required');
    const receipt = deferred<void>(); fixture.startGate = receipt.promise; fixture.startError = new Error('secondary start failure');
    const pending = control.startTurn({ input: 'fixture' }); void pending.catch(() => undefined);
    try { await vi.waitFor(() => expect(control.state()).toBe('unknown')); } finally { receipt.resolve(); }
    await expect(pending).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(control.state()).toBe('unknown'); expect(await readdir(directory)).toEqual([]);
  });
  it('rejects a concurrent direct turn without replacing the first turn buffer', async () => {
    const { control } = await setup(20);
    const first = await control.startTurn({ input: 'first' }), iterator = first.stream[Symbol.asyncIterator]();
    await iterator.next();
    const second = (async () => { const turn = await control.startTurn({ input: 'second' }); await turn.stream[Symbol.asyncIterator]().next(); })();
    await expect(second).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    const seen = [];
    for (;;) { const step = await iterator.next(); if (step.done) break; seen.push(step.value); }
    expect(seen.at(-1)).toMatchObject({ kind: 'result', result: { text: 'done' } });
    expect(await readdir(directory)).toEqual([]);
  });
  it('preserves a direct handle after invalid input was rejected before prompt submission', async () => {
    const { control, fixture } = await setup(1);
    const rejected = (async () => { const turn = await control.startTurn({ input: [{ type: 'image', path: '/synthetic/unread-image.png' }] }); for await (const _item of turn.stream) {} })();
    await expect(rejected).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fixture.turns).toBe(0); expect(control.state()).toBe('active');
    const valid = await control.startTurn({ input: 'valid' }), items = [];
    for await (const item of valid.stream) items.push(item);
    expect(items.at(-1)).toMatchObject({ kind: 'result', result: { text: 'done' } });
    expect(fixture.turns).toBe(1);
  });
  it('closes while private storage is being created without launching or leaving files', async () => {
    const { control, fixture } = await setup(1);
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const opening = deferred<void>(), release = deferred<void>();
    vi.mocked(realpath).mockImplementation(async path => {
      if (String(path).includes('oar-control-')) { opening.resolve(); await release.promise; }
      return original.realpath(path);
    });
    const first = (async () => { const turn = await control.startTurn({ input: 'must not launch' }); return turn.stream[Symbol.asyncIterator]().next(); })();
    void first.catch(() => undefined); await opening.promise;
    const closing = control.close(); release.resolve(); await closing;
    await expect(first).rejects.toMatchObject({ code: expect.stringMatching(/^(PROTOCOL_ERROR|PROVIDER_UNAVAILABLE)$/u) });
    expect(fixture.turns).toBe(0);
    if (fixture instanceof ClaudeFixture) expect(fixture.queries).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
  it('fails before native prompt submission if private spool creation fails', async () => {
    const { session, fixture } = await setup(1, false, { directory: join(directory, 'absent') });
    await expect(session.send('fixture')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', cause: expect.objectContaining({ code: 'ENOENT' }) });
    expect(fixture.turns).toBe(0);
  });
});
