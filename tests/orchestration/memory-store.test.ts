import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteSystemMemory } from '../../src/orchestration/memory/system.js';
import type { MemoryPorts } from '../../src/orchestration/memory/index.js';
import { HASH, appendTexts, episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

async function enabled(systemId: string) {
  const memory = workspace.open(systemId);
  await memory.enable({ by: 'operator' });
  return memory;
}
/** Stores an episode and promotes it, so that recall can return it. */
async function lesson(memory: SqliteSystemMemory, tenant: string, id: string, text: string, namespace = 'lessons', subject?: string) {
  const scope = scopeOf(tenant, namespace, subject);
  await memory.put(episode(tenant, id, text, { scope }));
  await memory.promote({ scope, id, gate: await gateFor(memory, scope, id), by: 'operator' });
}
function rawCount(path: string, table: string): number {
  const db = new DatabaseSync(path);
  try { return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count); } finally { db.close(); }
}

describe('system memory: off by default', () => {
  it('gives empty results and refuses writes until the system enables it', async () => {
    const memory = workspace.open('grow');

    expect(await memory.status()).toEqual({ systemId: 'grow', enabled: false });
    await expect(memory.put(episode('grow', 'e1', 'factura en pesos'))).rejects.toMatchObject({ code: 'DISABLED' });
    await expect(memory.grant({ to: 'marketing', namespace: 'lessons', by: 'operator' })).rejects.toMatchObject({ code: 'DISABLED' });
    expect(rawCount(workspace.databasePath, 'memory_records')).toBe(0);
    expect(rawCount(workspace.databasePath, 'memory_grants')).toBe(0);
    expect(await memory.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toEqual([]);
    expect(await memory.list({ scope: scopeOf('grow') })).toEqual([]);
  });

  it('records who enabled it and when, and hides everything again when disabled', async () => {
    const memory = workspace.open('grow');
    await memory.enable({ by: 'operator' });
    const status = await memory.status();
    expect(status).toMatchObject({ systemId: 'grow', enabled: true, changedBy: 'operator' });
    expect(Date.parse(status.changedAt!)).not.toBeNaN();
    await lesson(memory, 'grow', 'e1', 'factura en pesos');
    expect(await memory.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toHaveLength(1);

    await memory.disable({ by: 'operator' });

    expect(await memory.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toEqual([]);
    expect(await memory.list({ scope: scopeOf('grow') })).toEqual([]);
    await expect(memory.put(episode('grow', 'e2', 'otra'))).rejects.toMatchObject({ code: 'DISABLED' });
    await memory.enable({ by: 'operator' });
    expect(await memory.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toHaveLength(1);
  });

  it('satisfies the existing persistence and recall ports', async () => {
    const memory = await enabled('grow');
    const ports: MemoryPorts = { persistence: memory, recall: memory };
    await ports.persistence!.put(episode('grow', 'e1', 'factura en pesos'));
    await memory.promote({ scope: scopeOf('grow'), id: 'e1', gate: await gateFor(memory, scopeOf('grow'), 'e1'), by: 'operator' });
    expect(await ports.recall!.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toHaveLength(1);
  });
});

describe('system memory: provenance and immutable episodes', () => {
  it('refuses a record without provenance or without a source to point at', async () => {
    const memory = await enabled('grow');
    const { provenance, ...withoutProvenance } = episode('grow', 'e1', 'texto');
    const { inputHash: _, ...withoutSource } = provenance;

    await expect(memory.put(withoutProvenance as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.put(episode('grow', 'e1', 'texto', { provenance: withoutSource }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.put(episode('grow', 'e1', 'texto', { provenance: { ...provenance, inputHash: 'short' } }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.put(episode('grow', 'e1', 'texto', { provenance: { ...provenance, observedAt: 'ayer' } }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(rawCount(workspace.databasePath, 'memory_records')).toBe(0);
  });

  it('returns each record with the provenance it was stored with, across reopen', async () => {
    const log = workspace.openLog('grow');
    const receipt = await appendTexts(log, 'grow', 'one', ['factura en pesos']);
    const memory = await enabled('grow');
    const provenance = { source: 'run-log', sourceVersion: '1', observedAt: '2026-11-10T10:00:00.000Z', logPosition: receipt.first };
    await memory.put(episode('grow', 'e1', 'factura en pesos', { provenance, metadata: { tags: ['cobro'] } }));
    await memory.promote({ scope: scopeOf('grow'), id: 'e1', gate: await gateFor(memory, scopeOf('grow'), 'e1'), by: 'operator' });
    memory.close();

    const reopened = workspace.open('grow');
    const [record] = await reopened.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 });

    expect(record).toEqual({
      id: 'e1', scope: scopeOf('grow'), text: 'factura en pesos', provenance, metadata: { tags: ['cobro'] },
    });
  });

  it('keeps an episode immutable: same content is idempotent, different content is refused', async () => {
    const memory = await enabled('grow');
    await memory.put(episode('grow', 'e1', 'factura en pesos'));
    await memory.put(episode('grow', 'e1', 'factura en pesos'));
    await expect(memory.put(episode('grow', 'e1', 'factura en dólares'))).rejects.toMatchObject({ code: 'CONFLICT' });

    const [view] = await memory.list({ scope: scopeOf('grow') });
    expect(view!.record.text).toBe('factura en pesos');
    expect(view!.state).toBe('episode');
    expect(rawCount(workspace.databasePath, 'memory_records')).toBe(1);
  });

  it('enforces immutability and final withdrawal in the database itself', async () => {
    const memory = await enabled('grow');
    await memory.put(episode('grow', 'e1', 'factura en pesos'));
    await memory.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'pedido del operador' });

    const raw = new DatabaseSync(workspace.databasePath);
    try {
      expect(() => raw.exec("UPDATE memory_records SET text = 'otra cosa'")).toThrow(/immutable/);
      expect(() => raw.exec("UPDATE memory_records SET provenance_json = '{}'")).toThrow(/immutable/);
      expect(() => raw.exec('DELETE FROM memory_records')).toThrow(/immutable/);
      expect(() => raw.exec('UPDATE memory_records SET revoked_at = NULL')).toThrow(/final/);
    } finally { raw.close(); }
  });

  it('refuses, from any connection, to replace a record or to make a lesson without evidence of a gain', async () => {
    const memory = await enabled('grow');
    await memory.put(episode('grow', 'e1', 'factura en pesos'));
    await memory.put(episode('grow', 'e2', 'episodio nunca medido'));
    await memory.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'pedido del operador' });
    await memory.grant({ to: 'marketing', namespace: 'lessons', by: 'sebastian' });
    const columns = 'tenant, namespace, subject, id, text, content_digest, provenance_json, input_hash, recorded_at';
    const values = `'grow', 'lessons', '', 'e1', 'REESCRITO', '${HASH}', '{}', '${HASH}', '2026-11-10T12:00:00.000Z'`;
    const promote = (gate: string) =>
      `UPDATE memory_records SET promoted_at = '2026-11-10T12:00:00.000Z', promoted_by = 'x', gate_json = '${gate}' WHERE id = 'e2'`;

    const raw = new DatabaseSync(workspace.databasePath);
    try {
      // REPLACE deletes the old row without firing the DELETE trigger; the INSERT trigger is what stops it.
      expect(() => raw.exec(`INSERT OR REPLACE INTO memory_records (${columns}) VALUES (${values})`)).toThrow(/immutable/);
      expect(() => raw.exec(`INSERT INTO memory_records (${columns}, promoted_at, promoted_by, gate_json) VALUES (${values.replace("'e1'", "'e9'")}, 'x', 'x', '{}')`)).toThrow(/starts as an episode/);
      expect(() => raw.exec(promote('{}'))).toThrow(/constraint/i);
      expect(() => raw.exec(promote('{"noMemory":{"passed":2},"memory":{"passed":2}}'))).toThrow(/constraint/i);
      expect(() => raw.exec("INSERT OR REPLACE INTO memory_grants SELECT grant_id, owner, grantee, namespace, 'otro', granted_by, granted_at, NULL, NULL FROM memory_grants")).toThrow(/immutable/);
    } finally { raw.close(); }

    expect(await memory.list({ scope: scopeOf('grow') })).toMatchObject([{ state: 'episode', record: { id: 'e2', text: 'episodio nunca medido' } }]);
    expect(await memory.query({ scope: scopeOf('grow'), text: 'episodio factura REESCRITO', limit: 5 })).toEqual([]);
    expect(await memory.listGrants()).toMatchObject([{ namespace: 'lessons' }]);
    expect((await memory.listGrants())[0]!.subject).toBeUndefined();
  });

  it('withdraws the log entry a record pointed at even when the record carried a wrong digest for it', async () => {
    const log = workspace.openLog('grow');
    const receipt = await appendTexts(log, 'grow', 'one', ['factura en pesos']);
    const memory = await enabled('grow');
    const fabricated = { ...receipt.first, digest: 'c'.repeat(64) };
    const provenance = { source: 'run-log', sourceVersion: '1', observedAt: '2026-11-10T10:00:00.000Z', logPosition: fabricated };
    // put cannot check a position against the log: it has no handle on it. It accepts the pointer as given.
    await memory.put(episode('grow', 'e1', 'texto inventado', { provenance }));
    expect((await memory.searchLog(log, { text: 'factura' })).matches).toHaveLength(1);

    await memory.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'error' });

    expect((await memory.searchLog(log, { text: 'factura' })).matches).toEqual([]);
    const honest = { ...provenance, logPosition: receipt.first };
    await expect(memory.put(episode('grow', 'e2', 'factura en pesos', { provenance: honest }))).rejects.toMatchObject({ code: 'WITHDRAWN' });
  });

  it('lets a scope change its embedding space once every record of the old one is withdrawn', async () => {
    const memory = await enabled('grow');
    const identity = { provider: 'local', model: 'mini', revision: '1', dimensions: 2 };
    const next = { ...identity, revision: '2' };
    await memory.put(episode('grow', 'viejo', 'nota uno', { embedding: { identity, values: [1, 0] } }));
    await expect(memory.put(episode('grow', 'nuevo', 'nota dos', { embedding: { identity: next, values: [0, 1] } }))).rejects.toMatchObject({ code: 'EMBEDDING_MISMATCH' });

    await memory.revoke({ scope: scopeOf('grow'), id: 'viejo', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'cambio de modelo' });
    await memory.put(episode('grow', 'nuevo', 'nota dos', { embedding: { identity: next, values: [0, 1] } }));
    await memory.promote({ scope: scopeOf('grow'), id: 'nuevo', gate: await gateFor(memory, scopeOf('grow'), 'nuevo'), by: 'operator' });

    const recalled = await memory.query({ scope: scopeOf('grow'), text: 'sin coincidencia', limit: 1, embedding: { identity: next, values: [0, 1] } });
    expect(recalled.map(record => record.id)).toEqual(['nuevo']);
  });

  it('refuses to bring back a withdrawn record under the same id or from the same log entry', async () => {
    const log = workspace.openLog('grow');
    const receipt = await appendTexts(log, 'grow', 'one', ['factura en pesos']);
    const memory = await enabled('grow');
    const provenance = { source: 'run-log', sourceVersion: '1', observedAt: '2026-11-10T10:00:00.000Z', logPosition: receipt.first };
    await memory.put(episode('grow', 'e1', 'factura en pesos', { provenance }));
    await memory.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'error' });

    await expect(memory.put(episode('grow', 'e1', 'factura en pesos', { provenance }))).rejects.toMatchObject({ code: 'WITHDRAWN' });
    await expect(memory.put(episode('grow', 'e2', 'factura en pesos', { provenance }))).rejects.toMatchObject({ code: 'WITHDRAWN' });
    await expect(memory.revoke({ scope: scopeOf('grow'), id: 'nunca', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Revoking twice keeps the first tombstone.
    await memory.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T12:00:00.000Z', reason: 'otra vez' });
  });

  it('never compares vectors from different embedding spaces', async () => {
    const memory = await enabled('grow');
    const identity = { provider: 'local', model: 'mini', revision: '1', dimensions: 2 };
    const other = { ...identity, revision: '2' };
    await expect(memory.put(episode('grow', 'bad', 'x', { embedding: { identity, values: [1, 0, 0] } }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await memory.put(episode('grow', 'cobro', 'nota uno', { embedding: { identity, values: [1, 0] } }));
    await memory.put(episode('grow', 'envio', 'nota dos', { embedding: { identity, values: [0, 1] } }));
    await expect(memory.put(episode('grow', 'e3', 'nota tres', { embedding: { identity: other, values: [1, 0] } }))).rejects.toMatchObject({ code: 'EMBEDDING_MISMATCH' });
    for (const id of ['cobro', 'envio']) await memory.promote({ scope: scopeOf('grow'), id, gate: await gateFor(memory, scopeOf('grow'), id), by: 'operator' });

    const semantic = await memory.query({ scope: scopeOf('grow'), text: 'sin coincidencia léxica', limit: 1, embedding: { identity, values: [0, 1] } });
    expect(semantic.map(record => record.id)).toEqual(['envio']);
    expect(semantic[0]!.embedding).toEqual({ identity, values: [0, 1] });
    await expect(memory.query({ scope: scopeOf('grow'), text: 'nota', limit: 1, embedding: { identity: other, values: [0, 1] } })).rejects.toMatchObject({ code: 'EMBEDDING_MISMATCH' });
  });
});

describe('system memory: exact scope, deny by default, explicit grants', () => {
  it('reads only the exact scope: tenant, namespace and subject', async () => {
    const memory = await enabled('grow');
    await lesson(memory, 'grow', 'e1', 'factura del cliente uno', 'lessons', 'cliente-1');

    const ask = (namespace: string, subject?: string) => memory.query({ scope: scopeOf('grow', namespace, subject), text: 'factura', limit: 5 });
    expect(await ask('lessons', 'cliente-1')).toHaveLength(1);
    expect(await ask('lessons')).toEqual([]);
    expect(await ask('lessons', 'cliente-2')).toEqual([]);
    expect(await ask('otro', 'cliente-1')).toEqual([]);
    expect(await memory.list({ scope: scopeOf('grow', 'lessons') })).toEqual([]);
    expect(await memory.list({ scope: scopeOf('grow', 'lessons', 'cliente-1') })).toHaveLength(1);
  });

  it('gives another system nothing, and refuses its writes, without a grant', async () => {
    const grow = await enabled('grow');
    const marketing = await enabled('marketing');
    await lesson(grow, 'grow', 'e1', 'factura en pesos');

    expect(await marketing.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toEqual([]);
    expect(await marketing.list({ scope: scopeOf('grow') })).toEqual([]);
    await expect(marketing.put(episode('grow', 'intruso', 'texto'))).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await expect(marketing.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await expect(marketing.promote({ scope: scopeOf('grow'), id: 'e1', gate: await gateFor(grow, scopeOf('grow'), 'e1'), by: 'x' })).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await expect(marketing.rollback({ scope: scopeOf('grow'), id: 'e1', by: 'x', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(await grow.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toHaveLength(1);
  });

  it('shares lessons only through an explicit grant that records who granted it and when', async () => {
    const grow = await enabled('grow');
    const marketing = await enabled('marketing');
    await lesson(grow, 'grow', 'e1', 'factura en pesos');

    const grant = await grow.grant({ to: 'marketing', namespace: 'lessons', by: 'sebastian' });

    expect(grant).toMatchObject({ owner: 'grow', grantee: 'marketing', namespace: 'lessons', grantedBy: 'sebastian' });
    expect(Date.parse(grant.grantedAt)).not.toBeNaN();
    expect(grant.subject).toBeUndefined();
    const shared = await marketing.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 });
    expect(shared.map(record => record.id)).toEqual(['e1']);
    expect(shared[0]!.scope.tenant).toBe('grow');
    expect(await grow.listGrants()).toEqual([grant]);
    expect(await marketing.listGrants()).toEqual([grant]);
    expect(await (await enabled('otro')).listGrants()).toEqual([]);
  });

  it('keeps a grant to its exact scope and to recall only', async () => {
    const grow = await enabled('grow');
    const marketing = await enabled('marketing');
    await lesson(grow, 'grow', 'general', 'factura general');
    await lesson(grow, 'grow', 'privada', 'factura privada', 'privado');
    await lesson(grow, 'grow', 'cliente', 'factura del cliente', 'lessons', 'cliente-1');
    await grow.put(episode('grow', 'borrador', 'factura sin promover'));
    await grow.grant({ to: 'marketing', namespace: 'lessons', by: 'sebastian' });

    const ask = (namespace: string, subject?: string) => marketing.query({ scope: scopeOf('grow', namespace, subject), text: 'factura', limit: 5 });
    expect((await ask('lessons')).map(record => record.id)).toEqual(['general']);
    expect(await ask('privado')).toEqual([]);
    expect(await ask('lessons', 'cliente-1')).toEqual([]);
    expect(await marketing.list({ scope: scopeOf('grow') })).toEqual([]);
    await expect(marketing.put(episode('grow', 'intruso', 'texto'))).rejects.toMatchObject({ code: 'NOT_OWNER' });
    expect(await (await enabled('otro')).query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toEqual([]);
  });

  it('makes a revoked grant take effect at once on a connection that was already open', async () => {
    const grow = await enabled('grow');
    const marketing = await enabled('marketing');
    await lesson(grow, 'grow', 'e1', 'factura en pesos');
    const grant = await grow.grant({ to: 'marketing', namespace: 'lessons', by: 'sebastian' });
    expect(await marketing.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toHaveLength(1);

    await expect(marketing.revokeGrant({ id: grant.id, by: 'intruso' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await grow.revokeGrant({ id: grant.id, by: 'sebastian' });

    expect(await marketing.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toEqual([]);
    expect(await grow.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 })).toHaveLength(1);
    const [recorded] = await grow.listGrants();
    expect(recorded).toMatchObject({ id: grant.id, revokedBy: 'sebastian' });
    expect(Date.parse(recorded!.revokedAt!)).not.toBeNaN();
    const raw = new DatabaseSync(workspace.databasePath);
    try { expect(() => raw.exec('UPDATE memory_grants SET revoked_at = NULL')).toThrow(/final/); } finally { raw.close(); }
  });

  it('gives a grantee nothing while either side has memory switched off', async () => {
    const grow = await enabled('grow');
    const marketing = workspace.open('marketing');
    await lesson(grow, 'grow', 'e1', 'factura en pesos');
    await grow.grant({ to: 'marketing', namespace: 'lessons', by: 'sebastian' });
    const ask = () => marketing.query({ scope: scopeOf('grow'), text: 'factura', limit: 5 });

    // A system that never enabled memory learns nothing, not even that a scope was shared with it.
    expect(await ask()).toEqual([]);
    expect(await marketing.listGrants()).toEqual([]);
    await marketing.enable({ by: 'operator' });
    expect(await ask()).toHaveLength(1);
    expect(await marketing.listGrants()).toHaveLength(1);
    await grow.disable({ by: 'operator' });
    expect(await ask()).toEqual([]);
    expect(await marketing.listGrants()).toEqual([]);
    // The owner still sees what it shared, so it can revoke it without switching memory on.
    const [given] = await grow.listGrants();
    await grow.revokeGrant({ id: given!.id, by: 'sebastian' });
    expect(await grow.listGrants()).toMatchObject([{ id: given!.id, revokedBy: 'sebastian' }]);
  });

  it('rejects malformed input at the boundary instead of guessing', async () => {
    const memory = await enabled('grow');
    await expect(memory.query({ scope: { tenant: 'grow' } as never, text: 'a', limit: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.query({ scope: scopeOf('grow'), text: 'a', limit: -1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.query({ scope: { ...scopeOf('grow'), extra: 1 } as never, text: 'a', limit: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.put(episode('grow', '', 'texto'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.put(episode('grow', 'e1', ''))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.put(episode('grow', 'e1', 'x', { revokedAt: '2026-11-10T11:00:00.000Z' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.grant({ to: 'grow', namespace: 'lessons', by: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.enable({} as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const aborted = AbortSignal.abort();
    await expect(memory.put(episode('grow', 'e1', 'x'), aborted)).rejects.toThrow();
    await expect(memory.query({ scope: scopeOf('grow'), text: 'a', limit: 1, signal: aborted })).rejects.toThrow();
    expect(await memory.list({ scope: scopeOf('grow') })).toEqual([]);
  });

  it('refuses names that carry control characters or edge whitespace, and keeps ordinary names in any script', async () => {
    const memory = await enabled('grow');
    // Names are written to audit fields and shown on a console.
    for (const bad of ['a\nb', 'a\u0000b', 'a\tb', ' a', 'a ', 'a​b', 'a b', 'a\u001b[31m']) {
      await expect(memory.put(episode('grow', bad, 'texto'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(memory.put(episode('grow', 'e1', 'texto', { scope: scopeOf('grow', bad) }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(memory.put(episode('grow', 'e1', 'texto', { scope: scopeOf('grow', 'lessons', bad) }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(memory.grant({ to: 'marketing', namespace: 'lessons', subject: bad, by: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(memory.grant({ to: 'marketing', namespace: 'lessons', by: bad })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(memory.enable({ by: bad })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(() => workspace.open(bad)).toThrow(/INVALID_INPUT/);
    }
    expect(rawCount(workspace.databasePath, 'memory_records')).toBe(0);
    expect(rawCount(workspace.databasePath, 'memory_grants')).toBe(0);

    const scope = scopeOf('grow', 'clientes vip', 'ACME S.A. (año 1)');
    await memory.put(episode('grow', 'lección-ñ_1.v2:α/β@x', 'texto', { scope }));
    expect((await memory.list({ scope })).map(view => view.record.id)).toEqual(['lección-ñ_1.v2:α/β@x']);
  });

  it('refuses a database it did not create and options it cannot honour', () => {
    const foreign = join(workspace.directory, 'foreign.sqlite');
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE application_state(id INTEGER)');
    db.close();
    const empty = join(workspace.directory, 'empty.sqlite');
    writeFileSync(empty, '');

    expect(() => new SqliteSystemMemory({ databasePath: foreign, systemId: 'grow' })).toThrow(/UNSUPPORTED_DATABASE/);
    expect(() => new SqliteSystemMemory({ databasePath: empty, systemId: 'grow' })).toThrow(/UNSUPPORTED_DATABASE/);
    expect(() => new SqliteSystemMemory({ databasePath: 'relative.sqlite', systemId: 'grow' })).toThrow(/INVALID_INPUT/);
    expect(() => new SqliteSystemMemory({ databasePath: workspace.databasePath, systemId: '' })).toThrow(/INVALID_INPUT/);
    expect(() => new SqliteSystemMemory({ databasePath: workspace.databasePath, systemId: 'grow', maxLessonsPerRecall: 0 })).toThrow(/INVALID_INPUT/);
  });

  it('refuses every call after close', async () => {
    const memory = await enabled('grow');
    memory.close();
    memory.close();
    await expect(memory.query({ scope: scopeOf('grow'), text: 'a', limit: 1 })).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(memory.put(episode('grow', 'e1', 'x'))).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(memory.status()).rejects.toMatchObject({ code: 'CLOSED' });
  });
});
