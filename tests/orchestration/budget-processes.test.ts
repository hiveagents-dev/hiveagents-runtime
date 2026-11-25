import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { measureBudget } from './budget-fixtures/measure.ts';

const dirs: string[] = [];
function ledger() { const dir = mkdtempSync(join(tmpdir(), 'oar-budget-process-')); dirs.push(dir); return join(dir, 'budget.db'); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('independent per-app counters admit 20 simultaneous launches despite a desired shared cap of two', async () => {
  const result = await measureBudget('local', ledger());
  expect(result).toMatchObject({ independentProcesses: 20, admitted: 20, denied: 0, maxSimultaneous: 20 });
}, 20_000);

test('one shared ledger admits only two of 20 independent processes holding overlapping operations', async () => {
  const result = await measureBudget('shared', ledger());
  expect(result).toMatchObject({ independentProcesses: 20, admitted: 2, denied: 18, maxSimultaneous: 2 });
  expect(new Set(result.denialReasons)).toEqual(new Set(['concurrency-limit']));
}, 20_000);

test.each([
  { hour: 3, day: 100, admitted: 3, reason: 'hourly-limit' },
  { hour: 100, day: 4, admitted: 4, reason: 'daily-limit' },
])('rolling limits are atomic between processes: $reason', async ({ hour, day, admitted, reason }) => {
  const result = await measureBudget('shared', ledger(), 20, 20, hour, day);
  expect(result.independentProcesses).toBe(20);
  expect(result.admitted).toBe(admitted);
  expect(new Set(result.denialReasons)).toEqual(new Set([reason]));
}, 20_000);
