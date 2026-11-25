import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, linkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { build } from 'tsup';
import { digest } from '../../src/routing/json.js';
import { SqliteLearningStore } from '../../src/routing/learning/store.js';
import { randomUUID } from 'node:crypto';
import { V1_SCHEMA, LEARNING_SCHEMA, migrateLearningDatabase } from '../../src/routing/learning/store-schema.js';
import { sealLearningRecord } from '../../src/routing/learning/validation.js';
const domain = digest('domain'), features = { schema: 'unit', values: [1, 0] };
const b = { model: 'a', evidenceScope: 'model' as const, provider: 'p', modelId: 'a', optionsDigest: digest({}), executionDigest: digest('cli') }, action = { id: 'a', ...b, key: digest(b) };
function oldDb() { const path = join(mkdtempSync(join(tmpdir(), 'learn-v1-')), 'e.sqlite'); writeFileSync(path, '', { mode: 0o600 }); const db = new DatabaseSync(path); db.exec(V1_SCHEMA); return { path, db }; }
function episode(id: string) { return sealLearningRecord('episode', { format: 1, id, domain, kind: 'fixed', createdAt: 1, definitionDigest: digest('def'), protocolDigest: digest('protocol'), afterSequence: 0, arms: [action], tasks: [{ taskDigest: digest(id), features }], repetitions: 1, cells: [{ taskDigest: digest(id), actionKey: action.key, repetition: 0, attemptId: 'reserved-attempt', observationId: 'reserved-observation' }] }); }
describe('learning schema migration and atomic publication', () => {
    it('upgrades recognized version1 evidence and backfills durable cell reservations', async () => {
        const { path, db } = oldDb(), e = episode('old');
        db.prepare('INSERT INTO records(kind,id,domain,digest,json) VALUES (?,?,?,?,?)').run('episode', e.id, domain, e.digest, JSON.stringify(e));
        db.prepare('INSERT INTO task_claims(domain,task_digest,split,episode_id) VALUES (?,?,?,?)').run(domain, e.tasks[0]!.taskDigest, 'fixed', e.id);
        db.close();
        const s = new SqliteLearningStore(path);
        try {
            expect((await s.get('episode', 'old'))?.digest).toBe(e.digest);
            const check = new DatabaseSync(path);
            try {
                expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
                expect(check.prepare('SELECT kind,id FROM cell_ids ORDER BY kind').all()).toHaveLength(2);
            }
            finally {
                check.close();
            }
        }
        finally {
            s.close();
        }
    });
    it('rolls back conflicting historic reservation migration without partially upgrading evidence', () => {
        const { path, db } = oldDb();
        for (const id of ['old', 'conflicting']) {
            const e = episode(id);
            db.prepare('INSERT INTO records(kind,id,domain,digest,json) VALUES (?,?,?,?,?)').run('episode', e.id, domain, e.digest, JSON.stringify(e));
        }
        db.close();
        expect(() => new SqliteLearningStore(path)).toThrow(/UNIQUE|reservation/);
        const check = new DatabaseSync(path);
        try {
            expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
            expect(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='cell_ids'").get()).toBeUndefined();
        }
        finally {
            check.close();
        }
    });
    it.each(['new', 'v1'])('allows independent concurrent first-open contenders without leaving an aliased published database %s', async (version) => {
        const root = mkdtempSync(join(tmpdir(), 'learn-open-')), path = join(root, 'e.sqlite');
        if (version === 'v1') {
            writeFileSync(path, '', { mode: 0o600 });
            const old = new DatabaseSync(path);
            old.exec(V1_SCHEMA);
            old.close();
        }
        await build({ config: false, entry: { ledger: resolve('src/routing/learning/store-sqlite.ts') }, outDir: root, format: ['cjs'], bundle: true, splitting: false, silent: true, dts: false, target: 'node22', removeNodeProtocol: false });
        const signal = new SharedArrayBuffer(4), view = new Int32Array(signal), workers: Worker[] = [];
        let ready = 0;
        try {
            await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
                const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {LearningDatabase}=require(workerData.module);parentPort.postMessage('ready');const view=new Int32Array(workerData.signal);while(Atomics.load(view,0)===0)Atomics.wait(view,0,0);try{const db=new LearningDatabase(workerData.path,5000);db.transaction(d=>d.prepare('SELECT COUNT(*) FROM records').get());db.close();parentPort.postMessage('done');}catch(error){parentPort.postMessage({error:String(error.stack)});}`, { eval: true, workerData: { module: join(root, 'ledger.cjs'), path, signal } });
                workers.push(worker);
                worker.on('error', reject);
                worker.on('message', message => {
                    if (message === 'ready') {
                        if (++ready === 4) {
                            Atomics.store(view, 0, 1);
                            Atomics.notify(view, 0, 4);
                        }
                    }
                    else if (message === 'done')
                        resolve();
                    else
                        reject(new Error(message.error));
                });
            })));
            const s = new SqliteLearningStore(path);
            s.close();
        }
        finally {
            await Promise.all(workers.map(w => w.terminate()));
        }
    }, 15000);
    it('recovers the exact closed publisher inode after a crash between link and unlink', () => {
        const root = mkdtempSync(join(tmpdir(), 'learn-publish-crash-')), path = join(root, 'e.sqlite'), temporary = path + '.' + randomUUID() + '.initializing';
        writeFileSync(temporary, '', { mode: 0o600 });
        const db = new DatabaseSync(temporary);
        db.exec(LEARNING_SCHEMA);
        db.close();
        linkSync(temporary, path);
        expect(lstatSync(path).nlink).toBe(2);
        const recovered = new SqliteLearningStore(path, { busyTimeoutMs: 1 });
        recovered.close();
        expect(existsSync(temporary)).toBe(false);
        expect(lstatSync(path).nlink).toBe(1);
        const foreign = join(root, 'foreign'), alias = foreign + '.' + randomUUID() + '.initializing';
        writeFileSync(alias, 'not-sqlite', { mode: 0o600 });
        linkSync(alias, foreign);
        expect(() => new SqliteLearningStore(foreign, { busyTimeoutMs: 1 })).toThrow();
        expect(existsSync(alias)).toBe(true);
    });
    it('reads migration version and schema under the same writer lock', () => {
        const { path, db } = oldDb();
        let locked = false;
        const original = db.exec.bind(db), exec = vi.spyOn(db, 'exec').mockImplementation(sql => { if (sql === 'BEGIN IMMEDIATE')
            locked = true; const value = original(sql); if (sql === 'COMMIT' || sql === 'ROLLBACK')
            locked = false; return value; });
        const prepare = vi.spyOn(db, 'prepare');
        const native = DatabaseSync.prototype.prepare;
        prepare.mockImplementation(function (sql) { if (sql.includes('user_version') || sql.includes('sqlite_schema'))
            expect(locked).toBe(true); return native.call(db, sql); });
        try {
            migrateLearningDatabase(db);
        }
        finally {
            prepare.mockRestore();
            exec.mockRestore();
            db.close();
        }
    });
});
