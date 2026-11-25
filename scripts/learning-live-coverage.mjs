/** Exact source-declared cells, never display-name counts, determine comparable study coverage. */
export function learningMatrixCoverage(expected, rows, pendingCount) {
  const key = cell => JSON.stringify([cell.split, cell.taskDigest, cell.actionKey ?? cell.action.key]);
  const planned = new Set(expected.map(key)), observed = new Set(rows.map(key));
  const matrixComplete = expected.length === 32 && planned.size === 32 && rows.length === 32
    && pendingCount === 0 && observed.size === 32 && [...observed].every(cell => planned.has(cell));
  return { matrixComplete, verificationComplete: matrixComplete && rows.every(row => row.quality.state === 'verified') };
}
