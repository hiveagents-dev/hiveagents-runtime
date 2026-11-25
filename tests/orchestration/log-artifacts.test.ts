import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogArtifactStore } from '../../src/orchestration/log/artifacts.js';

const binding = { sourceId: 'source-1', systemId: 'system-1', generation: 1 };
const binary = { mediaType: 'application/octet-stream' as const }, json = { mediaType: 'application/json' as const };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
let directory: string;
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-log-artifacts-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const open = (options = {}) => createLogArtifactStore({ directory: join(directory, 'artifacts'), binding, ...options });
const fileFor = (digest: string) => { const root = join(directory, 'artifacts'), scopes = fs.readdirSync(root); expect(scopes).toHaveLength(1); return join(root, scopes[0]!, `${digest}.blob`); };

describe('private source/system-scoped neutral log artifacts are data only', () => {
  it('syncs the root parent even when a concurrent creator already installed the root name', async () => {
    const root = join(directory, 'artifacts'); fs.mkdirSync(root, { mode: 0o700 }); const originalOpen = fs.openSync, originalSync = fs.fsync; let parent: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = originalOpen(path, flags, mode); if (String(path) === directory) parent = fd; return fd; });
    vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => { if (fd === parent) callback(Object.assign(Error('owned parent durability fault'), { code: 'EIO' })); else originalSync(fd, callback); });
    await expect(open()).rejects.toMatchObject({ code: 'IO' });
  });
  it('writes durable immutable digest+length references and reads verified original bytes', async () => {
    const store = await open(), body = 'owned\r\n😀', ref = await store.write(body, json);
    expect(ref).toEqual({ ...binding, digest: hash(body), bytes: Buffer.byteLength(body), mediaType: 'application/json' }); expect(Object.isFrozen(ref)).toBe(true);
    expect(await store.verify(ref)).toEqual({ kind: 'verified', reference: ref }); expect(Buffer.from(await store.read(ref)).toString()).toBe(body);
    const inode = fs.statSync(fileFor(ref.digest)).ino; expect((await store.write(body, json)).digest).toBe(ref.digest); expect(fs.statSync(fileFor(ref.digest)).ino).toBe(inode);
    expect(fs.statSync(fileFor(ref.digest)).mode & 0o777).toBe(0o600);
  });
  it('preserves20MiB nested Unicode/CRLF JSON through chunked UTF8 encoding without astral replacement', async () => {
    const store = await open(), body = JSON.stringify({ result: { text: '😀\r\n'.repeat(Math.ceil(20 * 1024 * 1024 / 6)) } }), ref = await store.write(body, json);
    expect(ref.bytes).toBe(Buffer.byteLength(body)); expect(ref.bytes).toBeGreaterThanOrEqual(20 * 1024 * 1024); expect(ref.digest).toBe(hash(body));
    expect(Buffer.from(await store.read(ref)).toString('utf8')).toBe(body);
  }, 20000);
  it('captures a32MiB checkpoint before awaits and never exposes mutable file backing', async () => {
    const store = await open(), input = Buffer.alloc(32 * 1024 * 1024, 65), digest = hash(input), pending = store.write(input, binary); input.fill(66);
    const ref = await pending; expect(ref).toMatchObject({ digest, bytes: 32 * 1024 * 1024 }); const read = await store.read(ref); expect(hash(read)).toBe(digest); read.fill(0);
    expect((await store.verify(ref)).kind).toBe('verified');
  }, 20000);
  it('supports empty payloads and explicit caps without truncation or oversized snapshots', async () => {
    const store = await open({ maxBytes: 1024 }), empty = await store.write(new Uint8Array(), binary); expect(empty.bytes).toBe(0); expect(await store.read(empty)).toHaveLength(0);
    await expect(store.write(new Uint8Array(1025), binary)).rejects.toMatchObject({ code: 'LIMIT' }); expect(store.snapshot().pending).toBe(0);
    await expect(createLogArtifactStore({ directory: join(directory, 'oversized'), binding, maxBytes: 128 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: 'INVALID' });
  });
  it('binds refs to source/system/generation and performs no lookup for a foreign scope or caller path', async () => {
    const store = await open(), ref = await store.write('owned', binary), opens = vi.spyOn(fs, 'openSync');
    for (const changed of [{ sourceId: 'foreign' }, { systemId: 'foreign' }, { generation: 2 }, { path: '/private/foreign' }]) {
      await expect(store.verify({ ...ref, ...changed })).rejects.toMatchObject({ code: 'INVALID' });
    }
    expect(opens).not.toHaveBeenCalled();
  });
  it('uses scope identifiers as hashed data, never directory components', async () => {
    const store = await open({ binding: { sourceId: '../source', systemId: '../../system', generation: 1 } }), ref = await store.write('owned', binary);
    expect(ref.sourceId).toBe('../source'); expect(fs.readdirSync(join(directory, 'artifacts'))).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect((await store.verify(ref)).kind).toBe('verified');
  });
  it('reports missing/corrupt data and never repairs or replaces a conflicting final artifact', async () => {
    const store = await open(), ref = await store.write('owned', binary), path = fileFor(ref.digest); fs.writeFileSync(path, 'other');
    expect((await store.verify(ref)).kind).toBe('corrupt'); await expect(store.read(ref)).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(store.write('owned', binary)).rejects.toMatchObject({ code: 'CORRUPT' }); expect(fs.readFileSync(path, 'utf8')).toBe('other');
    fs.unlinkSync(path); expect((await store.verify(ref)).kind).toBe('missing'); await expect(store.read(ref)).rejects.toMatchObject({ code: 'MISSING' });
  });
  it.each(['symlink', 'hardlink', 'mode'] as const)('denies %s metadata before opening artifact bytes', async mode => {
    const store = await open(), ref = await store.write('owned', binary), path = fileFor(ref.digest), saved = join(directory, 'saved');
    if (mode === 'symlink') { fs.renameSync(path, saved); fs.symlinkSync(saved, path); }
    if (mode === 'hardlink') fs.linkSync(path, saved); if (mode === 'mode') fs.chmodSync(path, 0o644);
    const opens = vi.spyOn(fs, 'openSync'); expect((await store.verify(ref)).kind).toBe('corrupt'); expect(opens).not.toHaveBeenCalled();
  });
  it('refuses symlinked/replaced scope directories and keeps static errors free of input prose', async () => {
    const store = await open(), ref = await store.write('owned', binary), root = join(directory, 'artifacts'), scope = fs.readdirSync(root)[0]!, saved = join(directory, 'saved');
    fs.renameSync(join(root, scope), saved); fs.symlinkSync(saved, join(root, scope)); const result = await store.verify(ref); expect(result.kind).toBe('corrupt');
    await expect(store.write('PRIVATE_SECRET', binary)).rejects.toMatchObject({ code: 'CORRUPT' });
  });
  it('retains exactly one unexpected opened inode and faults intake without closing a raced SQLite alias', async () => {
    const store = await open(), ref = await store.write('owned', binary), path = fileFor(ref.digest), saved = join(directory, 'before-race'), realOpen = fs.openSync; let raced = false; let unexpected: number | undefined;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
      if (String(candidate) === path && !raced) { raced = true; fs.renameSync(path, saved); fs.writeFileSync(path, 'owned', { mode: 0o600 }); unexpected = realOpen(candidate, flags, mode); return unexpected; }
      return realOpen(candidate, flags, mode);
    });
    try { expect((await store.verify(ref)).kind).toBe('corrupt'); expect(unexpected).toBeDefined(); expect(fs.fstatSync(unexpected!).isFile()).toBe(true); expect(store.snapshot()).toMatchObject({ faulted: true, quarantined: 1 });
      spy.mockClear(); await expect(store.read(ref)).rejects.toMatchObject({ code: 'CORRUPT' }); await expect(store.write('later', binary)).rejects.toMatchObject({ code: 'CORRUPT' }); expect(spy).not.toHaveBeenCalled();
    } finally { if (unexpected !== undefined) fs.closeSync(unexpected); }
  });
  it('does not publish a digest reference when bytes change on the pinned file before publication ACK', async () => {
    const store = await open(), original = fs.link;
    vi.spyOn(fs, 'link').mockImplementation((from, to, callback) => original(from, to, error => { if (!error) fs.writeFileSync(to, 'other'); callback(error); }));
    await expect(store.write('owned', binary)).rejects.toMatchObject({ code: 'CORRUPT' });
  });
  it('denies a ready-name inode replacement before exclusive final link publication', async () => {
    const store = await open(), original = fs.link;
    vi.spyOn(fs, 'link').mockImplementation((from, to, callback) => { fs.unlinkSync(from); fs.writeFileSync(from, 'other', { mode: 0o600 }); original(from, to, callback); });
    await expect(store.write('owned', binary)).rejects.toMatchObject({ code: 'CORRUPT' });
  });
  it('quarantines an opened file whose inode observation fails and refuses further opens', async () => {
    const store = await open(), ref = await store.write('owned', binary), path = fileFor(ref.digest), originalOpen = fs.openSync, originalStat = fs.fstatSync; let fd: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => { const value = originalOpen(name, flags, mode); if (String(name) === path) fd = value; return value; });
    vi.spyOn(fs, 'fstatSync').mockImplementation(((value: number, options: unknown) => { if (value === fd) throw Object.assign(Error('owned observation failure'), { code: 'EIO' }); return originalStat(value, options as never); }) as typeof fs.fstatSync);
    try { expect((await store.verify(ref)).kind).toBe('corrupt'); vi.restoreAllMocks(); expect(originalStat(fd!).isFile()).toBe(true); expect(store.snapshot()).toMatchObject({ faulted: true, quarantined: 1 }); }
    finally { vi.restoreAllMocks(); if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  });
  it('closes a newly exclusive staging descriptor even if its first fstat fails', async () => {
    const store = await open(), originalOpen = fs.openSync, originalStat = fs.fstatSync; let opened: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = originalOpen(path, flags, mode); if (String(path).endsWith('.tmp')) opened = fd; return fd; });
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options: unknown) => { if (fd === opened) throw Object.assign(Error('owned staging fstat failure'), { code: 'EIO' }); return originalStat(fd, options as never); }) as typeof fs.fstatSync);
    try { await expect(store.write('owned', binary)).rejects.toMatchObject({ code: 'IO' }); vi.restoreAllMocks(); expect(() => originalStat(opened!)).toThrow(); expect(store.snapshot().pending).toBe(0); }
    finally { vi.restoreAllMocks(); if (opened !== undefined) try { fs.closeSync(opened); } catch {} }
  });
  it('validates descriptor inputs without invoking proxy/getter/shadowed typed-array properties', async () => {
    let reads = 0; const bad = Object.defineProperty({}, 'directory', { enumerable: true, get() { reads++; throw Error('PRIVATE_SECRET'); } });
    await expect(createLogArtifactStore(bad as never)).rejects.toMatchObject({ code: 'INVALID' }); const store = await open();
    await expect(store.write(new Proxy(new Uint8Array(), { get() { reads++; throw Error(); } }), binary)).rejects.toMatchObject({ code: 'INVALID' });
    const bytes = Buffer.from('owned'); Object.defineProperty(bytes, 'byteLength', { get() { reads++; throw Error(); } }); const ref = await store.write(bytes, binary);
    expect(ref.bytes).toBe(5); expect(reads).toBe(0); await expect(store.write('\ud800', json)).rejects.toMatchObject({ code: 'INVALID' });
  });
  it('keeps IO chunks at64KiB, yields while encoding, and reads one pinned payload descriptor', async () => {
    const store = await open(), writes: number[] = [], reads: number[] = [], originalWrite = fs.write, originalRead = fs.read;
    vi.spyOn(fs, 'write').mockImplementation(((fd: number, bytes: Buffer, offset: number, count: number, position: number | null, callback: unknown) => { writes.push(count); return originalWrite(fd, bytes, offset, count, position, callback as never); }) as typeof fs.write);
    vi.spyOn(fs, 'read').mockImplementation(((fd: number, bytes: Buffer, offset: number, count: number, position: number | null, callback: unknown) => { reads.push(count); return originalRead(fd, bytes, offset, count, position, callback as never); }) as typeof fs.read);
    let yielded = false; setImmediate(() => { yielded = true; }); const body = '😀'.repeat(200000), ref = await store.write(body, json); expect(yielded).toBe(true);
    let payloadOpens = 0; const originalOpen = fs.openSync; vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { if (String(path).endsWith('.blob')) payloadOpens++; return originalOpen(path, flags, mode); });
    expect(Buffer.from(await store.read(ref)).toString()).toBe(body); expect(payloadOpens).toBe(1); expect(Math.max(...writes, ...reads)).toBeLessThanOrEqual(65536);
  });
  it('holds bounded pending write resources under a slow disk without taking another input snapshot', async () => {
    const store = await open({ maxPending: 1 }), original = fs.write; let release: (() => void) | undefined;
    vi.spyOn(fs, 'write').mockImplementation(((...args: Parameters<typeof fs.write>) => { release = () => { original(...args); }; }) as typeof fs.write);
    const pending = store.write('owned', binary); await vi.waitFor(() => expect(release).toBeDefined()); expect(store.snapshot().pending).toBe(1);
    await expect(store.write('queued', binary)).rejects.toMatchObject({ code: 'BUSY' }); expect(store.snapshot().pending).toBe(1);
    vi.restoreAllMocks(); release!(); const ref = await pending; expect((await store.verify(ref)).kind).toBe('verified'); expect(store.snapshot().pending).toBe(0);
  });
  it('retains a slow read resource, observes abort, and never returns partial bytes', async () => {
    const store = await open({ maxPending: 1 }), ref = await store.write('owned', binary), original = fs.read, abort = new AbortController(); let release: (() => void) | undefined;
    vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => { release = () => { original(...args); }; }) as typeof fs.read);
    const pending = store.read(ref, { signal: abort.signal }); await vi.waitFor(() => expect(release).toBeDefined()); abort.abort(Error('PRIVATE abort'));
    expect(store.snapshot().pending).toBe(1); await expect(store.verify(ref)).rejects.toMatchObject({ code: 'BUSY' }); vi.restoreAllMocks(); release!();
    const error = await pending.catch(error => error); expect(error).toMatchObject({ code: 'ABORTED' }); expect(JSON.stringify(error)).not.toContain('PRIVATE'); expect(store.snapshot().pending).toBe(0);
  });
  it('rejects mutable shared backing and preserves its original abort signal through caller mutation', async () => {
    const store = await open(); await expect(store.write(new Uint8Array(new SharedArrayBuffer(1)), binary)).rejects.toMatchObject({ code: 'INVALID' });
    const abort = new AbortController(), replacement = new AbortController(), options = { ...binary, signal: abort.signal }, pending = store.write(Buffer.alloc(1000000), options); options.signal = replacement.signal; abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); expect(store.snapshot().pending).toBe(0);
  });
  it('detects same-inode growth during a read without truncation or unbounded allocation', async () => {
    const store = await open(), ref = await store.write('owned', binary), original = fs.read; let once = false;
    vi.spyOn(fs, 'read').mockImplementation(((...args: Parameters<typeof fs.read>) => { if (!once) { once = true; fs.appendFileSync(fileFor(ref.digest), 'grown'); } return original(...args); }) as typeof fs.read);
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'CORRUPT' }); expect(store.snapshot().pending).toBe(0);
  });
  it.each(['file-sync', 'rename', 'link', 'directory-sync'] as const)('does not return a reference before %s durability succeeds', async fault => {
    const store = await open(); let calls = 0;
    if (fault === 'rename') vi.spyOn(fs, 'rename').mockImplementation((_a, _b, callback) => callback(Object.assign(Error('PRIVATE disk detail'), { code: 'EIO' })));
    if (fault === 'link') vi.spyOn(fs, 'link').mockImplementation((_a, _b, callback) => callback(Object.assign(Error('PRIVATE disk detail'), { code: 'EIO' })));
    if (fault === 'file-sync' || fault === 'directory-sync') { const sync = fs.fsync; vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) => { if (++calls === (fault === 'file-sync' ? 1 : 2)) callback(Object.assign(Error('PRIVATE disk detail'), { code: 'EIO' })); else sync(fd, callback); }); }
    const error = await store.write('owned', binary).catch(error => error); expect(error).toMatchObject({ code: 'IO' }); expect(JSON.stringify(error)).not.toContain('PRIVATE');
    vi.restoreAllMocks(); const ref = await store.write('owned', binary); expect((await store.verify(ref)).kind).toBe('verified');
  });
});
