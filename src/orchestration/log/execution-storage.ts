import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publishLog } from './sqlite-storage.js';
import { installExecutionSchema } from './execution-schema.js';
export function publishExecutionDatabase(path: string, systemId: string, busyTimeoutMs: number): void {
  try { lstatSync(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.initializing`; let db: DatabaseSync | undefined;
  try {
    publishLog(temporary, systemId); db = new DatabaseSync(temporary);
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${busyTimeoutMs}; BEGIN IMMEDIATE`);
    installExecutionSchema(db); db.exec('COMMIT'); db.close(); db = undefined;
    const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
    try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { db?.close(); try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
