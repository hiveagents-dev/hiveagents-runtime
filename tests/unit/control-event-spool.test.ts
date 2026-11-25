import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlBuffer, createEventSpool, type EventSpool } from '../../src/control/event-spool.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('private bounded control event spool', () => {
  let directory: string;
  const spools: EventSpool<unknown>[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'oar-control-spool-test-'));
    vi.mocked(open).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open);
  });
  afterEach(async () => { for (const spool of spools.splice(0)) await spool.dispose(); await rm(directory, { recursive: true, force: true }); });
  async function spool<T>(options: Partial<Parameters<typeof createEventSpool<T>>[0]> = {}) {
    const value = await createEventSpool<T>({ directory, ...options }); spools.push(value as EventSpool<unknown>); return value;
  }
  it('retains more than 1024 ordered JSON events across private bounded segments', async () => {
    const events = await spool<{ index: number; text: string }>({ segmentBytes: 1024 });
    for (let index = 0; index < 3000; index++) events.append({ index, text: `ñ-${index}` });
    expect(events.stats.unreadItems).toBe(3000);
    expect(events.stats.pendingWrites).toBeLessThanOrEqual(1);
    events.close();
    const collected = [];
    for await (const event of events) collected.push(event);
    expect(collected).toEqual(Array.from({ length: 3000 }, (_, index) => ({ index, text: `ñ-${index}` })));
    await expect(stat(events.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('writes segments 0600 under an owned 0700 directory and deletes consumed segments', async () => {
    const events = await spool<string>({ segmentBytes: 256 });
    for (let index = 0; index < 30; index++) events.append('x'.repeat(100));
    await vi.waitFor(async () => expect((await readdir(events.directory)).length).toBeGreaterThan(2));
    expect((await stat(events.directory)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(events.directory)) expect((await stat(join(events.directory, file))).mode & 0o777).toBe(0o600);
    const iterator = events[Symbol.asyncIterator]();
    for (let index = 0; index < 20; index++) expect((await iterator.next()).value).toBe('x'.repeat(100));
    expect(events.stats.unreadItems).toBe(10);
    expect((await readdir(events.directory)).length).toBeLessThan(8);
    await iterator.return?.();
    await expect(stat(events.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('splits a legal record across segments without losing UTF8 bytes or framing', async () => {
    const events = await spool<string>({ segmentBytes: 16, maxUnreadBytes: 4096 });
    const value = '🌱\r\nñ'.repeat(200); events.append(value); events.close();
    expect(await events.next()).toEqual({ done: false, value });
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });
  it('bounds staged items/bytes and has only one pending writer even if the disk stalls', async () => {
    const gate = deferred<void>(), opened = deferred<void>();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let opens = 0;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('.segment') && flags === 'wx') { opens++; opened.resolve(); await gate.promise; }
      return original.open(path, flags, mode);
    });
    const events = await spool<{ index: number }>({ maxUnreadItems: 4, maxUnreadBytes: 1024 });
    try {
      for (let index = 0; index < 4; index++) events.append({ index });
      await opened.promise;
      expect(events.stats).toMatchObject({ unreadItems: 4, pendingWrites: 1 });
      expect(events.stats.unreadBytes).toBeLessThanOrEqual(1024);
      expect(opens).toBe(1);
      expect(() => events.append({ index: 5 })).toThrowError(expect.objectContaining({ code: 'OUTPUT_LIMIT' }));
      await expect(events.next()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    } finally { gate.resolve(); }
  });
  it('fails typed on a byte cap without accepting a partial record', async () => {
    const events = await spool<string>({ maxUnreadBytes: 32 });
    expect(() => events.append('x'.repeat(33))).toThrowError(expect.objectContaining({ code: 'OUTPUT_LIMIT' }));
    await expect(events.next()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });
  it('bounds live segment files independently of bytes when configured segments are tiny', async () => {
    let failure: unknown;
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let created = 0;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('.segment') && flags === 'wx') created++;
      return original.open(path, flags, mode);
    });
    const events = await spool<string>({ segmentBytes: 16, maxUnreadBytes: 65_536, onFailure: error => { failure = error; } });
    events.append('x'.repeat(5000)); events.close();
    // Observe the writer outcome without consuming/deleting any segments.
    await vi.waitFor(() => expect(events.stats.pendingWrites).toBe(0), { timeout: 5000 });
    expect(failure).toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(created).toBe(256);
    await events.dispose(); expect(await readdir(directory)).toEqual([]);
  });
  it('observes a disk failure without a consumer and preserves its original cause', async () => {
    const cause = Object.assign(new Error('fixture disk error'), { code: 'EIO' }), failure = deferred<unknown>();
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('.segment') && flags === 'wx') throw cause;
      return original.open(path, flags, mode);
    });
    const events = await spool<string>({ onFailure: error => failure.resolve(error) });
    events.append('pending');
    expect(await failure.promise).toMatchObject({ code: 'PROTOCOL_ERROR', cause });
    await expect(events.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', cause });
    await events.dispose();
    await expect(stat(events.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects accessors and shared graphs before serialization can execute or expand them', async () => {
    const getter = vi.fn(() => 'secret'), events = await spool<unknown>();
    expect(() => events.append(Object.defineProperty({}, 'value', { get: getter, enumerable: true }))).toThrowError(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
    expect(getter).not.toHaveBeenCalled();
    let graph: unknown = { leaf: true }; for (let depth = 0; depth < 12; depth++) graph = { a: graph, b: graph };
    const second = await spool<unknown>();
    expect(() => second.append(graph)).toThrowError(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
  });
  it('binds cleanup to its owned directory even if a caller tries to replace the visible path', async () => {
    const events = await spool<string>(), neighbor = await mkdtemp(join(directory, 'unowned-'));
    try { Object.assign(events, { directory: neighbor }); } catch { /* A getter-only view may reject mutation. */ }
    try { Object.defineProperty(events, 'directory', { value: neighbor }); } catch { /* Frozen diagnostics cannot redirect cleanup. */ }
    await events.dispose();
    expect((await stat(neighbor)).isDirectory()).toBe(true);
    expect(events.directory).not.toBe(neighbor);
  });
  it('rejects proxied options before invoking their reflection traps', async () => {
    let traps = 0;
    const options = new Proxy({ directory }, { ownKeys: () => { traps++; throw new Error('untrusted trap'); } });
    await expect(createEventSpool(options)).rejects.toThrow('data properties');
    expect(traps).toBe(0);
  });
  it('never reopens a disposed buffer or leaks old records into a fresh instance', async () => {
    const first = await spool<string>(); first.append('old epoch'); await first.dispose();
    expect(() => first.append('late old event')).toThrowError(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
    const second = await spool<string>(); expect(second.directory).not.toBe(first.directory);
    second.append('new epoch'); second.close();
    expect(await second.next()).toEqual({ done: false, value: 'new epoch' });
    expect(await second.next()).toEqual({ done: true, value: undefined });
  });
  it('preserves bounded live critical references in publication order without serializing their signal', async () => {
    type Item = { kind: 'progress'; index: number } | { kind: 'critical'; signal: AbortSignal };
    const buffer = await createControlBuffer<Item>({ directory, epoch: 'first', isCritical: item => item.kind === 'critical' });
    const controller = new AbortController(), request: Item = { kind: 'critical', signal: controller.signal };
    try {
      for (let index = 0; index < 1500; index++) buffer.push({ kind: 'progress', index });
      buffer.push(request); buffer.close(); controller.abort();
      for (let index = 0; index < 1500; index++) expect(await buffer.next()).toEqual({ done: false, value: { kind: 'progress', index } });
      expect((await buffer.next()).value).toBe(request);
      expect(request.signal.aborted).toBe(true);
      expect(await buffer.next()).toEqual({ done: true, value: undefined });
    } finally { await buffer.dispose(); }
  });
  it('bounds critical references independently and never reuses a failed turn buffer', async () => {
    const first = await createControlBuffer<AbortSignal>({ directory, epoch: 'old', isCritical: () => true, maxCriticalItems: 1 });
    try {
      expect(first.push(new AbortController().signal)).toBe(true);
      expect(first.push(new AbortController().signal)).toBe(false);
      await expect(first.next()).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
      expect(first.push(new AbortController().signal)).toBe(false);
    } finally { await first.dispose(); }
  });
});
