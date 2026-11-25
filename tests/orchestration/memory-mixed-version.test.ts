import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readMemoryView } from '../../src/orchestration/memory/system.js';
import { episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';
import { OLD_BUILD, oldInsertValues, oldPromote, pragmas, writeV1Database } from './memory-v1-fixture.js';

/**
 * The memory file is shared by every process on the machine, and they do not upgrade together.
 * A process on the build before temporal validity (c585264) is played here by its own open check
 * and its own statements, copied verbatim (`OLD_BUILD`), on the same file as this build's store.
 */
let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

const scope = scopeOf('grow');
const at = (second: number) => `2026-11-10T13:00:${String(second).padStart(2, '0')}.000Z`;

function oldProcess<T>(path: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    if (!OLD_BUILD.opens(db)) throw new Error('UNSUPPORTED_DATABASE');
    return body(db);
  } finally { db.close(); }
}

// Keep the historical SQL; Node 22.16 treats its numbered parameters as named bindings.
const oldRecallBindings = { '?1': 'grow', '?2': 'lessons', '?3': '', '?4': 'grow' };

describe('an older build on a file this build has opened', () => {
  it('still opens it, and its writes, promotions, withdrawals and grants still go through', async () => {
    writeV1Database(workspace.databasePath, episode);
    const grow = workspace.open('grow');
    await grow.put(episode('grow', 'nueva', 'factura en dólares', { supersedes: ['leccion'] }));
    await grow.promote({ scope, id: 'nueva', gate: await gateFor(grow, scope, 'nueva'), by: 'operator' });
    await grow.put(episode('grow', 'caduca', 'factura temporal', { validUntil: '2026-11-10T12:00:30.000Z' }));

    oldProcess(workspace.databasePath, db => {
      db.prepare(OLD_BUILD.enable).run('grow', 1, 'old-operator', at(0));
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'vieja', 'factura en euros'), at(1)));
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'tirada', 'factura en yenes'), at(2)));
      oldPromote(db, 'vieja', at(3));
      oldPromote(db, 'tirada', at(4));
      db.prepare(OLD_BUILD.rollback).run(at(5), 'operator', 'regresión', 'grow', 'lessons', '', 'tirada');
      db.prepare(OLD_BUILD.revoke).run(at(6), 'pedido', 'grow', 'lessons', '', 'borrador');
      db.prepare(OLD_BUILD.grant).run('g2', 'grow', 'support', 'lessons', '', 'operator', at(7));
      db.prepare(OLD_BUILD.revokeGrant).run(at(8), 'operator', 'g2');
      // Its own guard rails still hold on the extended file.
      expect(() => db.exec("UPDATE memory_records SET text = 'x' WHERE id = 'vieja'")).toThrow(/immutable/);
      expect(() => db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'vieja', 'otra'), at(9)))).toThrow(/immutable/);
    });

    // This build reads what the older one wrote, as it would have written it.
    expect((await grow.list({ scope })).map(view => [view.record.id, view.state]).sort()).toEqual([
      ['caduca', 'episode'], ['leccion', 'invalidated'], ['nueva', 'lesson'], ['vieja', 'lesson'],
    ]);
    expect((await grow.query({ scope, text: 'factura', limit: 5 })).map(record => record.id).sort()).toEqual(['nueva', 'vieja']);
    await grow.put(episode('grow', 'vieja', 'factura en euros'));
    expect(pragmas(workspace.databasePath).version).toBe(1);
  });

  it('ignores supersession and expiry: it still recalls a retired lesson (a stale fact, documented)', async () => {
    writeV1Database(workspace.databasePath, episode);
    const grow = workspace.open('grow');
    await grow.put(episode('grow', 'nueva', 'factura en dólares', { supersedes: ['leccion'] }));
    await grow.promote({ scope, id: 'nueva', gate: await gateFor(grow, scope, 'nueva'), by: 'operator' });

    const oldRecall = oldProcess(workspace.databasePath, db =>
      db.prepare(OLD_BUILD.recall).all(oldRecallBindings).map(row => String(row.id)).sort());
    const oldCounts = oldProcess(workspace.databasePath, db => db.prepare(OLD_BUILD.viewCounts).all());

    expect((await grow.query({ scope, text: 'factura', limit: 5 })).map(record => record.id)).toEqual(['nueva']);
    // Only promoted lessons, never an episode: what it reads still passed the gate.
    expect(oldRecall).toEqual(['leccion', 'nueva']);
    expect(oldCounts).toEqual([{ id: 'grow', observations: 3, lessons: 2 }]);
    expect(readMemoryView(workspace.databasePath)).toMatchObject({ ok: true, systems: [{ systemId: 'grow', observations: 3, lessons: 1 }, { systemId: 'marketing' }] });
  });

  it('opens a file this build created, and writes to it', () => {
    workspace.open('grow').close();

    oldProcess(workspace.databasePath, db => {
      db.prepare(OLD_BUILD.enable).run('grow', 1, 'operator', at(0));
      db.prepare(OLD_BUILD.insert).run(...oldInsertValues(episode('grow', 'vieja', 'factura en euros'), at(1)));
      oldPromote(db, 'vieja', at(2));
      expect(db.prepare(OLD_BUILD.recall).all(oldRecallBindings).map(row => row.id)).toEqual(['vieja']);
    });
  });
});
