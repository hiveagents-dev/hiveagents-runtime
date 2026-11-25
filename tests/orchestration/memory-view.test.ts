import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hostMemoryPath, readMemoryView } from '../../src/orchestration/memory/view.js';
import { episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

it('reads absent and unrecognized files without creating or adopting them', () => {
  expect(readMemoryView(join(workspace.directory, 'none.sqlite'))).toEqual({ ok: false, reason: 'absent' });
  const foreign = join(workspace.directory, 'foreign.sqlite');
  writeFileSync(foreign, '');
  expect(readMemoryView(foreign)).toEqual({ ok: false, reason: 'unrecognized' });
});

it('summarizes each system: switch, counts, grants given and received, last change', async () => {
  const grow = workspace.open('grow'), marketing = workspace.open('marketing');
  await grow.enable({ by: 'operator' });
  await marketing.enable({ by: 'operator' });
  const scope = scopeOf('grow', 'lessons');
  await grow.put(episode('grow', 'e1', 'factura en pesos', { scope }));
  await grow.put(episode('grow', 'e2', 'cliente prefiere mail', { scope }));
  await grow.promote({ scope, id: 'e1', gate: await gateFor(grow, scope, 'e1'), by: 'operator' });
  await grow.grant({ to: 'marketing', namespace: 'lessons', by: 'operator' });

  const view = readMemoryView(workspace.databasePath);
  if (!view.ok) throw new Error(view.reason);
  const byId = Object.fromEntries(view.systems.map((s) => [s.systemId, s]));
  expect(byId.grow).toMatchObject({ enabled: true, observations: 2, lessons: 1 });
  expect(byId.grow!.given).toMatchObject([{ other: 'marketing', namespace: 'lessons', active: true }]);
  expect(byId.marketing).toMatchObject({ enabled: true, observations: 0, lessons: 0 });
  expect(byId.marketing!.received).toMatchObject([{ other: 'grow', namespace: 'lessons', active: true }]);
  expect(byId.grow!.changedAt).toBeGreaterThan(0);

  await grow.revokeGrant({ id: byId.grow!.given[0]!.id, by: 'operator' });
  await grow.disable({ by: 'operator' });
  const after = readMemoryView(workspace.databasePath);
  if (!after.ok) throw new Error(after.reason);
  const grow2 = after.systems.find((s) => s.systemId === 'grow')!;
  expect(grow2.enabled).toBe(false);
  expect(grow2.given[0]!.active).toBe(false);
});

it('the path helper honours OAR_HOST_MEMORY and defaults beside the ledger', () => {
  expect(hostMemoryPath({ OAR_HOST_MEMORY: '/x/m.sqlite' })).toBe('/x/m.sqlite');
  expect(() => hostMemoryPath({ OAR_HOST_MEMORY: 'rel.sqlite' })).toThrow();
  expect(hostMemoryPath({ OAR_HOST_LEDGER: '/y/admission.sqlite' })).toBe('/y/memory.sqlite');
});

it('counts as lessons only what recall can return at its now: not invalidated, not expired', async () => {
  const grow = workspace.open('grow');
  await grow.enable({ by: 'operator' });
  const scope = scopeOf('grow', 'lessons');
  await grow.put(episode('grow', 'vieja', 'factura en pesos', { scope }));
  await grow.put(episode('grow', 'temporal', 'tarifa de temporada', { scope, validUntil: '2026-12-01T00:00:00.000Z' }));
  await grow.put(episode('grow', 'nueva', 'factura en dólares', { scope, supersedes: ['vieja'] }));
  for (const id of ['vieja', 'temporal', 'nueva']) await grow.promote({ scope, id, gate: await gateFor(grow, scope, id), by: 'operator' });

  const counts = (now: number) => {
    const view = readMemoryView(workspace.databasePath, now);
    if (!view.ok) throw new Error(view.reason);
    return view.systems.map(({ systemId, observations, lessons }) => ({ systemId, observations, lessons }));
  };
  // `vieja` was superseded; `temporal` counts while valid, the instant itself included, and not after.
  expect(counts(Date.parse('2026-12-01T00:00:00.000Z'))).toEqual([{ systemId: 'grow', observations: 3, lessons: 2 }]);
  expect(counts(Date.parse('2026-12-01T00:00:00.001Z'))).toEqual([{ systemId: 'grow', observations: 3, lessons: 1 }]);
});

it('orders grants by instant even when an older build stored them with UTC offsets', async () => {
  const grow = workspace.open('grow');
  await grow.enable({ by: 'operator' });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(workspace.databasePath);
  try {
    // Grants are immutable: write them as an older build would have, with its clock's offset.
    // As strings 'a' sorts after 'b'; as instants 'a' (16:00Z) is older than 'b' (17:00Z).
    const insert = db.prepare(`INSERT INTO memory_grants (grant_id, owner, grantee, namespace, subject, granted_by, granted_at)
      VALUES (?, 'grow', ?, ?, '*', 'operator', ?)`);
    insert.run('g-b', 'support', 'b', '2026-01-04T12:00:00.000-05:00');
    insert.run('g-a', 'marketing', 'a', '2026-01-05T02:00:00.000+10:00');
  } finally { db.close(); }
  const view = readMemoryView(workspace.databasePath);
  if (!view.ok) throw new Error(view.reason);
  const grow2 = view.systems.find((s) => s.systemId === 'grow')!;
  expect(grow2.given.map((g) => g.namespace)).toEqual(['a', 'b']);
});
