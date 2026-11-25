/**
 * Shared helpers of the dynamic-workflow twin simulations (W1-W5).
 *
 * Only the environment lives here: hashing, abortable sleeps, a stable deep-equality, CLI flags,
 * a bounded task pool and an independent oracle of the file journal's documented recovery rules.
 * Nothing here re-implements engine behaviour that a simulation then checks against itself.
 */
import { createHash } from 'node:crypto';

export const sha = (...parts) => createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');
/** A deterministic uniform in [0, 1) from the given parts. */
export const unit = (...parts) => Number.parseInt(sha(...parts).slice(0, 12), 16) / 2 ** 48;

/** Stable JSON (sorted keys) for deep equality of JSON values. */
export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
export const same = (a, b) => stable(a) === stable(b);

/** Resolves after `ms`, or rejects with `onAbort()` as soon as `signal` aborts. */
export function sleep(ms, signal, onAbort = () => signal?.reason ?? new Error('aborted')) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(onAbort()); return; }
    const abort = () => { clearTimeout(timer); reject(onAbort()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** `--seed N --trials N` and any other `--name value` flags. */
export function flags(defaults) {
  const out = { ...defaults };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[name] = true; continue; }
    out[name] = Number.isFinite(Number(next)) ? Number(next) : next;
    i++;
  }
  return out;
}

/** Runs `count` tasks with at most `width` at once; results in index order. */
export async function pool(count, width, task) {
  const results = new Array(count);
  let next = 0;
  const worker = async () => { while (next < count) { const index = next++; results[index] = await task(index); } };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
  return results;
}

export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// ---------------------------------------------------------------------------------------------------
// Journal oracle: written from the documented format of `fileDynamicJournal` (journal-file.ts header),
// independently of the SDK code: each line is canonical {"checksum","format":1,"record","runId"} with
// checksum = sha256(canonical({format, record, runId})). A corrupt or unterminated LAST line is a torn
// write (dropped); a corrupt line followed by more data refuses the run with DynamicJournalCorruptError.
// ---------------------------------------------------------------------------------------------------

const KEY = /^[A-Za-z0-9._:-]{1,256}$/;

function validLine(text, runId) {
  let entry;
  try { entry = JSON.parse(text); } catch { return undefined; }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  if (Object.keys(entry).sort().join(',') !== 'checksum,format,record,runId') return undefined;
  if (entry.format !== 1 || entry.runId !== runId) return undefined;
  if (entry.checksum !== sha(stable({ format: entry.format, record: entry.record, runId: entry.runId }))) return undefined;
  const record = entry.record;
  if (record === null || typeof record !== 'object' || typeof record.key !== 'string' || !KEY.test(record.key)) return undefined;
  if (!['completed', 'failed', 'skipped'].includes(record.status) || typeof record.cached !== 'boolean') return undefined;
  if (typeof record.durationMs !== 'number' || record.durationMs < 0 || !Object.hasOwn(record, 'output')) return undefined;
  return record;
}

/**
 * What the documented rules say opening this journal must do:
 * `{ refuse: true, line }` or `{ refuse: false, keys: Set<completed keys> }`.
 */
export function journalOracle(buffer, runId) {
  const keys = new Set();
  let offset = 0, line = 0;
  while (offset < buffer.length) {
    line++;
    const end = buffer.indexOf(0x0a, offset);
    if (end === -1) break;
    const record = validLine(buffer.subarray(offset, end).toString('utf8'), runId);
    if (!record) {
      if (end + 1 < buffer.length) return { refuse: true, line };
      break;
    }
    if (record.status === 'completed') keys.add(record.key);
    offset = end + 1;
  }
  return { refuse: false, keys, validBytes: offset };
}

/** Byte ranges of the newline-terminated lines of a buffer (without the newline). */
export function lineRanges(buffer) {
  const ranges = [];
  let offset = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf(0x0a, offset);
    if (end === -1) break;
    ranges.push([offset, end]);
    offset = end + 1;
  }
  return { ranges, tail: buffer.length - offset };
}

/** A well-formed journal line, as the documented format defines it (used to forge foreign-run lines). */
export function journalLine(runId, record) {
  const body = { format: 1, record, runId };
  return `${stable({ checksum: sha(stable(body)), ...body })}\n`;
}
