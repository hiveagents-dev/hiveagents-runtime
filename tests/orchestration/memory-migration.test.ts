import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteSystemMemory, readMemoryView } from '../../src/orchestration/memory/system.js';
import { episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';
import { pragmas, writeV1Database } from './memory-v1-fixture.js';

/**
 * Temporal validity is an additive migration: a file written by the build before it gains the
 * columns and triggers on its first open by this build, and stays at `user_version` 1, so a
 * process on the older build keeps sharing it (see memory-mixed-version.test.ts).
 */
let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

const scope = scopeOf('grow');
const TEMPORAL = ['supersedes_json', 'valid_until', 'invalidated_at', 'invalidated_by'];

describe('a memory file without the temporal columns', () => {
  it('gains them on open, stays at version 1, and keeps every record, promotion, tombstone and grant', async () => {
    writeV1Database(workspace.databasePath, episode);
    expect(pragmas(workspace.databasePath)).toMatchObject({ version: 1, application: 0x4f41524d });
    expect(pragmas(workspace.databasePath).columns).not.toContain('valid_until');
    // The read-only view reads the file as it is, without adding anything.
    expect(readMemoryView(workspace.databasePath)).toMatchObject({ ok: true, systems: [{ systemId: 'grow', observations: 2, lessons: 1 }, { systemId: 'marketing' }] });
    expect(pragmas(workspace.databasePath).columns).not.toContain('valid_until');

    const grow = workspace.open('grow');

    expect(pragmas(workspace.databasePath)).toMatchObject({ version: 1, application: 0x4f41524d });
    expect(pragmas(workspace.databasePath).columns).toEqual(expect.arrayContaining(TEMPORAL));
    expect((await grow.query({ scope, text: 'factura', limit: 5 })).map(record => record.id)).toEqual(['leccion']);
    expect((await grow.list({ scope })).map(view => [view.record.id, view.state]).sort()).toEqual([['borrador', 'episode'], ['leccion', 'lesson']]);
    expect((await workspace.open('marketing').query({ scope, text: 'factura', limit: 5 })).map(record => record.id)).toEqual(['leccion']);
    // Digests did not move: storing the same episode again is still a no-op, the withdrawn id stays withdrawn.
    await grow.put(episode('grow', 'borrador', 'factura sin medir'));
    await expect(grow.put(episode('grow', 'olvidado', 'factura secreta'))).rejects.toMatchObject({ code: 'WITHDRAWN' });
    expect(readMemoryView(workspace.databasePath)).toMatchObject({ ok: true, systems: [{ systemId: 'grow', observations: 2, lessons: 1 }, { systemId: 'marketing' }] });
  });

  it('supports supersession once extended, over a lesson promoted before', async () => {
    writeV1Database(workspace.databasePath, episode);
    const grow = workspace.open('grow');
    await grow.put(episode('grow', 'nueva', 'factura en dólares', { supersedes: ['leccion'] }));
    await grow.promote({ scope, id: 'nueva', gate: await gateFor(grow, scope, 'nueva'), by: 'operator' });

    expect((await grow.query({ scope, text: 'factura', limit: 5 })).map(record => record.id)).toEqual(['nueva']);
    expect((await grow.list({ scope })).find(view => view.record.id === 'leccion')).toMatchObject({
      state: 'invalidated', invalidation: { supersededBy: 'nueva' },
    });
    expect(readMemoryView(workspace.databasePath)).toMatchObject({ ok: true, systems: [{ systemId: 'grow', observations: 3, lessons: 1 }, { systemId: 'marketing' }] });
  });

  it('is extended exactly once: later opens, concurrent or not, find it done and change nothing', () => {
    writeV1Database(workspace.databasePath, episode);
    const first = workspace.open('grow');
    const second = workspace.open('marketing');
    const migrated = pragmas(workspace.databasePath);
    first.close();
    second.close();
    workspace.open('grow');

    expect(pragmas(workspace.databasePath)).toEqual(migrated);
    expect(migrated.version).toBe(1);
  });

  it('ends up with exactly the schema of a file created fresh, which is also at version 1', () => {
    writeV1Database(workspace.databasePath, episode);
    workspace.open('grow');
    const fresh = join(workspace.directory, 'fresh.sqlite');
    new SqliteSystemMemory({ databasePath: fresh, systemId: 'grow' }).close();

    expect(pragmas(workspace.databasePath).schema).toEqual(pragmas(fresh).schema);
    expect(pragmas(fresh)).toMatchObject({ version: 1, columns: expect.arrayContaining(TEMPORAL) });
  });

  it('keeps every history guard after the migration', () => {
    writeV1Database(workspace.databasePath, episode);
    workspace.open('grow').close();

    const raw = new DatabaseSync(workspace.databasePath);
    try {
      expect(() => raw.exec("UPDATE memory_records SET text = 'otra cosa' WHERE id = 'leccion'")).toThrow(/immutable/);
      expect(() => raw.exec("UPDATE memory_records SET recorded_at = 'x' WHERE id = 'borrador'")).toThrow(/immutable/);
      expect(() => raw.exec("UPDATE memory_records SET valid_until = '2000-01-01T00:00:00.000Z' WHERE id = 'leccion'")).toThrow(/immutable/);
      expect(() => raw.exec('DELETE FROM memory_records')).toThrow(/immutable/);
      expect(() => raw.exec("UPDATE memory_records SET revoked_at = NULL WHERE id = 'olvidado'")).toThrow(/final/);
      expect(() => raw.exec("UPDATE memory_records SET promoted_by = 'otro' WHERE id = 'leccion'")).toThrow(/final/);
      expect(() => raw.exec("UPDATE memory_records SET promoted_at = 'x', promoted_by = 'x', gate_json = '{}' WHERE id = 'borrador'")).toThrow(/constraint/i);
      expect(() => raw.exec('DELETE FROM memory_grants')).toThrow(/immutable/);
      expect(() => raw.exec("UPDATE memory_records SET invalidated_at = 'x', invalidated_by = 'borrador' WHERE id = 'leccion'")).toThrow(/supersedes/);
    } finally { raw.close(); }
  });

  it('refuses any other version, a newer one included, and a file with only some of the columns', () => {
    const newer = join(workspace.directory, 'newer.sqlite');
    new SqliteSystemMemory({ databasePath: newer, systemId: 'grow' }).close();
    const db = new DatabaseSync(newer);
    db.exec('PRAGMA user_version = 2');
    db.close();

    expect(() => new SqliteSystemMemory({ databasePath: newer, systemId: 'grow' })).toThrow(/UNSUPPORTED_DATABASE/);
    expect(readMemoryView(newer)).toEqual({ ok: false, reason: 'unrecognized' });
    expect(pragmas(newer).version).toBe(2);

    const partial = join(workspace.directory, 'partial.sqlite');
    writeV1Database(partial, episode);
    const half = new DatabaseSync(partial);
    half.exec('ALTER TABLE memory_records ADD COLUMN valid_until TEXT');
    half.close();
    expect(() => new SqliteSystemMemory({ databasePath: partial, systemId: 'grow' })).toThrow(/UNSUPPORTED_DATABASE/);
    expect(pragmas(partial).columns.filter(name => TEMPORAL.includes(name))).toEqual(['valid_until']);
  });
});
