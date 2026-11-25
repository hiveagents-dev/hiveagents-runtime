import { describe, expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ temporary: '', site: '', lstats: 0, headerFd: -1, removed: false }));
vi.mock('node:fs', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs')>();
    const remove = () => { real.unlinkSync(race.temporary); race.removed = true; };
    return { ...real,
        openSync: (...args: Parameters<typeof real.openSync>) => { if (args[0] === race.temporary && race.site === 'open' && !race.removed)
            remove(); const fd = real.openSync(...args); if (args[0] === race.temporary)
            race.headerFd = fd; return fd; },
        lstatSync: (...args: Parameters<typeof real.lstatSync>) => { if (args[0] === race.temporary && race.site === 'final-lstat' && ++race.lstats === 2 && !race.removed)
            remove(); return real.lstatSync(...args); },
        closeSync: (fd: number) => { real.closeSync(fd); if (fd === race.headerFd && race.site === 'readonly-open' && !race.removed)
            remove(); }
    };
});
import { mkdtempSync, writeFileSync, linkSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
import { LEARNING_APPLICATION_ID, LEARNING_SCHEMA, V1_SCHEMA } from '../../src/routing/learning/store-schema.js';
function candidate(schema = LEARNING_SCHEMA) {
    const root = mkdtempSync(join(tmpdir(), 'learn-publish-race-')), path = join(root, 'e.sqlite'), temporary = path + '.' + randomUUID() + '.initializing';
    writeFileSync(temporary, '', { mode: 0o600 });
    const db = new DatabaseSync(temporary);
    db.exec(schema);
    db.close();
    linkSync(temporary, path);
    return { path, temporary };
}
describe('publication recovery validates before cleanup and tolerates peers', () => {
    it.each(['open', 'final-lstat', 'readonly-open'])('re-stats a healthy published target after the peer removes staging at %s', site => {
        const { path, temporary } = candidate();
        Object.assign(race, { temporary, site, lstats: 0, headerFd: -1, removed: false });
        try {
            const store = new SqliteLearningStore(path, { busyTimeoutMs: 1 });
            store.close();
            expect(race.removed).toBe(true);
            expect(existsSync(temporary)).toBe(false);
            expect(lstatSync(path).nlink).toBe(1);
        }
        finally {
            Object.assign(race, { temporary: '', site: '', headerFd: -1 });
        }
    });
    it.each([1, 2])('preserves a closed foreign catalog claiming application/version %s', version => {
        const { path, temporary } = candidate(`CREATE TABLE third_party(value TEXT);PRAGMA application_id=${LEARNING_APPLICATION_ID};PRAGMA user_version=${version};`), before = readFileSync(path);
        expect(() => new SqliteLearningStore(path, { busyTimeoutMs: 1 })).toThrow();
        expect(existsSync(temporary)).toBe(true);
        expect(readFileSync(path)).toEqual(before);
        expect(readFileSync(temporary)).toEqual(before);
        expect(lstatSync(path).nlink).toBe(2);
    });
    it.each([V1_SCHEMA, LEARNING_SCHEMA])('recovers only an exact recognized catalog without mutating the staging inode', schema => {
        const { path, temporary } = candidate(schema);
        const store = new SqliteLearningStore(path, { busyTimeoutMs: 1 });
        store.close();
        expect(existsSync(temporary)).toBe(false);
        expect(lstatSync(path).nlink).toBe(1);
    });
    it('preserves a malformed SQLite inode and never issues mutating SQL while a staging alias remains', () => {
        const { path, temporary } = candidate();
        const bytes = readFileSync(path);
        bytes[100] = 0;
        writeFileSync(path, bytes);
        const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
        try {
            expect(() => new SqliteLearningStore(path, { busyTimeoutMs: 1 })).toThrow();
            expect(existsSync(temporary)).toBe(true);
            expect(readFileSync(path)).toEqual(bytes);
            expect(exec.mock.calls).toHaveLength(0);
            for (const suffix of ['-wal', '-shm', '-journal'])
                expect(existsSync(temporary + suffix)).toBe(false);
        }
        finally {
            exec.mockRestore();
        }
    });
});
