import { types } from 'node:util';
import { canonical, freeze, hash, method, object } from '../../shared/json.js';
import { captureIdentity, boundedInteger, invalidCapture } from './capture-codec.js';
import { capture, decodeEntry, digest, entryBody, genesis } from './encoding.js';
import type { LogEntry, LogPage, LogQuery, LogSourceDescriptor } from './store-types.js';
import type { LogPosition } from './types.js';
import type { LogProjection, LogProjectionOptions, LogProjectionPage, ProjectionCursor, ProjectionIssue, ProjectionItem, ProjectionPurpose } from './projection-types.js';
import { projectCommittedEntry } from './projection-codecs.js';
import { captureProjectionPage, dataArray, projectionCursor as cursor, projectionPosition as position, projectionSource as descriptor, sameProjectionData as same } from './projection-data.js';
import { coherentReconciliation } from './projection-reconciliation.js';

const MAX_LINKS = 32768, MAX_BYTES = 4 * 1024 * 1024;
function checkedEntry(input: unknown, source: LogSourceDescriptor): LogEntry {
  object(input, ['format', 'sourceId', 'sequence', 'digest', 'requestId', 'ordinal', 'previousDigest', 'record']);
  const commit = capture({ requestId: input.requestId, records: [input.record] }, source); hash(input.digest); hash(input.previousDigest);
  if (input.format !== 1 || input.sourceId !== source.sourceId) invalidCapture();
  boundedInteger(input.sequence, 1, Number.MAX_SAFE_INTEGER); boundedInteger(input.ordinal, 1, 256);
  return decodeEntry(canonical(entryBody(source, input.sequence as number, commit.requestId, input.ordinal as number, input.previousDigest, commit.records[0]!)), input.digest, source);
}
/** Source reader is a trusted committed-store DATA port. Structural pages alone never grant execution permission. */
export function createLogProjector(purpose: ProjectionPurpose, options: LogProjectionOptions) {
  object(options, ['reader', 'identity', 'maxPages', 'maxEntries']);
  const identity = captureIdentity(options.identity), identityDigest = digest(canonical(identity));
  if (!options.reader || typeof options.reader !== 'object' || types.isProxy(options.reader)) invalidCapture();
  const sourceDescriptor = Object.getOwnPropertyDescriptor(options.reader, 'descriptor');
  if (!sourceDescriptor || !Object.hasOwn(sourceDescriptor, 'value')) invalidCapture(); const source = descriptor(sourceDescriptor.value);
  if (source.systemId !== identity.systemId) invalidCapture();
  const readPage = method<(query: LogQuery) => Promise<LogPage>>(options.reader, 'readPage');
  const maxPages = boundedInteger(options.maxPages ?? 128, 1, 128), maxEntries = boundedInteger(options.maxEntries ?? 10000, 1, 10000);
  async function read(input: { cursor?: ProjectionCursor; limit?: number } = {}): Promise<LogProjectionPage> {
    object(input, ['cursor', 'limit']); const limit = Math.min(boundedInteger(input.limit ?? 32, 1, 256), 32);
    const saved = input.cursor === undefined ? undefined : cursor(input.cursor, purpose, identityDigest, source);
    const from = saved?.underlying.after ?? { sourceId: source.sourceId, sequence: 0, digest: genesis(source) };
    let through = saved?.underlying.through ?? from;
    const links: LogProjectionPage['links'][number][] = [], items: LogProjectionPage['items'][number][] = [], issues: ProjectionIssue[] = [];
    let nextCursor: ProjectionCursor | undefined;
    try {
      const page = await readPage({ limit, ...(saved ? { cursor: saved.underlying } : {}) });
      object(page, ['source', 'through', 'items', 'scanned', 'nextCursor']);
      if (!same(descriptor(page.source), source)) invalidCapture(); through = position(page.through, source);
      if (saved && !same(through, saved.underlying.through) || through.sequence < from.sequence) invalidCapture();
      const entries = dataArray(page.items, limit); if (page.scanned !== entries.length) invalidCapture();
      let previous = from;
      for (const raw of entries) {
        const entry = checkedEntry(raw, source);
        if (entry.sequence !== previous.sequence + 1 || entry.previousDigest !== previous.digest || entry.sequence > through.sequence) invalidCapture();
        const at = { sourceId: entry.sourceId, sequence: entry.sequence, digest: entry.digest }; links.push({ position: at, previousDigest: entry.previousDigest }); previous = at;
        if (same(entry.record.identity, identity)) items.push(projectCommittedEntry(entry));
      }
      if (page.nextCursor !== undefined) {
        nextCursor = cursor({ format: 1, purpose, identityDigest, source, underlying: page.nextCursor }, purpose, identityDigest, source);
        if (!same(nextCursor.underlying.after, previous) || !same(nextCursor.underlying.through, through) || previous.sequence >= through.sequence || !links.length) invalidCapture();
      } else if (!same(previous, through)) invalidCapture();
    } catch (error) {
      const code = error && typeof error === 'object' && !types.isProxy(error) ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
      issues.push(code && Object.hasOwn(code, 'value') && ['STORAGE', 'CLOSED', 'BUSY'].includes(code.value) ? 'SOURCE_UNAVAILABLE' : 'LOG_CORRUPT');
      nextCursor = undefined;
    }
    return freeze({ format: 1, purpose, identityDigest, source, from, through, links, items, issues, ...(nextCursor ? { nextCursor } : {}) });
  }
  async function rebuild(input: { limit?: number } = {}): Promise<LogProjection> {
    object(input, ['limit']); const requestedLimit = boundedInteger(input.limit ?? 32, 1, 256);
    const pages: LogProjectionPage[] = []; let next: ProjectionCursor | undefined, bytes = 0, entries = 0;
    for (let count = 0; count < maxPages; count++) {
      const page = await read({ limit: Math.min(requestedLimit, maxEntries - entries), ...(next ? { cursor: next } : {}) });
      const pageBytes = Buffer.byteLength(canonical(page));
      if (pages.length && bytes + pageBytes > MAX_BYTES) break;
      pages.push(page); next = page.nextCursor; bytes += pageBytes; entries += page.items.length;
      if (!next || entries >= maxEntries || bytes >= MAX_BYTES) break;
    }
    const result = mergeLogProjectionPages(pages);
    if (!next) return result;
    return freeze({ ...result, kind: result.kind === 'corrupt' ? 'corrupt' : 'incomplete', issues: [...new Set([...result.issues, 'PROJECTION_LIMIT' as const])] });
  }
  return Object.freeze({ read, rebuild });
}
/** Pure deterministic DATA merge. Replayed pages deduplicate by exact source position, not time. */
export function mergeLogProjectionPages(pages: readonly LogProjectionPage[]): LogProjection {
  const captured: LogProjectionPage[] = []; let bytes = 0;
  for (const input of dataArray(pages, 256)) { const page = captureProjectionPage(input); bytes += Buffer.byteLength(canonical(page)); if (bytes > MAX_BYTES) invalidCapture(); captured.push(page); }
  pages = captured; if (!pages.length) invalidCapture();
  const first = pages[0]!, links = new Map<number, LogProjectionPage['links'][number]>(), items = new Map<number, LogProjectionPage['items'][number]>(), issues = new Set<ProjectionIssue>();
  for (const page of pages) {
    if (page.purpose !== first.purpose || page.identityDigest !== first.identityDigest || !same(page.source, first.source) || !same(page.through, first.through)) invalidCapture();
    for (const issue of page.issues) issues.add(issue);
    for (const link of page.links) { const old = links.get(link.position.sequence); if (old && !same(old, link)) issues.add('LOG_CORRUPT'); else links.set(link.position.sequence, link); }
    for (const item of page.items) { const old = items.get(item.position.sequence); if (old && !same(old, item)) issues.add('LOG_CORRUPT'); else items.set(item.position.sequence, item); for (const issue of item.issues) issues.add(issue); }
    if (links.size > MAX_LINKS || items.size > 10000) invalidCapture();
  }
  let coveredThrough: LogPosition = { sourceId: first.source.sourceId, sequence: 0, digest: genesis(first.source) };
  for (const link of [...links.values()].sort((a, b) => a.position.sequence - b.position.sequence)) {
    if (link.position.sequence !== coveredThrough.sequence + 1 || link.previousDigest !== coveredThrough.digest) { issues.add('HISTORY_GAP'); break; } coveredThrough = link.position;
  }
  if (!same(coveredThrough, first.through)) issues.add('HISTORY_GAP');
  const sorted = [...items.values()].sort((a, b) => a.position.sequence - b.position.sequence);
  if (!sorted.length) issues.add('RUN_NOT_FOUND');
  const invocation = new Map<string, { stage: string; actual: unknown }>(), decisions = new Map<string, string>(), workflows = new Map<string, string>();
  let runStart: ProjectionItem | undefined, runStage: string | undefined;
  for (const item of sorted) {
    if (item.category === 'reconciliation' && !coherentReconciliation(item, items, first.source.sourceId)) issues.add('INCOMPLETE_ORIGIN');
    for (const causal of item.causal) if (causal.sourceIdDigest !== digest(first.source.sourceId) || links.get(causal.sequence)?.position.digest !== causal.digest) issues.add('UNRESOLVED_CAUSAL_REFERENCE');
    const m = item.metadata as Record<string, unknown> | undefined; if (!m) continue;
    if (item.category === 'run') {
      if (m.stage === 'started') {
        if (runStart || item.causal.length) issues.add('INCOMPLETE_ORIGIN'); runStart = item; runStage = 'started';
      } else {
        if (!runStart || runStage !== 'started' || (runStart.metadata as Record<string, unknown>).inputDigest !== m.inputDigest
          || item.causal.length !== 1 || item.causal[0]!.sequence !== runStart.position.sequence || item.causal[0]!.digest !== runStart.position.digest) issues.add('INCOMPLETE_ORIGIN');
        runStage = m.stage as string;
      }
    }
    if (item.category === 'capture-operation' || item.category === 'agent-event') {
      const known = invocation.get(m.invocationDigest as string);
      if (item.category === 'capture-operation' && m.stage === 'started') {
        if (known) issues.add('INCOMPLETE_ORIGIN'); invocation.set(m.invocationDigest as string, { stage: 'started', actual: m.actual });
      } else if (!known || known.stage !== 'started' || !same(known.actual, m.actual)) issues.add('INCOMPLETE_ORIGIN');
      else if (item.category === 'capture-operation') invocation.set(m.invocationDigest as string, { ...known, stage: m.stage as string });
    }
    if (item.category === 'decision') decisions.set(m.decisionIdDigest as string, m.status as string);
    if (item.category === 'workflow') workflows.set(m.workflowIdDigest as string, m.status as string);
  }
  if ([...invocation.values()].some(value => value.stage !== 'settled')) issues.add('INVOCATION_UNSETTLED');
  if (runStage && runStage !== 'completed') issues.add('INVOCATION_UNSETTLED');
  const awaiting = [...decisions.values()].some(status => ['intent', 'dispatched', 'needs-owner', 'waiting'].includes(status)) || [...workflows.values()].some(status => status === 'halted');
  return freeze({ format: 1, purpose: first.purpose, identityDigest: first.identityDigest, scope: 'captured-metadata', textReconstruction: 'unavailable', qualityAssessment: 'not-derived', source: first.source, through: first.through, coveredThrough,
    kind: issues.has('LOG_CORRUPT') ? 'corrupt' : issues.size ? 'incomplete' : awaiting ? 'awaiting-owner' : 'observed', items: sorted, issues: [...issues].sort() });
}
