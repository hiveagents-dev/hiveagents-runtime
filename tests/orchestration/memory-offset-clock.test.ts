import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SqliteSystemMemory } from '../../src/orchestration/memory/system.js';
import { episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';
import { OLD_BUILD, oldInsertValues, oldPromote } from './memory-v1-fixture.js';

/**
 * Timestamps with UTC offsets. An injected clock may return any ISO-8601 instant with an offset,
 * and an older build on the same file writes whatever its clock gave. "Newest first" must follow
 * the instant, not the string: every timestamp this build stores is UTC `toISOString()` form, and
 * every ordering also reads the ones already stored with an offset as instants.
 */
let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

const scope = scopeOf('grow');
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A clock that returns the next of `times`, then keeps returning the last one. */
function scripted(times: string[]) {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)]!;
}

function raw<T>(path: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return body(db); } finally { db.close(); }
}

describe('an injected clock with varying UTC offsets', () => {
  it('stores every timestamp in UTC and lists newest first by instant', async () => {
    let current = '2026-01-05T02:00:00.000+10:00'; // 2026-01-04T16:00Z
    const memory: SqliteSystemMemory = workspace.open('grow', { now: () => current });
    await memory.enable({ by: 'operator' });
    await memory.put(episode('grow', 'older', 'factura a las 16 UTC'));
    current = '2026-01-04T12:00:00.000-05:00'; // 2026-01-04T17:00Z
    await memory.put(episode('grow', 'newer', 'factura a las 17 UTC'));

    const listed = await memory.list({ scope });
    expect(listed.map(view => view.record.id)).toEqual(['newer', 'older']);
    expect(listed.map(view => view.recordedAt)).toEqual(['2026-01-04T17:00:00.000Z', '2026-01-04T16:00:00.000Z']);

    current = '2026-01-04T18:30:00+01:00'; // seconds only, with an offset
    const promoted = await memory.promote({ scope, id: 'newer', gate: await gateFor(memory, scope, 'newer'), by: 'operator' });
    expect(promoted).toEqual({ promoted: true, promotedAt: '2026-01-04T17:30:00.000Z' });
    await memory.revoke({ scope, id: 'older', revokedAt: '2026-01-04T20:00:00-03:00', reason: 'pedido' });
    const grant = await memory.grant({ to: 'support', namespace: 'lessons', by: 'operator' });
    expect(grant.grantedAt).toBe('2026-01-04T17:30:00.000Z');
    expect((await memory.status()).changedAt).toBe('2026-01-04T16:00:00.000Z');

    const stored = raw(workspace.databasePath, db => ({
      records: db.prepare('SELECT recorded_at, promoted_at, revoked_at FROM memory_records').all(),
      systems: db.prepare('SELECT changed_at FROM memory_systems').all(),
      grants: db.prepare('SELECT granted_at FROM memory_grants').all(),
    }));
    const values = [
      ...stored.records.flatMap(row => [row.recorded_at, row.promoted_at, row.revoked_at]),
      ...stored.systems.map(row => row.changed_at),
      ...stored.grants.map(row => row.granted_at),
    ].filter(value => value !== null);
    expect(values.length).toBe(6);
    for (const value of values) expect(value).toMatch(ISO_UTC);
    expect(stored.records.map(row => row.revoked_at)).toContain('2026-01-04T23:00:00.000Z');
  });

  it('retires superseded lessons at the promotion instant in UTC', async () => {
    const memory = workspace.open('grow', { now: scripted(['2026-03-01T10:00:00.000+02:00']) });
    await memory.enable({ by: 'operator' });
    await memory.put(episode('grow', 'vieja', 'factura en pesos'));
    await memory.promote({ scope, id: 'vieja', gate: await gateFor(memory, scope, 'vieja'), by: 'operator' });
    await memory.put(episode('grow', 'nueva', 'factura en dólares', { supersedes: ['vieja'] }));
    await memory.promote({ scope, id: 'nueva', gate: await gateFor(memory, scope, 'nueva'), by: 'operator' });
    const vieja = (await memory.list({ scope })).find(view => view.record.id === 'vieja')!;
    expect(vieja.invalidation).toEqual({ invalidatedAt: '2026-03-01T08:00:00.000Z', supersededBy: 'nueva' });
  });
});

describe('timestamps an older build stored with an offset', () => {
  it('list orders them by instant and returns them in UTC', async () => {
    const memory = workspace.open('grow');
    await memory.enable({ by: 'operator' });
    raw(workspace.databasePath, db => {
      // 12:00Z, 13:00Z, 13:00:00.500Z: as strings the order would be older, newest, newer.
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'older', 'factura uno'), '2026-11-10T22:00:00.000+10:00'));
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'newer', 'factura dos'), '2026-11-10T13:00:00Z'));
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'newest', 'factura tres'), '2026-11-10T08:00:00.500-05:00'));
    });
    const listed = await memory.list({ scope });
    expect(listed.map(view => view.record.id)).toEqual(['newest', 'newer', 'older']);
    expect(listed.map(view => view.recordedAt)).toEqual([
      '2026-11-10T13:00:00.500Z', '2026-11-10T13:00:00.000Z', '2026-11-10T12:00:00.000Z',
    ]);
    expect((await memory.list({ scope, limit: 1 })).map(view => view.record.id)).toEqual(['newest']);
  });

  it('the recall pool keeps the most recently promoted lessons by instant', async () => {
    const memory = workspace.open('grow');
    await memory.enable({ by: 'operator' });
    raw(workspace.databasePath, db => {
      db.exec('BEGIN');
      for (let i = 0; i < 512; i += 1) {
        const id = `jardin-${i}`;
        db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', id, `riego del jardín ${i}`), '2026-11-10T12:00:00.000Z'));
        oldPromote(db, id, new Date(Date.UTC(2026, 10, 10, 13, 0, 0, i)).toISOString());
      }
      // Promoted last (13:30Z), but its string sorts before every other one.
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'factura', 'factura en dólares'), '2026-11-10T12:00:00.000Z'));
      oldPromote(db, 'factura', '2026-11-10T08:30:00.000-05:00');
      db.exec('COMMIT');
    });
    expect((await memory.query({ scope, text: 'factura', limit: 3 })).map(record => record.id)).toEqual(['factura']);
    const view = (await memory.list({ scope, limit: 1 }))[0]!;
    expect(view.promotion?.promotedAt).toBe('2026-11-10T13:30:00.000Z');
  });

  it('grants are listed in the order they were given, by instant', async () => {
    const memory = workspace.open('grow');
    await memory.enable({ by: 'operator' });
    raw(workspace.databasePath, db => {
      db.prepare(OLD_BUILD.grant).run('g-late', 'grow', 'support', 'lessons', '', 'operator', '2026-11-10T09:00:00.000-05:00');
      db.prepare(OLD_BUILD.grant).run('g-early', 'grow', 'billing', 'lessons', '', 'operator', '2026-11-10T20:00:00.000+10:00');
    });
    const grants = await memory.listGrants();
    expect(grants.map(grant => grant.id)).toEqual(['g-early', 'g-late']);
    expect(grants.map(grant => grant.grantedAt)).toEqual(['2026-11-10T10:00:00.000Z', '2026-11-10T14:00:00.000Z']);
  });
});
