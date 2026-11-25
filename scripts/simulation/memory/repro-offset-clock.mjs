/**
 * Minimal repro (not a hypothesis): `SqliteSystemMemory` accepts an injected clock that returns
 * ISO-8601 with a UTC offset (validation `timestamp()` only checks the prefix and Date.parse), but
 * stores `recorded_at` / `promoted_at` as the raw string and orders `list` (recorded_at DESC) and
 * the recall pool (promoted_at DESC, LIMIT 512) by string. With offsets that differ between calls,
 * "newest first" is no longer chronological. Comparisons that matter for expiry go through `utc()`
 * and are not affected (see temporal.mjs).
 *
 *   node scripts/simulation/memory/repro-offset-clock.mjs
 */
import { join } from 'node:path';
import { emit, sdk } from '../lib/sim.mjs';
import { scratchDir } from './lib-env.mjs';

const { SqliteSystemMemory } = await sdk('orchestration/index');
const times = [
  '2026-01-05T02:00:00.000+10:00', // older: 2026-01-04T16:00Z
  '2026-01-04T12:00:00.000-05:00', // newer: 2026-01-04T17:00Z
];
let call = 0;
let current = times[0];
const store = new SqliteSystemMemory({ databasePath: join(scratchDir(), 'm.sqlite'), systemId: 'twin', now: () => { call += 1; return current; } });
await store.enable({ by: 'twin' });
const scope = { tenant: 'twin', namespace: 'n' };
const record = (id, text) => ({
  id, scope, text, provenance: { source: 'operator-note', sourceVersion: '1', observedAt: '2026-01-04T00:00:00.000Z', inputHash: 'a'.repeat(64) },
});
await store.put(record('older', 'stored at 16:00Z'));
current = times[1];
await store.put(record('newer', 'stored at 17:00Z'));
const listed = (await store.list({ scope })).map(view => ({ id: view.record.id, recordedAt: view.recordedAt, utc: new Date(view.recordedAt).toISOString() }));
store.close();
emit('memory/repro-offset-clock', [{
  finding: 'list() newest-first order follows the raw clock string, not the instant',
  expected: ['newer', 'older'],
  actual: listed.map(x => x.id),
  reproduced: listed[0].id !== 'newer',
  listed,
}]);
