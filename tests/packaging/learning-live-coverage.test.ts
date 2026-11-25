import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const { learningMatrixCoverage } = await import(pathToFileURL(resolve('scripts/learning-live-coverage.mjs')).href);
const expected = Array.from({ length: 32 }, (_, n) => ({ split: 'fresh', taskDigest: `task-${n >> 1}`, actionKey: n % 2 ? 'sonnet-key' : 'sol-key' }));
const rows = expected.map(cell => ({ ...cell, action: { id: cell.actionKey === 'sol-key' ? 'sol' : 'sonnet', key: cell.actionKey }, quality: { state: 'verified' } }));
it('requires the full prospective canonical task/action/split matrix without pending or unknown cells', () => {
  expect(learningMatrixCoverage(expected, rows, 0)).toEqual({ matrixComplete: true, verificationComplete: true });
  expect(learningMatrixCoverage(expected, rows.slice(0, 16), 0).matrixComplete).toBe(false);
  expect(learningMatrixCoverage(expected, rows, 1).matrixComplete).toBe(false);
  expect(learningMatrixCoverage(expected, rows.map((r, n) => n ? r : { ...r, quality: { state: 'unknown' } }), 0).verificationComplete).toBe(false);
});
it('rejects display-identical rows with changed execution keys, wrong task hashes or duplicate cells', () => {
  const drift = rows.map((r, n) => n ? r : { action: { ...r.action, key: 'changed-executable-key' }, split: r.split, taskDigest: r.taskDigest, quality: r.quality });
  expect(learningMatrixCoverage(expected, drift, 0).matrixComplete).toBe(false);
  expect(learningMatrixCoverage(expected, rows.map((r, n) => n ? r : { ...r, taskDigest: 'unexpected-task' }), 0).matrixComplete).toBe(false);
  expect(learningMatrixCoverage(expected, rows.map((r, n) => n ? r : rows[1]), 0).matrixComplete).toBe(false);
});
