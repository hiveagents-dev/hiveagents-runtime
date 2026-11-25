import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileCuratorJournal } from '../../src/orchestration/memory/curator.js';
import type { CuratorJournalEntry } from '../../src/orchestration/memory/curator.js';
import { candidateJournalKey } from '../../src/orchestration/memory/curator-journal.js';

/**
 * Regression tests for the reviewer probes rv2-v1-curator (two journals on one file drop each
 * other's entries) and rv2-v2-journal-ceiling (a journal within its maxEntries ceiling wrote a
 * file its own reader refuses).
 */

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'oar-curator-journal-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const AT = '2026-11-15T00:00:00.000Z';
const refused: CuratorJournalEntry = { outcome: 'refused', at: AT, reason: 'BELOW_MARGIN' };
const MAX_FILE_BYTES = 64 * 1024 * 1024;

describe('fileCuratorJournal on one path', () => {
  it('two journals on one file in one process keep both refusals (rv2-v1)', async () => {
    const path = join(directory, 'journal.json');
    const forScopeA = fileCuratorJournal(path);
    const forScopeB = fileCuratorJournal(join(directory, '.', 'journal.json'));
    // Both read the (empty) file before either writes, as two passes started together do.
    expect(await forScopeA.get(candidateJournalKey('curator-a'))).toBeUndefined();
    expect(await forScopeB.get(candidateJournalKey('curator-b'))).toBeUndefined();
    await forScopeA.set(candidateJournalKey('curator-a'), refused);
    await forScopeB.set(candidateJournalKey('curator-b'), refused);
    // Each sees the other's entry at once: one state per resolved path.
    expect(await forScopeB.get(candidateJournalKey('curator-a'))).toEqual(refused);

    const reread = fileCuratorJournal(path);
    expect(await reread.get(candidateJournalKey('curator-a'))).toEqual(refused);
    expect(await reread.get(candidateJournalKey('curator-b'))).toEqual(refused);
    expect(readdirSync(directory)).toEqual(['journal.json']);
  });

  it('merges concurrent writers that do not share a state, as separate processes do', async () => {
    const path = join(directory, 'journal.json');
    const here = fileCuratorJournal(path);
    // A fresh module instance has its own registry, queue and cache: another process, as far as the file goes.
    vi.resetModules();
    const elsewhere = await import('../../src/orchestration/memory/curator-journal.js');
    const there = elsewhere.fileCuratorJournal(path);
    expect(await here.get('warm')).toBeUndefined();
    expect(await there.get('warm')).toBeUndefined();

    await Promise.all(Array.from({ length: 40 }, (_, n) => (n % 2 ? here : there).set(`key-${n}`, refused)));

    const reread = fileCuratorJournal(path);
    for (let n = 0; n < 40; n += 1) expect(await reread.get(`key-${n}`)).toEqual(refused);
    // A writer that cached the file before the other wrote reads it again.
    expect(await here.get('key-0')).toEqual(refused);
    expect(await there.get('key-1')).toEqual(refused);
    expect(readdirSync(directory)).toEqual(['journal.json']);
  });

  it('applies update() under the lock: reservations from separate processes are all kept (review)', async () => {
    const path = join(directory, 'journal.json');
    const here = fileCuratorJournal(path);
    vi.resetModules();
    const elsewhere = await import('../../src/orchestration/memory/curator-journal.js');
    const there = elsewhere.fileCuratorJournal(path);
    expect(await here.get('warm')).toBeUndefined();
    expect(await there.get('warm')).toBeUndefined();
    const times = Array.from({ length: 30 }, (_, n) => new Date(Date.parse(AT) + n * 1000).toISOString());
    // A read-then-set from both sides would lose reservations; update re-reads the file under the lock.
    await Promise.all(times.map((at, n) => (n % 2 ? here : there).update!('measurements:x', entry => ({
      outcome: 'promoted', at, measuredAt: [...(entry?.measuredAt ?? []), at],
    }))));
    expect((await fileCuratorJournal(path).get('measurements:x'))?.measuredAt?.sort()).toEqual(times);
    // A change that returns an invalid entry writes nothing.
    await expect(here.update!('measurements:x', () => ({ outcome: 'nope' }) as never)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' });
    expect((await here.get('measurements:x'))?.measuredAt).toHaveLength(30);
  });

  it('breaks an abandoned lock, and fails JOURNAL_LOCKED on a live one without writing', async () => {
    const path = join(directory, 'journal.json');
    const lock = `${path}.lock`;
    writeFileSync(lock, 'crashed writer');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const journal = fileCuratorJournal(path);
    await journal.set('a', refused);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, 'live writer');
    const started = Date.now();
    await expect(journal.set('b', refused)).rejects.toMatchObject({ code: 'JOURNAL_LOCKED' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await journal.get('b')).toBeUndefined();
    // The live lock is someone else's: it is left in place, and the queue still works after it goes.
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    await journal.set('c', refused);
    expect(await fileCuratorJournal(path).get('c')).toEqual(refused);
  }, 20_000);

  it('refuses a symlink lock at once, dangling or not, and never breaks or follows it (rv3-journal-lock)', async () => {
    const path = join(directory, 'journal.json');
    const lock = `${path}.lock`;
    // open(lock, 'wx') fails EEXIST on a dangling symlink; following it with stat() found nothing,
    // which read as "the lock is gone": the wait spun without a deadline.
    symlinkSync(join(directory, 'nowhere'), lock);
    const journal = fileCuratorJournal(path);
    let started = Date.now();
    await expect(journal.set('a', refused)).rejects.toMatchObject({ code: 'JOURNAL_LOCKED' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(existsSync(join(directory, 'nowhere'))).toBe(false);

    // A symlink to an old file is not taken for an abandoned lock either.
    rmSync(lock);
    const target = join(directory, 'target');
    writeFileSync(target, 'not a lock');
    const old = new Date(Date.now() - 60_000);
    utimesSync(target, old, old);
    symlinkSync(target, lock);
    started = Date.now();
    await expect(journal.set('b', refused)).rejects.toMatchObject({ code: 'JOURNAL_LOCKED' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not a lock');
    expect(existsSync(path)).toBe(false);

    rmSync(lock);
    await journal.set('c', refused);
    expect(await fileCuratorJournal(path).get('c')).toEqual(refused);
  }, 20_000);
});

describe('fileCuratorJournal size (rv2-v2)', () => {
  it('refuses a maxEntries its file could not hold', () => {
    expect(() => fileCuratorJournal(join(directory, 'j.json'), { maxEntries: 1_000_000 })).toThrow(RangeError);
    expect(() => fileCuratorJournal(join(directory, 'j.json'), { maxEntries: 200_000 })).not.toThrow();
  });

  it('evicts the oldest entries so the file stays readable by the next process', async () => {
    const path = join(directory, 'curator.json');
    // Large episode entries (16 promoted ids each), just under the 64 MiB read limit.
    const promoted = Array.from({ length: 16 }, (_, k) => `curator-${k.toString(16).padStart(64, '0')}`);
    const entry = { outcome: 'promoted', at: AT, promoted };
    const entries: [string, unknown][] = [];
    let bytes = 25;
    for (let i = 0; bytes < MAX_FILE_BYTES - 2000; i += 1) {
      const pair: [string, unknown] = [`episode:${i.toString(16).padStart(64, '0')}`, entry];
      bytes += JSON.stringify(pair).length + 1;
      entries.push(pair);
    }
    writeFileSync(path, JSON.stringify({ format: 1, entries }));
    expect(entries.length).toBeLessThan(200_000);

    const first = fileCuratorJournal(path, { maxEntries: 200_000 });
    expect(await first.get(entries[0]![0])).toBeDefined();
    for (let i = 0; i < 4; i += 1) await first.set(`episode:new-${i}`, { outcome: 'promoted', at: AT, promoted });
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_FILE_BYTES);

    // The next process: a fresh module, the same path, the same options.
    vi.resetModules();
    const { fileCuratorJournal: reopen } = await import('../../src/orchestration/memory/curator-journal.js');
    const next = reopen(path, { maxEntries: 200_000 });
    await expect(next.get('episode:new-3')).resolves.toMatchObject({ outcome: 'promoted' });
    // The least recently written made room; the rest are intact.
    expect(await next.get(entries[0]![0])).toBeUndefined();
    expect(await next.get(entries.at(-1)![0])).toEqual(entry);
  }, 60_000);
});
