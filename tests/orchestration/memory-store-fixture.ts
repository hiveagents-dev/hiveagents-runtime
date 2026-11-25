import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import type { LogCommit, LogReceipt } from '../../src/orchestration/log/types.js';
import { SqliteSystemMemory } from '../../src/orchestration/memory/system.js';
import type {
  MemoryGateEvidence, MemoryScope, ScopedMemoryRecord, SystemMemoryOptions,
} from '../../src/orchestration/memory/index.js';

/** One temp directory per test with every opened handle closed on cleanup. */
export function memoryWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), 'oar-memory-'));
  const closers: { close(): void }[] = [];
  let tick = 0;
  /** A strictly increasing clock so "newest first" orderings are deterministic. */
  const now = () => new Date(Date.UTC(2026, 10, 10, 12, 0, tick++)).toISOString();
  return {
    directory,
    databasePath: join(directory, 'memory.sqlite'),
    now,
    /** Every call opens its own SQLite connection, as a separate process would. */
    open(systemId: string, options: Partial<SystemMemoryOptions> = {}) {
      const memory = new SqliteSystemMemory({
        databasePath: join(directory, 'memory.sqlite'), systemId, now, ...options,
      });
      closers.push(memory);
      return memory;
    },
    openLog(systemId: string) {
      const log = new SqliteRunLogStore({
        databasePath: join(directory, `log-${systemId}.sqlite`),
        systemId,
        supportedSchemas: [{ id: 'test', version: 1 }],
      });
      closers.push(log);
      return log;
    },
    cleanup() {
      for (const closer of closers.splice(0)) closer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const HASH = 'a'.repeat(64);

export function scopeOf(tenant: string, namespace = 'lessons', subject?: string): MemoryScope {
  return subject === undefined ? { tenant, namespace } : { tenant, namespace, subject };
}

export function episode(
  tenant: string, id: string, text: string, overrides: Partial<ScopedMemoryRecord> = {},
): ScopedMemoryRecord {
  return {
    id,
    scope: scopeOf(tenant),
    text,
    provenance: { source: 'operator-note', sourceVersion: '1', observedAt: '2026-11-10T10:00:00.000Z', inputHash: HASH },
    ...overrides,
  };
}

/** A gate whose measured comparison passes: memory beats no-memory, both controls present. */
export function passingGate(...candidateDigests: string[]): MemoryGateEvidence {
  return {
    measurementId: 'measurement-1',
    digest: 'b'.repeat(64),
    candidateDigests,
    noMemory: { passed: 1, total: 4 },
    memory: { passed: 3, total: 4 },
    fullHistory: { passed: 3, total: 4 },
  };
}

/** A passing gate that measured these stored records: it carries their content digests, as a real one must. */
export async function gateFor(memory: SqliteSystemMemory, scope: MemoryScope, ...ids: string[]): Promise<MemoryGateEvidence> {
  const views = await memory.list({ scope, limit: 256 });
  return passingGate(...ids.map(id => {
    const view = views.find(candidate => candidate.record.id === id);
    if (!view) throw new Error(`No readable record ${id} to measure`);
    return view.contentDigest;
  }));
}

export function logCommit(systemId: string, requestId: string, texts: readonly string[], runId = 'run'): LogCommit {
  return {
    requestId,
    records: texts.map(text => ({
      identity: {
        systemId, generation: 1, runId, agentId: 'agent',
        harness: { id: 'sdk', version: 'dev', digest: HASH },
      },
      schema: { id: 'test', version: 1 },
      type: 'note.captured',
      causal: [],
      payload: { inline: { text } },
    })),
  };
}

export async function appendTexts(
  log: SqliteRunLogStore, systemId: string, requestId: string, texts: readonly string[],
): Promise<LogReceipt> {
  return log.append(logCommit(systemId, requestId, texts));
}
