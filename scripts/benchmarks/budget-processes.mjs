#!/usr/bin/env node
// Run: node --experimental-strip-types scripts/benchmarks/budget-processes.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SharedLaunchBudget } from '../../src/orchestration/budget/index.ts';
import { measureBudget } from '../../tests/orchestration/budget-fixtures/measure.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'oar-budget-benchmark-'));
const sourcePaths = [
  'src/orchestration/budget/index.ts', 'src/orchestration/budget/sqlite.ts', 'src/orchestration/budget/types.ts',
  'tests/orchestration/budget-fixtures/measure.ts', 'tests/orchestration/budget-fixtures/worker.ts',
  'tests/orchestration/budget.test.ts', 'tests/orchestration/budget-processes.test.ts',
  'scripts/benchmarks/budget-processes.mjs',
];
const baselinePaths = [
  'apps/marketing-swarm/electron/autonomy/host.ts',
  'apps/marketing-swarm/electron/autonomy/store.ts',
  'apps/marketing-swarm/electron/autonomy/supervisor.ts',
];
// The baseline is the Marketing app, which lives in the platform repository.
const baselineRoot = process.env.OAR_BASELINE_CHECKOUT;
assert.ok(baselineRoot, 'Set OAR_BASELINE_CHECKOUT to a checkout of the platform repository (it holds apps/marketing-swarm)');
const hashFiles = (paths, base = root) => Object.fromEntries(paths.map(path => [path,
  createHash('sha256').update(readFileSync(join(base, path))).digest('hex')]));

function storageLatency(rows) {
  const databasePath = join(directory, `latency-${rows}.db`);
  const budget = new SharedLaunchBudget({ databasePath, providers: {
    'test:latency': { maxConcurrent: 2, maxLaunchesPerHour: 50_000, maxLaunchesPerDay: 50_000, quotaCooldownMs: 60_000 },
  } });
  assert.equal(budget.status('test:latency').ok, true);
  const db = new DatabaseSync(databasePath);
  try {
    // Synthetic recent completed reservations, never provider calls.
    const insert = db.prepare(`INSERT INTO budget_reservations(token, provider_key, owner, admitted_at, released)
      VALUES (?, 'test:latency', 'synthetic-history', ?, 1)`);
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < rows; index++) insert.run(`fixture-${index}`, now);
    db.exec('COMMIT');
    const sample = operation => {
      const measurements = [];
      for (let index = 0; index < 50; index++) {
        const start = performance.now(); operation(); measurements.push(performance.now() - start);
      }
      measurements.sort((a, b) => a - b);
      return { samples: 50, p50Ms: +measurements[24].toFixed(3), p95Ms: +measurements[47].toFixed(3) };
    };
    return { retainedCompletedRows: rows,
      fullIntegrityCheck: sample(() => {
        assert.equal(db.prepare('PRAGMA quick_check(1)').get().quick_check, 'ok');
        assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
      }),
      completeStatusTransaction: sample(() => { assert.equal(budget.status('test:latency').ok, true); }),
    };
  } finally { db.close(); budget.close(); }
}

try {
  const baseline = await measureBudget('local', join(directory, 'unused.db'));
  const shared = await measureBudget('shared', join(directory, 'shared.db'));
  const hourly = await measureBudget('shared', join(directory, 'hourly.db'), 20, 20, 3, 100);
  const daily = await measureBudget('shared', join(directory, 'daily.db'), 20, 20, 100, 4);
  assert.equal(baseline.independentProcesses, 20);
  assert.equal(baseline.admitted, 20);
  assert.equal(baseline.maxSimultaneous, 20);
  assert.equal(shared.independentProcesses, 20);
  assert.equal(shared.admitted, 2);
  assert.equal(shared.maxSimultaneous, 2);
  assert.ok(shared.denialReasons.every(reason => reason === 'concurrency-limit'));
  assert.equal(hourly.admitted, 3);
  assert.ok(hourly.denialReasons.every(reason => reason === 'hourly-limit'));
  assert.equal(daily.admitted, 4);
  assert.ok(daily.denialReasons.every(reason => reason === 'daily-limit'));
  console.log(JSON.stringify({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    workload: 'synthetic independent-process IPC barrier; no provider execution, provider quota observation, or spend',
    methodology: 'Every admitted child holds its slot until all 20 processes decide; maximum simultaneous is the number still holding at that barrier.',
    limits: 'Safety/correctness evidence only. Elapsed time includes process startup; this is not a throughput or provider-quota benchmark.',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    source: {
      baseCommit: execFileSync('git', ['rev-parse', '171d67f2e3b4d10b2899ca9f32d426bbe570bfb9'], { cwd: root, encoding: 'utf8' }).trim(),
      candidateSha256: hashFiles(sourcePaths),
      appScopeReferenceSha256: hashFiles(baselinePaths, baselineRoot),
      baselineImplementation: 'Naive process-local active counter in budget-fixtures/worker.ts; synthetic scope baseline, not an execution of the app or Ruflo.',
      rufloDesignReference: {
        commit: '0a96fb8857dabd343d71d76c3ca703100a2923bc',
        path: 'v3/@claude-flow/cli/src/services/global-ai-budget.ts',
        sha256: '07bf10322979e8b883e68447506486247e0a9176946663f4087ca53fda360b9b',
        executed: false,
      },
    },
    measurements: { baseline, shared, hourly, daily },
    storageScaling: {
      workload: 'synthetic recent completed rows inserted directly for scaling measurement; no providers',
      caveat: 'Full-file integrity scans scale with all retained provider rows; status also includes locks, counts, clock persistence and retention cleanup.',
      measurements: [storageLatency(0), storageLatency(20_000)],
    },
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
