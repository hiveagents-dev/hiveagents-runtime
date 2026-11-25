import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, readdirSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recoverPublishedDatabase, unlinkPublicationTemp } from './store-publication.js';
import { LEARNING_APPLICATION_ID as APP, LEARNING_SCHEMA as SCHEMA, LEARNING_CATALOG as expected, learningCatalog as catalog, migrateLearningDatabase } from './store-schema.js';
function statFile(path: string): Stats {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.())
        throw new Error('Learning database must be a private regular owned file');
    return s;
}
function verifySidecars(path: string): void {
    for (const extension of ['-wal', '-shm', '-journal']) {
        try {
            statFile(path + extension);
        }
        catch (error) {
            // SQLite may unlink an auxiliary file as its last connection closes.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
    }
}
function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw e;
    }
}
function directory(path: string, create = false): void {
    if (!isAbsolute(path) || normalize(path) !== path)
        throw new TypeError('Learning database requires normalized absolute path');
    const parent = dirname(path), missing: string[] = [];
    // Inspect ancestors BEFORE mkdir: an untrusted symlink must not receive even an empty directory.
    for (let current = parent;; current = dirname(current)) {
        if (!exists(current)) {
            if (!create)
                throw new Error('Learning directory removed');
            missing.push(current);
        }
        else {
            const s = lstatSync(current);
            if (!s.isDirectory()) {
                const container = lstatSync(dirname(current));
                // macOS /var and /tmp are root-managed aliases, unlike user-controlled directory links.
                if (!(s.isSymbolicLink() && s.uid === 0 && current !== parent && container.uid === 0 && (container.mode & 0o022) === 0))
                    throw new Error('Unsafe learning directory');
            }
        }
        if (current === dirname(current))
            break;
    }
    for (const current of missing.reverse()) {
        try {
            mkdirSync(current, { mode: 0o700 });
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw e;
        }
        const s = lstatSync(current);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700)
            throw new Error('Unsafe new learning directory');
    }
    const s = lstatSync(parent);
    if ((s.mode & 0o777) !== 0o700 || s.uid !== process.getuid?.())
        throw new Error('Learning directory must be private (0700) and owned');
}
function publish(path: string): void {
    const temp = `${path}.${randomUUID()}.initializing`;
    closeSync(openSync(temp, 'wx', 0o600));
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(temp);
        db.exec(`PRAGMA synchronous=FULL; BEGIN IMMEDIATE;${SCHEMA} COMMIT;`);
        db.close();
        db = undefined;
        const fd = openSync(temp, 'r');
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        try {
            linkSync(temp, path);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw e;
        }
        unlinkPublicationTemp(temp);
        const dir = openSync(dirname(path), 'r');
        try {
            fsyncSync(dir);
        }
        finally {
            closeSync(dir);
        }
    }
    finally {
        db?.close();
        unlinkPublicationTemp(temp);
    }
}
function retryBusy<T>(work: () => T, timeout: number): T {
    const until = Date.now() + timeout;
    for (;;) {
        try {
            return work();
        }
        catch (error) {
            const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined;
            if (typeof code !== 'number' || ![5, 6].includes(code & 255) || Date.now() >= until)
                throw error;
            // Journal-mode transitions can return BUSY immediately instead of using SQLite's busy handler.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
    }
}
/** Private local reference ledger. Filesystem owner remains the trust boundary. */
export class LearningDatabase {
    readonly db: DatabaseSync;
    readonly path: string;
    readonly identity: {
        dev: number;
        ino: number;
    };
    constructor(path: string, timeout: number) {
        if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000)
            throw new TypeError('Invalid busy timeout');
        this.path = path;
        directory(path, true);
        if (!exists(path))
            publish(path);
        let before: Stats;
        for (;;) {
            try {
                before = statFile(path);
                break;
            }
            catch (error) {
                if (recoverPublishedDatabase(path))
                    continue;
                before = statFile(path);
                break;
            }
        }
        this.identity = { dev: before.dev, ino: before.ino };
        verifySidecars(path);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const s = fstatSync(fd), header = Buffer.alloc(100);
            if (s.dev !== before.dev || s.ino !== before.ino || readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readUInt32BE(68) !== APP || ![1, 2].includes(header.readUInt32BE(60)))
                throw new Error('Unrecognized learning database');
        }
        finally {
            closeSync(fd);
        }
        this.db = new DatabaseSync(path);
        try {
            this.db.exec(`PRAGMA busy_timeout=${timeout}`);
            retryBusy(() => {
                migrateLearningDatabase(this.db);
                this.verify(true);
                this.db.exec('PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;PRAGMA journal_mode=WAL;');
                this.verify();
            }, timeout);
        }
        catch (e) {
            this.db.close();
            throw e;
        }
    }
    verify(full = false): void {
        directory(this.path);
        const s = statFile(this.path);
        if (s.dev !== this.identity.dev || s.ino !== this.identity.ino)
            throw new Error('Learning database replaced');
        verifySidecars(this.path);
        if (this.db.prepare('PRAGMA application_id').get()?.application_id !== APP || this.db.prepare('PRAGMA user_version').get()?.user_version !== 2 || catalog(this.db) !== expected || full && (this.db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').get()))
            throw new Error('Learning database integrity/version/schema failure');
    }
    transaction<T>(fn: (db: DatabaseSync) => T): T {
        this.verify();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn(this.db);
            this.verify();
            this.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* Preserve original IO error. */ }
            throw e;
        }
    }
    close(): void { this.db.close(); }
}
