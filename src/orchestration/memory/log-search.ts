import type { LogCursor, LogEntry, LogPage, LogQuery, LogSourceDescriptor } from '../log/store-types.js';
import type { LogJsonValue, LogPosition } from '../log/types.js';
import { rankMemories } from './ranker.js';
import type { MemoryLogMatch } from './store-types.js';
import type { CapturedLogSearch } from './validation.js';

/** The part of the run-log store this search needs. `SqliteRunLogStore` satisfies it. */
export interface RunLogReader {
  readonly descriptor: LogSourceDescriptor;
  readPage(query?: LogQuery): Promise<LogPage>;
}

/** A scanned entry that shares at least one word with the query. */
export interface LogCandidate {
  position: LogPosition;
  entry: LogEntry;
  text: string;
}

export interface LogScan {
  candidates: LogCandidate[];
  scanned: number;
  complete: boolean;
  nextCursor?: LogCursor;
}

const PAGE_SIZE = 256;
const MAX_SEARCHABLE_CHARS = 8192;

function collectStrings(value: LogJsonValue, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

/**
 * What a search can match in one entry: its type and every string of its inline
 * payload. An artifact payload lives outside the log, so only its type matches.
 */
function searchableText(entry: LogEntry): string {
  const parts = [entry.record.type];
  if ('inline' in entry.record.payload) collectStrings(entry.record.payload.inline, parts);
  return parts.join('\n').slice(0, MAX_SEARCHABLE_CHARS);
}

/**
 * Internal to the store: this reads the log with no off switch and no withdrawal
 * filter. `SqliteSystemMemory.searchLog` is the only read path built on it.
 *
 * Reads the log forward, page by page, and keeps the entries of `systemId` that
 * share a word with the query. Plain text only: accent-folded whole words, the
 * ranker's tokenisation. Bounded by `maxScanned`; `nextCursor` continues the scan.
 */
export async function scanRunLog(log: RunLogReader, systemId: string, search: CapturedLogSearch): Promise<LogScan> {
  const candidates: LogCandidate[] = [];
  let cursor = search.cursor;
  let scanned = 0;
  let complete = false;
  while (scanned < search.maxScanned) {
    const page = await log.readPage({
      ...search.filter,
      limit: Math.min(PAGE_SIZE, search.maxScanned - scanned),
      ...(cursor ? { cursor } : {}),
    });
    scanned += page.scanned;
    const own = page.items
      .filter(entry => entry.record.identity.systemId === systemId && entry.sourceId === log.descriptor.sourceId)
      .map(entry => ({
        id: String(entry.sequence),
        text: searchableText(entry),
        entry,
      }));
    // The ranker returns only documents that share a word with the query.
    for (const { record } of rankMemories(search.text, own, { limit: own.length })) {
      candidates.push({
        position: { sourceId: record.entry.sourceId, sequence: record.entry.sequence, digest: record.entry.digest },
        entry: record.entry,
        text: record.text,
      });
    }
    cursor = page.nextCursor;
    if (!cursor || page.scanned === 0) {
      complete = !cursor;
      break;
    }
  }
  return { candidates, scanned, complete, ...(cursor && !complete ? { nextCursor: cursor } : {}) };
}

/** Internal to the store. Orders the surviving candidates by BM25 among themselves; ties keep log order. */
export function rankLogCandidates(text: string, candidates: readonly LogCandidate[], limit: number): MemoryLogMatch[] {
  const documents = candidates.map(candidate => ({ id: String(candidate.position.sequence), text: candidate.text, candidate }));
  return rankMemories(text, documents, { limit }).map(({ record, scores }) => ({
    position: record.candidate.position,
    entry: record.candidate.entry,
    text: record.candidate.text,
    score: scores.lexical,
  }));
}
