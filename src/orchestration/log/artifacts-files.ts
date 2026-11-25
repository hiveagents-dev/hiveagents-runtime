import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonical } from '../../shared/json.js';
import type { PayloadReference } from './types.js';
import { LOG_ARTIFACT_LIMITS, LogArtifactError, type LogArtifactBinding } from './artifacts-types.js';
import { artifactChunks, artifactYield, checkArtifactAbort } from './artifacts-validation.js';
interface Identity { dev: bigint; ino: bigint }
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const uid = () => { if (!process.getuid) throw new LogArtifactError('IO'); return BigInt(process.getuid()); };
const directory = (path: string, expected?: Identity) => {
  const s = fs.lstatSync(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid() || (s.mode & 0o777n) !== 0o700n || fs.realpathSync(path) !== path || expected && !same(s, expected)) throw new LogArtifactError('CORRUPT'); return s;
};
const file = (path: string, length: number) => {
  const s = fs.lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid() || (s.mode & 0o777n) !== 0o600n || s.nlink !== 1n || s.size !== BigInt(length) || fs.realpathSync(path) !== path) throw new LogArtifactError('CORRUPT'); return s;
};
const fsync = (fd: number) => new Promise<void>((resolve, reject) => fs.fsync(fd, error => error ? reject(error) : resolve()));
const rename = (from: string, to: string) => new Promise<void>((resolve, reject) => fs.rename(from, to, error => error ? reject(error) : resolve()));
const link = (from: string, to: string) => new Promise<void>((resolve, reject) => fs.link(from, to, error => error ? reject(error) : resolve()));
const unlink = (path: string) => new Promise<void>((resolve, reject) => fs.unlink(path, error => error ? reject(error) : resolve()));
const write = (fd: number, bytes: Buffer, offset: number) => new Promise<number>((resolve, reject) => fs.write(fd, bytes, offset, bytes.length - offset, null, (error, count) => error ? reject(error) : resolve(count)));
const read = (fd: number, bytes: Buffer, count: number, position: number) => new Promise<number>((resolve, reject) => fs.read(fd, bytes, 0, count, position, (error, used) => error ? reject(error) : resolve(used)));
export interface ArtifactFiles {
  readonly scope: string;
  check(): void; quarantine(fd: number): void;
  snapshot(): { faulted: boolean; quarantined: number };
}
async function syncDirectory(context: ArtifactFiles | undefined, path: string, expected?: Identity) {
  context?.check(); const before = directory(path, expected), fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); let owned = true;
  try { if (!same(before, fs.fstatSync(fd, { bigint: true }))) { if (context) { owned = false; context.quarantine(fd); } throw new LogArtifactError('CORRUPT'); } await fsync(fd); context?.check(); directory(path, before); }
  finally { if (owned) fs.closeSync(fd); }
}
export async function createArtifactFiles(root: string, binding: LogArtifactBinding): Promise<ArtifactFiles> {
  try { fs.lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; directory(dirname(root)); try { fs.mkdirSync(root, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; } }
  await syncDirectory(undefined, dirname(root));
  const rootIdentity = directory(root), scope = join(root, createHash('sha256').update(canonical(binding)).digest('hex'));
  try { fs.mkdirSync(scope, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const scopeIdentity = directory(scope); let faulted = false, quarantined: number | undefined;
  const context: ArtifactFiles = Object.freeze({ scope,
    check() { if (faulted) throw new LogArtifactError('CORRUPT'); directory(root, rootIdentity); directory(scope, scopeIdentity); },
    quarantine(fd: number) { faulted = true; if (quarantined === undefined) quarantined = fd; /* Deliberate bounded retention. No GC/finalizer may close a possible SQLite alias. */ },
    snapshot: () => ({ faulted, quarantined: Number(quarantined !== undefined) }),
  });
  await syncDirectory(context, root, rootIdentity); await syncDirectory(context, scope, scopeIdentity); return context;
}
/** One pinned descriptor, one capped pass; read never verifies then reopens a named file. */
export async function scanArtifact(context: ArtifactFiles, reference: PayloadReference, signal?: AbortSignal, retain = false): Promise<Buffer | undefined> {
  context.check(); checkArtifactAbort(signal); const path = join(context.scope, `${reference.digest}.blob`);
  let before: fs.BigIntStats;
  try { before = file(path, reference.bytes); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LogArtifactError('MISSING'); throw error; }
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); let owned = true;
  const chunks: Buffer[] = [], buffer = Buffer.allocUnsafe(LOG_ARTIFACT_LIMITS.chunkBytes), hash = createHash('sha256'); let used = 0;
  try {
    let pinned: fs.BigIntStats;
    try { pinned = fs.fstatSync(fd, { bigint: true }); } catch (cause) { owned = false; context.quarantine(fd); throw new LogArtifactError('CORRUPT', cause); }
    if (!same(before, pinned) || !pinned.isFile() || pinned.size !== before.size || pinned.nlink !== 1n || pinned.uid !== uid() || (pinned.mode & 0o777n) !== 0o600n) { owned = false; context.quarantine(fd); throw new LogArtifactError('CORRUPT'); }
    while (used < reference.bytes) {
      context.check(); checkArtifactAbort(signal); const count = await read(fd, buffer, Math.min(buffer.length, reference.bytes - used), used);
      if (count < 1) throw new LogArtifactError('CORRUPT'); hash.update(buffer.subarray(0, count)); if (retain) chunks.push(Buffer.from(buffer.subarray(0, count))); used += count;
      await artifactYield();
    }
    checkArtifactAbort(signal); const after = file(path, reference.bytes), current = fs.fstatSync(fd, { bigint: true });
    if (!same(before, after) || !same(before, current) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.size !== before.size || hash.digest('hex') !== reference.digest) throw new LogArtifactError('CORRUPT');
    // Establish durability even for a caller-built data ref to a concurrently completed final file.
    await fsync(fd); await syncDirectory(context, context.scope); checkArtifactAbort(signal); const last = file(path, reference.bytes);
    if (!same(before, last) || before.mtimeNs !== last.mtimeNs || before.ctimeNs !== last.ctimeNs) throw new LogArtifactError('CORRUPT');
    return retain ? Buffer.concat(chunks, used) : undefined;
  } finally { buffer.fill(0); for (const chunk of chunks) chunk.fill(0); if (owned) fs.closeSync(fd); }
}
async function verifyPublishedDescriptor(context: ArtifactFiles, fd: number, reference: PayloadReference, path: string, signal?: AbortSignal) {
  context.check(); const before = fs.fstatSync(fd, { bigint: true }), named = file(path, reference.bytes), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(LOG_ARTIFACT_LIMITS.chunkBytes); let used = 0;
  if (!same(before, named) || before.size !== BigInt(reference.bytes)) throw new LogArtifactError('CORRUPT');
  try {
    while (used < reference.bytes) { context.check(); checkArtifactAbort(signal); const count = await read(fd, buffer, Math.min(buffer.length, reference.bytes - used), used);
      if (count < 1) throw new LogArtifactError('CORRUPT'); hash.update(buffer.subarray(0, count)); used += count; await artifactYield(); }
    const after = file(path, reference.bytes), pinned = fs.fstatSync(fd, { bigint: true });
    if (!same(before, after) || !same(before, pinned) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || pinned.size !== before.size || hash.digest('hex') !== reference.digest) throw new LogArtifactError('CORRUPT');
    return after;
  } finally { buffer.fill(0); }
}
async function removeOwned(path: string, identity: Identity) {
  let s: fs.BigIntStats; try { s = fs.lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!s.isFile() || s.isSymbolicLink() || !same(s, identity)) throw new LogArtifactError('CORRUPT'); await unlink(path);
}
/** Private staging rename followed by atomic no-replace publication. No final artifact is overwritten. */
export async function publishArtifact(context: ArtifactFiles, binding: LogArtifactBinding, input: string | Buffer, length: number, mediaType: PayloadReference['mediaType'], signal?: AbortSignal): Promise<PayloadReference> {
  context.check(); checkArtifactAbort(signal); const temporary = join(context.scope, `.${randomBytes(32).toString('hex')}.tmp`), ready = join(context.scope, `.${randomBytes(32).toString('hex')}.ready`);
  const fd = fs.openSync(temporary, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let identity: fs.BigIntStats | undefined;
  let renamed = false, failure: unknown; const hash = createHash('sha256'); let bytes = 0;
  try {
    identity = fs.fstatSync(fd, { bigint: true }); fs.fchmodSync(fd, 0o600);
    for (const chunk of artifactChunks(input)) {
      context.check(); checkArtifactAbort(signal); let offset = 0;
      while (offset < chunk.length) { const count = await write(fd, chunk, offset); if (count < 1) throw new LogArtifactError('IO'); offset += count; }
      hash.update(chunk); bytes += chunk.length; if (bytes > length) throw new LogArtifactError('LIMIT'); await artifactYield();
    }
    if (bytes !== length) throw new LogArtifactError('CORRUPT'); await fsync(fd); checkArtifactAbort(signal); context.check();
    try { fs.lstatSync(ready); throw new LogArtifactError('CORRUPT'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, ready); renamed = true; const staged = fs.lstatSync(ready, { bigint: true });
    if (!same(identity, staged) || !staged.isFile() || staged.isSymbolicLink()) throw new LogArtifactError('CORRUPT');
    const reference: PayloadReference = Object.freeze({ ...binding, digest: hash.digest('hex'), bytes, mediaType }), final = join(context.scope, `${reference.digest}.blob`);
    let created = false, duplicate: fs.BigIntStats | undefined;
    try { await link(ready, final); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; duplicate = file(final, reference.bytes); await scanArtifact(context, reference, signal); }
    await removeOwned(ready, identity); renamed = false; context.check(); const published = file(final, reference.bytes);
    if (created && !same(published, identity) || duplicate && (!same(published, duplicate) || duplicate.mtimeNs !== published.mtimeNs || duplicate.ctimeNs !== published.ctimeNs)) throw new LogArtifactError('CORRUPT');
    const verified = created ? await verifyPublishedDescriptor(context, fd, reference, final, signal) : published;
    await syncDirectory(context, context.scope); checkArtifactAbort(signal); const last = file(final, reference.bytes);
    if (!same(verified, last) || verified.mtimeNs !== last.mtimeNs || verified.ctimeNs !== last.ctimeNs) throw new LogArtifactError('CORRUPT'); return reference;
  } catch (error) { failure = error; throw error; }
  finally { fs.closeSync(fd); if (identity) try { await removeOwned(renamed ? ready : temporary, identity); } catch (error) { if (failure === undefined) throw error; } }
}
