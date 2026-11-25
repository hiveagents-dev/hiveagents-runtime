import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/session/session.js';
import type { ControlSessionHandle, ControlSessionState } from '../../src/session/control-session.js';
import type { SessionIdentity } from '../../src/public/types.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';

const model = { id: 'fixture-model', provider: 'codex' as const, aliases: [], source: 'explicit' as const, availability: 'unverified' as const };
const adapter: ExecAdapter = { id: 'codex', detect: async () => ({ installed: true }), auth: async () => ({ authenticated: true, source: 'subscription' }),
  models: async () => [], execute: async () => { throw new Error('No installed CLI or EXEC fallback'); } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class IdentityControl implements ControlSessionHandle {
  transportEpoch = 'old-epoch'; current: ControlSessionState = 'unknown';
  identity: SessionIdentity = { schemaVersion: 1, provider: 'codex', id: 'thread', cwd: '/fixture', model: model.id,
    transport: 'control', persistence: 'provider', transportEpoch: 'old-epoch', createdAt: '2026-01-01T00:00:00.000Z', forkedFromId: 'parent' };
  reconcile: () => Promise<ControlSessionState> = async () => this.current;
  recover(patch: Partial<SessionIdentity> = {}) { this.transportEpoch = 'new-epoch'; this.identity = { ...this.identity, transportEpoch: this.transportEpoch, ...patch }; this.current = 'active'; }
  state() { return this.current; }
  async startTurn() {
    return { stream: (async function* () { yield { kind: 'result' as const, result: { sessionId: 'thread', completed: true, failed: false, refused: false, text: 'done', events: [], nativeEvents: [] } }; })(),
      interrupt: async () => ({ requested: false, terminal: 'unknown' as const }) };
  }
  async respond() {}
  async fork(): Promise<ControlSessionHandle> { throw new Error('No implicit fork'); }
  async close() { this.current = 'closed'; }
}
const sessions: Session[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); });
function fixture() {
  const control = new IdentityControl(), session = new Session({ adapter, control, model, cwd: '/fixture', persistence: 'provider', transport: 'control',
    contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
  sessions.push(session); return { control, session };
}
describe('reconciled Session control identity', () => {
  it('refreshes every exported epoch immediately while preserving logical session metadata', async () => {
    const { control, session } = fixture(), previous = session.export();
    control.reconcile = async () => { control.recover({ createdAt: '2099-01-01T00:00:00.000Z' }); return 'active'; };
    await expect(session.reconcile()).resolves.toBe('idle');
    for (const identity of [session.ref, session.identity, session.export()]) expect(identity).toMatchObject({ ...previous, transportEpoch: 'new-epoch' });
    expect(previous.transportEpoch).toBe('old-epoch');
  });
  it('preserves the previous identity when a recovery remains unknown', async () => {
    const { control, session } = fixture(), previous = session.export();
    control.reconcile = async () => { control.recover(); return 'unknown'; };
    await expect(session.reconcile()).resolves.toBe('unknown'); expect(session.export()).toEqual(previous);
  });
  it.each([{ id: 'foreign' }, { provider: 'claude' }, { transport: 'exec' }, { persistence: 'process' },
    { cwd: '/foreign' }, { model: 'foreign-model' }, { transportEpoch: 'contradictory-epoch' }, { schemaVersion: 2 }])('refuses identity drift %j and keeps the old export', async patch => {
    const { control, session } = fixture(), previous = session.export();
    control.reconcile = async () => { control.recover(patch as Partial<SessionIdentity>); return 'active'; };
    await expect(session.reconcile()).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    expect(session.state).toBe('unknown'); expect(session.export()).toEqual(previous);
  });
  it.each(['numeric-id', 'numeric-epoch'] as const)('rejects malformed %s nominally rather than leaking a raw type error', async kind => {
    const { control, session } = fixture(), previous = session.export();
    control.reconcile = async () => { control.recover(kind === 'numeric-id' ? { id: 123 as never } : {});
      if (kind === 'numeric-epoch') { Object.assign(control, { transportEpoch: 123 }); Object.assign(control.identity, { transportEpoch: 123 }); }
      return 'active'; };
    await expect(session.reconcile()).rejects.toMatchObject({ code: 'SESSION_MISMATCH' }); expect(session.export()).toEqual(previous);
  });
  it.each([false, true])('handles missing native identity with changed epoch=%s conservatively', async changed => {
    const { control, session } = fixture(), previous = session.export();
    control.reconcile = async () => { if (changed) control.recover(); control.identity = undefined as never; return 'active'; };
    if (changed) { await expect(session.reconcile()).rejects.toMatchObject({ code: 'SESSION_MISMATCH' }); expect(session.state).toBe('unknown'); }
    else await expect(session.reconcile()).resolves.toBe('idle');
    expect(session.export()).toEqual(previous);
  });
  it('cannot refresh an epoch through a recovery that loses ownership to close', async () => {
    const { control, session } = fixture(), previous = session.export(), gate = deferred();
    control.reconcile = async () => { await gate.promise; control.recover(); return 'active'; };
    const pending = session.reconcile(); await session.close(); gate.resolve();
    await expect(pending).resolves.toBe('closed'); expect(session.export()).toEqual(previous);
  });
  it('cannot overwrite an identity after another owner starts and finishes a turn', async () => {
    const { control, session } = fixture(), previous = session.export(), gate = deferred();
    control.reconcile = async () => { await gate.promise; control.recover(); return 'active'; };
    const pending = session.reconcile(); await session.send('new explicit owner'); gate.resolve();
    await expect(pending).resolves.toBe('idle'); expect(session.ref?.transportEpoch).toBe(previous.transportEpoch);
  });
});
