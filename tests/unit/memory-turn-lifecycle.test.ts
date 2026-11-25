// How memory fits into a turn's lifecycle: recall shares the turn's deadline, a turn cancelled
// during recall never runs, a turn that is always refused never reaches the provider, a fork's
// first capture belongs to the child, and a required log capture records the turn as returned.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConstraintAuthority, ConstraintStore, NothingPinnedError, systemConstraintStorePath } from '../../src/orchestration/context/index.ts';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import {
  AbortError, PinnedGuaranteeUnavailableError, SessionMismatchError, SessionNotFoundError, UnsupportedCapabilityError,
} from '../../src/public/errors.js';
import type { MemoryTurnNote } from '../../src/public/memory-types.js';
import type { AgentEvent, Turn } from '../../src/public/types.js';
import { PinnedTurns } from '../../src/session/pinned.js';
import { RequiredTurnCapture } from '../../src/session/required-capture.js';
import { RecordingExec, controlAgent, execAgent, memoryOf, recordingProvider, success } from './memory.fixture.js';

const noteOf = (turn: Turn) => (turn.providerMetadata as { memory?: MemoryTurnNote }).memory;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hung = () => recordingProvider(() => new Promise(() => {}));
/** Hangs on the first recall only. */
function hungOnce() {
  let calls = 0;
  return recordingProvider(() => (calls++ === 0 ? new Promise(() => {}) : Promise.resolve([])));
}
async function drain(events: AsyncIterable<AgentEvent>): Promise<Turn> {
  let turn: Turn | undefined;
  for await (const event of events) if (event.type === 'turn.completed') turn = event.turn;
  return turn!;
}

const dirs: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closers.splice(0).forEach((store) => store.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oar-memory-lifecycle-'));
  dirs.push(dir);
  return dir;
}
/** A constraint store: empty (every turn is refused), or with one active rule. */
function pinnedStore(rule = false) {
  const authority = ConstraintAuthority.create();
  const store = ConstraintStore.create(authority, { databasePath: systemConstraintStorePath(tempDir(), 'grow'), now: () => 1_700_000_000_000 });
  closers.push(store);
  if (rule) store.pin(authority, { scope: 'host', id: 'no-send', text: 'Never send an email.', setBy: 'owner', expectedVersion: 0 });
  return store;
}
/** An exec adapter whose CLI takes 30 ms. */
function slowCli(exec: RecordingExec) {
  exec.executeImpl = async (request) => { await sleep(30); return success(request.sessionId ?? 's1'); };
}

/**
 * These run on fake time (timers and `performance.now`): the share fires exactly when it is due and
 * the turn measures it on the same clock, so a loaded runner cannot shrink the rest of the deadline.
 */
const fakeTime = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
/** Advances fake time a millisecond at a time until `work` settles (at most `limitMs`). */
async function onFakeTime<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => { settled = true; });
  for (let ms = 0; ms < limitMs && !settled; ms += 1) await vi.advanceTimersByTimeAsync(1);
  return tracked;
}

describe('recall gets at most a quarter of the turn deadline; the turn keeps the rest', () => {
  it('session.send: a hung recall ends as a failed note and the turn completes', async () => {
    const { exec, agent } = execAgent({ memory: memoryOf(hung()) });
    slowCli(exec);
    const session = await agent.openSession();
    fakeTime();
    const turn = await onFakeTime(session.send('hola', { timeoutMs: 300 }), 300);
    expect(turn.status).toBe('completed');
    expect(noteOf(turn)).toMatchObject({ status: 'failed', reason: 'recall timed out after 75 ms' });
    expect(turn.warnings.map((warning) => warning.code)).toContain('MEMORY_UNAVAILABLE');
    expect(exec.requests[0]!.timeoutMs).toBe(225);
    expect(session.state).toBe('idle');
  });

  it('Agent.send: the share comes from what is left of the Agent operation', async () => {
    const { exec, agent } = execAgent({ memory: memoryOf(hung()) });
    slowCli(exec);
    fakeTime();
    const turn = await onFakeTime(agent.send('hola', { timeoutMs: 300 }), 300);
    expect(turn.status).toBe('completed');
    const spent = Number(/recall timed out after (\d+) ms/.exec((noteOf(turn) as { reason: string }).reason)?.[1]);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(75);
    // Opening the session may wait on real I/O while fake time runs, so what the Agent operation had
    // left when recall started (R) varies; the relation does not: recall took a quarter of R (`spent`,
    // floored) and the turn got the rest, R - spent, which is three times `spent` give or take the rounding.
    expect(exec.requests[0]!.timeoutMs).toBeGreaterThanOrEqual(3 * spent - 1);
    expect(exec.requests[0]!.timeoutMs).toBeLessThanOrEqual(3 * spent + 4);
    await agent.close();
  });

  it('recallTimeoutMs still bounds recall when it is the smaller one', async () => {
    const { agent } = execAgent({ memory: memoryOf(hung(), { recallTimeoutMs: 20 }) });
    const session = await agent.openSession();
    expect(noteOf(await session.send('hola', { timeoutMs: 10_000 }))).toMatchObject({ reason: 'recall timed out after 20 ms' });
  });

  it('a control turn keeps the rest of its deadline too', async () => {
    const { control, agent } = controlAgent({ memory: memoryOf(hung()) });
    const session = await agent.openSession();
    fakeTime();
    const turn = await onFakeTime(session.send('hola', { timeoutMs: 400 }), 400);
    expect(noteOf(turn)).toMatchObject({ status: 'failed', reason: 'recall timed out after 100 ms' });
    expect(control.requests[0]!.timeoutMs).toBe(300);
  });
});

describe('a turn cancelled during recall never runs and leaves the session idle', () => {
  it('control start: the receipt says interrupted, result and events reject like a pre-start abort', async () => {
    const { control, agent } = controlAgent({ memory: memoryOf(hungOnce(), { recallTimeoutMs: 60_000 }) });
    const session = await agent.openSession();
    const handle = session.start('hola');
    const events = drain(handle.events);
    expect(await handle.interrupt('stop')).toEqual({ requested: true, terminal: 'interrupted' });
    const error = await handle.result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AbortError);
    expect(error).toMatchObject({ message: 'Control turn aborted', context: { transport: 'control' } });
    await expect(events).rejects.toBe(error);
    expect({ state: session.state, inputs: control.inputs.length }).toEqual({ state: 'idle', inputs: 0 });
    await session.send('again');
    expect(control.inputs).toHaveLength(1);
  });

  it('exec start: the same receipt, the exec pre-start abort error, and the session stays usable', async () => {
    const { exec, agent } = execAgent({ memory: memoryOf(hung(), { recallTimeoutMs: 60_000 }) });
    const session = await agent.openSession();
    const handle = session.start('hola');
    expect(await handle.interrupt()).toEqual({ requested: true, terminal: 'interrupted' });
    await expect(handle.result).rejects.toMatchObject({ name: new AbortError({ retryable: true }).name, message: 'Operation aborted', context: { transport: 'exec' } });
    expect({ state: session.state, requests: exec.requests.length }).toEqual({ state: 'idle', requests: 0 });
  });

  it('exec send: a signal aborted during recall rejects and leaves the session idle', async () => {
    const { exec, agent } = execAgent({ memory: memoryOf(hung(), { recallTimeoutMs: 60_000 }) });
    const session = await agent.openSession();
    const controller = new AbortController();
    const pending = session.send('hola', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect({ state: session.state, requests: exec.requests.length }).toEqual({ state: 'idle', requests: 0 });
  });

  it('Agent.start: an interrupt during recall leaves the implicit session usable', async () => {
    const provider = hungOnce();
    const { exec, agent } = execAgent({ memory: memoryOf(provider, { recallTimeoutMs: 60_000 }) });
    const handle = agent.start('hola');
    await vi.waitFor(() => expect(provider.recalls).toHaveLength(1));
    expect(await handle.interrupt()).toEqual({ requested: true, terminal: 'interrupted' });
    await expect(handle.result).rejects.toBeInstanceOf(AbortError);
    expect((await agent.send('otra')).status).toBe('completed');
    expect(exec.requests).toHaveLength(1);
    await agent.close();
  });

  it('a signal aborted before recall behaves exactly as without memory, and never calls the provider', async () => {
    for (const make of [execAgent, controlAgent]) {
      const plain = make();
      const provider = recordingProvider();
      const remembering = make({ memory: memoryOf(provider) });
      const outcomes = [];
      for (const { agent } of [plain, remembering]) {
        const session = await agent.openSession();
        const error = await session.start('hola', { signal: AbortSignal.abort() }).result.then(() => undefined, (caught: unknown) => caught as Error);
        outcomes.push({ state: session.state, error: error?.message });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(provider.recalls).toHaveLength(0);
    }
  });
});

describe('a turn that is always refused never reaches the provider, and refuses where it did', () => {
  it('nothing pinned: start throws synchronously, send rejects, the session stays idle', async () => {
    const provider = recordingProvider();
    const { exec, agent } = execAgent({ pinned: { constraints: pinnedStore(), scopes: ['host'] }, memory: memoryOf(provider) });
    const session = await agent.openSession();
    expect(() => session.start('hola')).toThrow(NothingPinnedError);
    await expect(session.send('hola')).rejects.toBeInstanceOf(NothingPinnedError);
    await expect(agent.send('hola')).rejects.toBeInstanceOf(NothingPinnedError);
    expect({ recalls: provider.recalls.length, cli: exec.requests.length, state: session.state }).toEqual({ recalls: 0, cli: 0, state: 'idle' });
  });

  it('a control turn with pinned rules it cannot carry: start throws synchronously', async () => {
    const provider = recordingProvider();
    const { control, agent } = controlAgent({ pinned: { constraints: pinnedStore(true), scopes: ['host'] }, memory: memoryOf(provider) });
    const session = await agent.openSession();
    expect(() => session.start('hola')).toThrow(PinnedGuaranteeUnavailableError);
    expect({ recalls: provider.recalls.length, inputs: control.inputs.length, state: session.state }).toEqual({ recalls: 0, inputs: 0, state: 'idle' });
  });

  it('a control turn the transport refuses (detach): start throws synchronously', async () => {
    const provider = recordingProvider();
    const { agent } = controlAgent({ memory: memoryOf(provider) });
    const session = await agent.openSession();
    expect(() => session.start('hola', { signalBehavior: 'detach' })).toThrow(UnsupportedCapabilityError);
    expect({ recalls: provider.recalls.length, state: session.state }).toEqual({ recalls: 0, state: 'idle' });
  });

  it('an exec fork refused before it starts: no recall', async () => {
    const provider = recordingProvider();
    const { exec, agent } = execAgent({ memory: memoryOf(provider) });
    const parent = await agent.openSession();
    await expect(parent.forkAndSend('rama')).rejects.toBeInstanceOf(SessionNotFoundError);
    await parent.send('uno');
    await expect(parent.forkAndSend('rama', { onInteraction: async () => ({ kind: 'deny' }) as never })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(parent.forkAndSend('rama', { model: 'codex/gpt-5.4' })).rejects.toBeInstanceOf(SessionMismatchError);
    await expect(parent.forkAndSend([{ type: 'image', path: '/tmp/x.png' }])).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(provider.recalls.map((request) => request.text)).toEqual(['uno']);
    expect(exec.requests).toHaveLength(1);
    expect(parent.state).toBe('idle');
  });

  it('the pinned option is applied once per turn, recalled or not', async () => {
    const apply = vi.spyOn(PinnedTurns.prototype, 'apply');
    const { agent } = execAgent({ pinned: { constraints: pinnedStore(), scopes: ['host'], allowEmpty: true }, memory: memoryOf(recordingProvider()) });
    const session = await agent.openSession();
    const turn = await session.send('uno');
    expect(apply).toHaveBeenCalledTimes(1);
    expect((turn.providerMetadata as { pinned?: unknown }).pinned).toEqual({ status: 'nothing-pinned', provider: 'claude' });
    expect(noteOf(turn)?.status).toBe('recalled');
    const { turn: forked } = await session.forkAndSend('rama');
    expect(apply).toHaveBeenCalledTimes(2);
    expect((forked.providerMetadata as { pinned?: unknown }).pinned).toEqual({ status: 'nothing-pinned', provider: 'claude' });
    expect(noteOf(forked)?.status).toBe('recalled');
  });
});

describe('the capture of an exec fork first turn belongs to the child', () => {
  it('child.close() waits for it', async () => {
    let finish!: () => void;
    const provider = recordingProvider(undefined, (request) => (request.input === 'rama'
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve()));
    const { agent } = execAgent({ memory: memoryOf(provider, { capture: true }) });
    const parent = await agent.openSession();
    await parent.send('uno');
    const { session: child, turn } = await parent.forkAndSend('rama');
    expect(turn.status).toBe('completed');
    expect(provider.captures).toHaveLength(2);
    let closed = false;
    const closing = child.close().then(() => { closed = true; });
    await sleep(5);
    expect(closed).toBe(false);
    await parent.close();
    finish();
    await closing;
    expect(closed).toBe(true);
  });
});

describe('a required log capture records the turn exactly as it is returned', () => {
  const identity = { systemId: 'fixture', generation: 1, runId: 'run', agentId: 'logical-agent', harness: { id: 'sdk', version: '1', digest: 'a'.repeat(64) } };

  it.each(['send', 'start', 'stream'] as const)('%s: the captured turn carries the memory note and warning', async (mode) => {
    const log = new SqliteRunLogStore({ databasePath: join(tempDir(), 'log.sqlite'), systemId: 'fixture' });
    closers.push(log);
    const captured: Turn[] = [];
    const completeTurn = RequiredTurnCapture.prototype.completeTurn;
    vi.spyOn(RequiredTurnCapture.prototype, 'completeTurn').mockImplementation(function (this: RequiredTurnCapture, turn, buffered) {
      captured.push(turn);
      return completeTurn.call(this, turn, buffered);
    });
    const exec = new RecordingExec();
    const runtime = new Runtime({ adapters: [exec], capture: { store: log, identity, maxWriteMs: 1000 } });
    const agent = new Agent({ model: 'opus-5', transport: 'exec', memory: memoryOf(recordingProvider(async () => { throw new Error('MEMORY_CAPTURE_LOG_CANARY'); })) }, runtime);
    const turn = mode === 'send' ? await agent.send('hola') : mode === 'start' ? await agent.start('hola').result : await drain(agent.stream('hola'));
    await agent.close();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(turn);
    expect(noteOf(captured[0]!)).toMatchObject({ status: 'failed', reason: 'recall failed' });
    expect(captured[0]!.warnings.map((warning) => warning.code)).toContain('MEMORY_UNAVAILABLE');
    const records = (await log.readPage()).items;
    expect(records.at(-1)?.record.type).toBe('capture.settled');
    expect(JSON.stringify({ turn, records })).not.toContain('MEMORY_CAPTURE_LOG_CANARY');
  });
});
