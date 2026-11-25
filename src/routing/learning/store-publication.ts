import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LEARNING_APPLICATION_ID, LEARNING_CATALOG, LEARNING_V1_CATALOG, learningCatalog } from './store-schema.js';
function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw error;
    }
}
/** Only closed, complete, private publisher staging aliases may be recovered. Never adopt arbitrary DB aliases. */
export function recoverPublishedDatabase(path: string): boolean {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 2 || current.uid !== process.getuid?.() || (current.mode & 0o777) !== 0o600)
        return false;
    const parent = dirname(path), prefix = basename(path) + '.';
    const candidates = readdirSync(parent).filter(name => name.startsWith(prefix) && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.initializing$/.test(name.slice(prefix.length)));
    for (const name of candidates) {
        const temporary = join(parent, name);
        let staging;
        try {
            staging = lstatSync(temporary);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                continue;
            throw error;
        }
        if (!staging.isFile() || staging.isSymbolicLink() || staging.nlink !== 2 || staging.uid !== current.uid || (staging.mode & 0o777) !== 0o600 || staging.dev !== current.dev || staging.ino !== current.ino)
            continue;
        if ([path, temporary].some(file => ['-wal', '-shm', '-journal'].some(suffix => exists(file + suffix))))
            return false;
        let fd: number;
        try {
            fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return false;
            throw error;
        }
        let valid = false;
        try {
            const stat = fstatSync(fd), header = Buffer.alloc(100);
            valid = stat.dev === current.dev && stat.ino === current.ino && stat.nlink === 2 && readSync(fd, header, 0, 100, 0) === 100 && header.subarray(0, 16).toString() === 'SQLite format 3\0' && header[18] === 1 && header[19] === 1 && header.readUInt32BE(68) === LEARNING_APPLICATION_ID && [1, 2].includes(header.readUInt32BE(60));
        }
        finally {
            closeSync(fd);
        }
        if (!valid)
            return false;
        // Header labels alone cannot authorize deleting an alias. Inspect the exact catalog and
        // integrity through a read-only connection, then close it before any filesystem mutation.
        let candidate: DatabaseSync | undefined;
        try {
            candidate = new DatabaseSync(temporary, { readOnly: true });
            const version = candidate.prepare('PRAGMA user_version').get()?.user_version;
            const catalog = learningCatalog(candidate);
            if (candidate.prepare('PRAGMA application_id').get()?.application_id !== LEARNING_APPLICATION_ID
                || (version === 1 ? catalog !== LEARNING_V1_CATALOG : version === 2 ? catalog !== LEARNING_CATALOG : true)
                || candidate.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok'
                || candidate.prepare('PRAGMA foreign_key_check').get() !== undefined)
                return false;
        }
        catch (error) {
            if (!exists(temporary))
                return false;
            throw error;
        }
        finally {
            candidate?.close();
        }
        let final;
        try {
            final = lstatSync(temporary);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return false;
            throw error;
        }
        if (final.dev !== current.dev || final.ino !== current.ino || !final.isFile() || final.isSymbolicLink())
            return false;
        try {
            unlinkSync(temporary);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        const dir = openSync(parent, 'r');
        try {
            fsyncSync(dir);
        }
        finally {
            closeSync(dir);
        }
        return true;
    }
    return false;
}
/** A peer may have recovered this exact staging name after publication. */
export function unlinkPublicationTemp(path: string): void {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
}
