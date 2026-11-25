// A turn with memory checks the pinned option before recall (so a refused turn never reaches the
// provider) and delivers it once recall is done: it runs with the constraints current when it
// starts, never with less than another turn of the same Agent already ran with. Its pre-flight
// refuses in exactly the order the same turn without memory does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecTurnRequest } from '../../src/adapters/provider.js';
import {
  ConstraintAuthority, ConstraintIntegrityError, ConstraintStore, systemConstraintStorePath,
} from '../../src/orchestration/context/index.ts';
import { AbortError, PinnedGuaranteeUnavailableError } from '../../src/public/errors.js';
import type { MemoryOption } from '../../src/public/memory-types.js';
import type { AgentOptions, Turn } from '../../src/public/types.js';
import type { Session } from '../../src/session/session.js';
import { controlAgent, execAgent, memoryOf, recordingProvider, type RecordingProvider } from './memory.fixture.js';

const pinnedOf = (turn: Turn) => (turn.providerMetadata as { pinned?: { carried?: Array<{ id: string; version: number }> } }).pinned;
const hung = () => recordingProvider(() => new Promise(() => {}));
/** What a refusal was: its name for the pinned errors, its code otherwise. */
function refusal(error: unknown): string {
  const e = error as { code?: string; name: string };
  return ['PinnedGuaranteeUnavailableError', 'NothingPinnedError', 'RangeError'].includes(e.name) ? e.name : e.code ?? e.name;
}
function syncRefusal(work: () => unknown): string | undefined {
  try { work(); return undefined; } catch (error) { return refusal(error); }
}

const dirs: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((store) => store.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function pinnedStore(rule = true) {
  const dir = mkdtempSync(join(tmpdir(), 'oar-memory-preflight-'));
  dirs.push(dir);
  const authority = ConstraintAuthority.create();
  let clock = 1_700_000_000_000;
  const store = ConstraintStore.create(authority, { databasePath: systemConstraintStorePath(dir, 'grow'), now: () => clock++ });
  closers.push(store);
  if (rule) store.pin(authority, { scope: 'host', id: 'no-send', text: 'Never send an email.', setBy: 'owner', expectedVersion: 0 });
  return { dir, store, authority };
}
/** A provider whose recall for `slow` waits for `release()`; every other recall answers at once. */
function gatedProvider(slow: string): RecordingProvider & { release(): void } {
  let release!: () => void;
  const gate = new Promise<unknown>((resolve) => { release = () => resolve([]); });
  return Object.assign(recordingProvider((request) => (request.text === slow ? gate : Promise.resolve([]))), { release: () => release() });
}

describe('a turn with memory delivers the pinned constraints current when it starts, after recall', () => {
  it('exec: a turn that recalls slowly runs with the rule another turn already ran with', async () => {
    const { store, authority } = pinnedStore();
    const provider = gatedProvider('a');
    const { exec, agent } = execAgent({ pinned: { constraints: store, scopes: ['host'] }, memory: memoryOf(provider, { recallTimeoutMs: 60_000 }) });
    const [a, b] = [await agent.openSession(), await agent.openSession()];
    const first = a.send('a');
    await vi.waitFor(() => expect(provider.recalls).toHaveLength(1));
    store.pin(authority, { scope: 'host', id: 'no-delete', text: 'Never delete files.', setBy: 'owner', expectedVersion: 0 });
    await b.send('b');
    provider.release();
    const turn = await first;
    const [ranB, ranA] = exec.requests as [ExecTurnRequest, ExecTurnRequest];
    expect(ranB.instructions).toContain('Never delete files.');
    expect(ranA.instructions).toContain('Never delete files.');
    expect(pinnedOf(turn)?.carried?.map(({ id }) => id).sort()).toEqual(['no-delete', 'no-send']);
  });

  it('exec fork: the first turn of a fork that recalls slowly carries the newer rule too', async () => {
    const { store, authority } = pinnedStore();
    const provider = gatedProvider('rama');
    const { exec, agent } = execAgent({ pinned: { constraints: store, scopes: ['host'] }, memory: memoryOf(provider, { recallTimeoutMs: 60_000 }) });
    const parent = await agent.openSession();
    await parent.send('uno');
    const forking = parent.forkAndSend('rama');
    await vi.waitFor(() => expect(provider.recalls.map(({ text }) => text)).toContain('rama'));
    store.pin(authority, { scope: 'host', id: 'no-delete', text: 'Never delete files.', setBy: 'owner', expectedVersion: 0 });
    await (await agent.openSession()).send('b');
    provider.release();
    const { turn } = await forking;
    const fork = exec.requests.find((request) => request.mode === 'fork')!;
    expect(fork.instructions).toContain('Never delete files.');
    expect(pinnedOf(turn)?.carried?.map(({ id }) => id).sort()).toEqual(['no-delete', 'no-send']);
  });

  it('control: a rule pinned during recall stops a turn that has no channel for it', async () => {
    const { store, authority } = pinnedStore(false);
    const provider = gatedProvider('a');
    const { control, agent } = controlAgent({ pinned: { constraints: store, scopes: ['host'], allowEmpty: true }, memory: memoryOf(provider, { recallTimeoutMs: 60_000 }) });
    const session = await agent.openSession();
    const handle = session.start('a');
    await vi.waitFor(() => expect(provider.recalls).toHaveLength(1));
    store.pin(authority, { scope: 'host', id: 'no-send', text: 'Never send an email.', setBy: 'owner', expectedVersion: 0 });
    provider.release();
    await expect(handle.result).rejects.toBeInstanceOf(PinnedGuaranteeUnavailableError);
    expect({ inputs: control.inputs.length, state: session.state }).toEqual({ inputs: 0, state: 'idle' });
  });

  it('a store that lost the version another turn ran with during recall still stops the turn', async () => {
    const { dir, store, authority } = pinnedStore();
    const provider = gatedProvider('a');
    const { exec, agent } = execAgent({ pinned: { constraints: store, scopes: ['host'] }, memory: memoryOf(provider, { recallTimeoutMs: 60_000 }) });
    const [a, b] = [await agent.openSession(), await agent.openSession()];
    const first = a.send('a');
    await vi.waitFor(() => expect(provider.recalls).toHaveLength(1));
    store.pin(authority, { scope: 'host', id: 'no-send', text: 'Never send an email. Drafts too.', setBy: 'owner', expectedVersion: 1 });
    await b.send('b');
    const raw = new DatabaseSync(systemConstraintStorePath(dir, 'grow'));
    raw.exec('DROP TRIGGER IF EXISTS context_constraints_no_delete');
    raw.exec('DELETE FROM context_constraints WHERE version = 2');
    raw.close();
    provider.release();
    await expect(first).rejects.toBeInstanceOf(ConstraintIntegrityError);
    expect({ cli: exec.requests.map(({ prompt }) => prompt), state: a.state }).toEqual({ cli: ['b'], state: 'idle' });
  });
});

describe('the pre-flight refuses in the order of the turn without memory', () => {
  type Make = typeof execAgent | typeof controlAgent;
  /** The refusal of `start` on a session prepared by `prepare`, without and with memory. */
  async function both(make: Make, prepare: (session: Session) => Promise<void>, options: Parameters<Session['start']>[1], extra: Partial<AgentOptions> = {}) {
    const result: Array<string | undefined> = [];
    for (const memory of [undefined, memoryOf(hung(), { recallTimeoutMs: 60_000 }) as MemoryOption]) {
      const { agent } = make({ ...extra, ...(memory ? { memory } : {}) });
      const session = await agent.openSession();
      await prepare(session);
      result.push(syncRefusal(() => session.start('hola', options)));
    }
    return result;
  }
  const closed = async (session: Session) => { await session.close(); };
  const busy = async (session: Session) => { void session.start('first').result.catch(() => undefined); };
  const pinned = () => ({ pinned: { constraints: pinnedStore().store, scopes: ['host'] } });
  const empty = () => ({ pinned: { constraints: pinnedStore(false).store, scopes: ['host'] } });

  it.each([
    ['closed session, then detach', controlAgent, closed, { signalBehavior: 'detach' as const }, {}, 'SESSION_MISMATCH'],
    ['busy session, then an invalid deadline', controlAgent, busy, { timeoutMs: 0 }, {}, 'SESSION_BUSY'],
    ['pinned rules it cannot carry, then detach', controlAgent, async () => undefined, { signalBehavior: 'detach' as const }, 'pinned', 'PinnedGuaranteeUnavailableError'],
    ['closed session, then an invalid deadline', controlAgent, closed, { timeoutMs: 0 }, {}, 'SESSION_MISMATCH'],
  ] as const)('control: %s', async (_name, make, prepare, options, extra, expected) => {
    const [plain, remembering] = await both(make, prepare, options, extra === 'pinned' ? pinned() : extra);
    expect(plain).toBe(expected);
    expect(remembering).toBe(plain);
  });

  it.each([
    ['closed session, then an invalid deadline', closed, { timeoutMs: 0 }, {}, 'RangeError'],
    ['busy session, then an invalid deadline', busy, { timeoutMs: 0 }, {}, 'RangeError'],
    ['nothing pinned, then an invalid deadline', async () => undefined, { timeoutMs: 0 }, 'empty', 'NothingPinnedError'],
    ['closed session, nothing pinned', closed, {}, 'empty', 'NothingPinnedError'],
    ['closed session, valid options', closed, {}, {}, 'SESSION_MISMATCH'],
  ] as const)('exec: %s', async (_name, prepare, options, extra, expected) => {
    const [plain, remembering] = await both(execAgent, prepare, options, extra === 'empty' ? empty() : extra);
    expect(plain).toBe(expected);
    expect(remembering).toBe(plain);
  });

  it('exec fork: an already-aborted signal refuses before the pinned option, as without memory', async () => {
    const result: string[] = [];
    for (const memory of [undefined, memoryOf(recordingProvider())]) {
      const { store, authority } = pinnedStore();
      const { agent } = execAgent({ pinned: { constraints: store, scopes: ['host'] }, ...(memory ? { memory } : {}) });
      const parent = await agent.openSession();
      await parent.send('uno');
      store.revoke(authority, { scope: 'host', id: 'no-send', setBy: 'owner', reason: 'test', expectedVersion: 1 });
      result.push(refusal(await parent.forkAndSend('rama', { signal: AbortSignal.abort() }).catch((error: unknown) => error)));
      expect(parent.state).toBe('idle');
    }
    expect(result[0]).toBe('ABORTED');
    expect(result[1]).toBe(result[0]);
  });

  it('exec fork: without an abort the pinned refusal comes before recall', async () => {
    const provider = recordingProvider();
    const { store, authority } = pinnedStore();
    const { agent } = execAgent({ pinned: { constraints: store, scopes: ['host'] }, memory: memoryOf(provider) });
    const parent = await agent.openSession();
    await parent.send('uno');
    store.revoke(authority, { scope: 'host', id: 'no-send', setBy: 'owner', reason: 'test', expectedVersion: 1 });
    const error = await parent.forkAndSend('rama').catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(AbortError);
    expect(refusal(error)).toBe('NothingPinnedError');
    expect(provider.recalls.map(({ text }) => text)).toEqual(['uno']);
  });
});
