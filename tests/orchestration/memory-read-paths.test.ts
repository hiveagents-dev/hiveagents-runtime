import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import * as root from '../../src/index.js';
import * as orchestration from '../../src/orchestration/index.js';
import * as pureMemory from '../../src/orchestration/memory/index.js';
import * as systemMemory from '../../src/orchestration/memory/system.js';
import { SqliteSystemMemory } from '../../src/orchestration/memory/system.js';
import { appendTexts, episode, gateFor, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

/**
 * Plan acceptance: "Revocar impide recuperar en cada vía de lectura".
 *
 * The read paths are not listed by hand and trusted: every public method of the
 * store must be classified below as a read (with a probe) or as a write. A new
 * method that is not classified fails the first test, and a new read that is
 * classified must be given an expectation in every scenario, because each
 * scenario compares the whole table of reads.
 *
 * Two things can come back from a read and they are tracked apart:
 * - the observation itself (TEXT lives in the record's text and in the log entry);
 * - the names of its scope (NAME lives in the subject, which a grant also carries).
 */
const TEXT = 'zafiro';
const NAME = 'topacio';
const scope = scopeOf('grow', 'lessons', `cliente-${NAME}`);

interface Parties {
  owner: SqliteSystemMemory;
  grantee: SqliteSystemMemory;
  log: SqliteRunLogStore;
}
type Probe = (memory: SqliteSystemMemory, parties: Parties) => Promise<unknown>;
type Sight = 'both' | 'owner' | 'grantee' | 'nobody';
type Table = Record<string, Sight>;

/** Every method that returns stored state, and how a caller reaches the marked record through it. */
const READS: Record<string, Probe> = {
  query: memory => memory.query({ scope, text: TEXT, limit: 5 }),
  list: memory => memory.list({ scope }),
  get: async memory => (await memory.get({ scope, id: 'e1' })) ?? null,
  searchLog: (memory, parties) => memory.searchLog(parties.log, { text: TEXT }),
  status: memory => memory.status(),
  listGrants: memory => memory.listGrants(),
};
/** Methods that change state and return no stored memory. */
const WRITES = ['enable', 'disable', 'put', 'revoke', 'promote', 'rollback', 'grant', 'revokeGrant', 'close'];

/** Who reaches the observation before any withdrawal. A grant shares recall (`query`) and nothing else. */
const OBSERVATION_BEFORE: Table = { query: 'both', list: 'owner', get: 'owner', searchLog: 'owner', status: 'nobody', listGrants: 'nobody' };
/** Who reaches the scope's names before any withdrawal. */
const NAMES_BEFORE: Table = { query: 'both', list: 'owner', get: 'owner', searchLog: 'nobody', status: 'nobody', listGrants: 'both' };
const NOBODY: Table = { query: 'nobody', list: 'nobody', get: 'nobody', searchLog: 'nobody', status: 'nobody', listGrants: 'nobody' };

let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

/** A log entry found by search, stored as an episode with that position as provenance, promoted and shared. */
async function sharedLessonFromLog(): Promise<Parties & { grantId: string }> {
  const log = workspace.openLog('grow');
  await appendTexts(log, 'grow', 'one', [`el cliente ${TEXT} paga a treinta días`]);
  const owner = workspace.open('grow');
  const grantee = workspace.open('marketing');
  await owner.enable({ by: 'operator' });
  await grantee.enable({ by: 'operator' });
  const [found] = (await owner.searchLog(log, { text: TEXT })).matches;
  await owner.put(episode('grow', 'e1', found!.text, {
    scope,
    provenance: { source: 'run-log', sourceVersion: '1', observedAt: '2026-11-10T10:00:00.000Z', logPosition: found!.position },
  }));
  await owner.promote({ scope, id: 'e1', gate: await gateFor(owner, scope, 'e1'), by: 'consolidacion' });
  const grant = await owner.grant({ to: 'marketing', namespace: scope.namespace, subject: scope.subject!, by: 'sebastian' });
  return { owner, grantee, log, grantId: grant.id };
}

/** Runs every read as the owner and as the grantee; reports who gets the marker back through each. */
async function sight(parties: Parties, marker: string): Promise<Table> {
  const seen: Table = {};
  for (const [name, probe] of Object.entries(READS)) {
    const asOwner = JSON.stringify(await probe(parties.owner, parties)).includes(marker);
    const asGrantee = JSON.stringify(await probe(parties.grantee, parties)).includes(marker);
    seen[name] = asOwner ? (asGrantee ? 'both' : 'owner') : (asGrantee ? 'grantee' : 'nobody');
  }
  return seen;
}

async function withdraw(action: 'revoke' | 'rollback', memory: SqliteSystemMemory, id = 'e1'): Promise<void> {
  if (action === 'revoke') {
    await memory.revoke({ scope, id, revokedAt: '2026-11-10T11:00:00.000Z', reason: 'pedido del operador' });
  } else {
    await memory.rollback({ scope, id, by: 'sebastian', reason: 'regresión medida' });
  }
}

function sourceFiles(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[])
    .filter(file => file.endsWith('.ts'))
    .map(file => join(directory, file));
}

describe('the read paths are enumerated, not assumed', () => {
  it('classifies every public method of the store as a read or a write', () => {
    const methods = Object.getOwnPropertyNames(SqliteSystemMemory.prototype).filter(name => name !== 'constructor');
    expect(methods.sort()).toEqual([...Object.keys(READS), ...WRITES].sort());
    for (const table of [OBSERVATION_BEFORE, NAMES_BEFORE, NOBODY]) {
      expect(Object.keys(table).sort()).toEqual(Object.keys(READS).sort());
    }
  });

  it('exports no read function outside the store', () => {
    // rankMemories and evaluateMemoryGate are pure: they see only what the caller hands them.
    // memoryProviderFromPorts holds no store of its own: it reads only through the query port
    // the caller hands it, so a withdrawal in that port reaches it with no path of its own.
    // The MCP recipe builders only format a launch command for an application-owned server; they read nothing.
    // isMemoryLabel and recallableMemory validate one value the caller hands them; the limits are constants.
    expect(Object.keys(pureMemory).sort()).toEqual([
      'MEMORY_LABEL_MAX', 'MEMORY_OBSERVED_AT_MAX', 'agentDbMcpServer', 'claudeMcpConfig', 'evaluateMemoryGate',
      'isMemoryLabel', 'memoryProviderFromPorts', 'rankMemories', 'recallableMemory', 'ruvectorMcpServer',
    ]);
    for (const name of Object.keys(pureMemory)) {
      expect((orchestration as Record<string, unknown>)[name]).toBe((pureMemory as Record<string, unknown>)[name]);
    }
    // The shared item validator is one function: the pure entry and the root export the same one.
    for (const name of ['isMemoryLabel', 'recallableMemory', 'MEMORY_LABEL_MAX', 'MEMORY_OBSERVED_AT_MAX']) {
      expect((root as Record<string, unknown>)[name]).toBe((pureMemory as Record<string, unknown>)[name]);
    }
    // measureMemory reads nothing itself: its context comes from caller-supplied functions.
    // readMemoryView (view.ts) opens the file read-only and returns names and counts per system,
    // never memory text, so it has no recall path to withdraw from.
    expect(Object.keys(systemMemory).sort()).toEqual([
      'CURATOR_DEFAULT_MAX_CANDIDATES', 'CURATOR_DEFAULT_MAX_TEXT', 'CURATOR_MAX_CANDIDATES_CEILING', 'CURATOR_MAX_TEXT_CEILING',
      'CURATOR_SOURCE', 'DISTILLER_INSTRUCTIONS', 'MAX_LESSONS_PER_RECALL', 'MemoryStoreError', 'SqliteSystemMemory',
      'ablationVerdict', 'agentDistiller', 'candidateId', 'curateMemory', 'distillerPrompt', 'fileCuratorJournal',
      'hostMemoryPath', 'isMemoryStoreError', 'measureMemory', 'memoryCuratorJournal', 'parseLessons', 'readMemoryView',
      'runMemoryAblation', 'signTestPValue',
    ]);
    for (const name of Object.keys(systemMemory)) {
      expect((orchestration as Record<string, unknown>)[name]).toBe((systemMemory as Record<string, unknown>)[name]);
    }
  });

  it('lets no module outside the memory folder reach past those two entries', () => {
    // The helpers of log-search.ts read the log without the off switch or the withdrawal
    // filter. They are safe only while nothing but the store can import them.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const memoryFolder = join(root, 'orchestration', 'memory') + sep;
    const reaching: string[] = [];
    for (const file of sourceFiles(root)) {
      if (file.startsWith(memoryFolder)) continue;
      const specifiers = readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g);
      for (const [, specifier] of specifiers) {
        const target = resolve(dirname(file), specifier!);
        if (target.startsWith(memoryFolder)) reaching.push(`${relative(root, file)} -> ${relative(memoryFolder, target)}`);
      }
    }
    expect(reaching.sort()).toEqual(['orchestration/index.ts -> index.js', 'orchestration/index.ts -> system.js']);
  });
});

describe('every read path honours withdrawal', () => {
  it('starts from a record that really is reachable through the expected reads', async () => {
    const parties = await sharedLessonFromLog();
    expect(await sight(parties, TEXT)).toEqual(OBSERVATION_BEFORE);
    expect(await sight(parties, NAME)).toEqual(NAMES_BEFORE);
  });

  it.each(['revoke', 'rollback'] as const)('after %s no read path returns the record, on open and on new connections', async action => {
    const parties = await sharedLessonFromLog();

    await withdraw(action, parties.owner);

    expect(await sight(parties, TEXT)).toEqual(NOBODY);
    const fresh = { ...parties, owner: workspace.open('grow'), grantee: workspace.open('marketing') };
    expect(await sight(fresh, TEXT)).toEqual(NOBODY);
    // The grant is not the observation: it keeps naming the scope until the owner revokes the grant.
    expect(await sight(parties, NAME)).toEqual({ ...NOBODY, listGrants: 'both' });
  });

  it('a revocation issued on one connection is seen by a reader that was already open', async () => {
    const parties = await sharedLessonFromLog();
    const writer = workspace.open('grow');
    expect((await sight(parties, TEXT)).query).toBe('both');

    await withdraw('revoke', writer);

    expect(await sight(parties, TEXT)).toEqual(NOBODY);
  });

  it.each(['revoke', 'rollback'] as const)('after %s of one record, no read returns another record taken from the same log entry', async action => {
    const parties = await sharedLessonFromLog();
    const { owner, grantee } = parties;
    const provenance = (await owner.list({ scope }))[0]!.record.provenance;
    const elsewhere = scopeOf('grow', 'otro');
    await owner.put(episode('grow', 'e2', `la misma entrada, ${TEXT}`, { scope, provenance }));
    await owner.promote({ scope, id: 'e2', gate: await gateFor(owner, scope, 'e2'), by: 'consolidacion' });
    await owner.put(episode('grow', 'e3', `en otro namespace, ${TEXT}`, { scope: elsewhere, provenance }));
    await owner.promote({ scope: elsewhere, id: 'e3', gate: await gateFor(owner, elsewhere, 'e3'), by: 'consolidacion' });
    await owner.put(episode('grow', 'e4', `sin promover, ${TEXT}`, { scope, provenance }));
    const measuredE4 = await gateFor(owner, scope, 'e4');
    await owner.grant({ to: 'marketing', namespace: 'otro', by: 'sebastian' });
    const recall = (reader: SqliteSystemMemory, where = scope) => reader.query({ scope: where, text: TEXT, limit: 5 });
    expect((await recall(grantee)).map(record => record.id).sort()).toEqual(['e1', 'e2']);
    expect((await recall(grantee, elsewhere)).map(record => record.id)).toEqual(['e3']);

    await withdraw(action, owner);

    for (const readers of [parties, { ...parties, owner: workspace.open('grow'), grantee: workspace.open('marketing') }]) {
      expect(await sight(readers, TEXT)).toEqual(NOBODY);
      expect(await recall(readers.owner, elsewhere)).toEqual([]);
      expect(await recall(readers.grantee, elsewhere)).toEqual([]);
      expect(await readers.owner.list({ scope: elsewhere })).toEqual([]);
    }
    // The entry is withdrawn as a whole: nothing taken from it can be stored again or become a lesson.
    await expect(owner.put(episode('grow', 'e2', `la misma entrada, ${TEXT}`, { scope, provenance }))).rejects.toMatchObject({ code: 'WITHDRAWN' });
    await expect(owner.put(episode('grow', 'e5', `otro intento, ${TEXT}`, { scope, provenance }))).rejects.toMatchObject({ code: 'WITHDRAWN' });
    await expect(owner.promote({ scope, id: 'e4', gate: measuredE4, by: 'x' })).rejects.toMatchObject({ code: 'WITHDRAWN' });
  });

  it('revoking the grant closes every read for the grantee and none for the owner', async () => {
    const parties = await sharedLessonFromLog();

    await parties.owner.revokeGrant({ id: parties.grantId, by: 'sebastian' });

    expect(await sight(parties, TEXT)).toEqual({ ...OBSERVATION_BEFORE, query: 'owner' });
    // The owner keeps the revoked grant as a record of who shared what; the grantee no longer sees it.
    expect(await sight(parties, NAME)).toEqual({ ...NAMES_BEFORE, query: 'owner', listGrants: 'owner' });
  });

  it('switching the owner\'s memory off closes every read of its memory for both', async () => {
    const parties = await sharedLessonFromLog();

    await parties.owner.disable({ by: 'operator' });

    expect(await sight(parties, TEXT)).toEqual(NOBODY);
    // Only the owner still sees the grants it gave, so that it can revoke them without switching memory on.
    expect(await sight(parties, NAME)).toEqual({ ...NOBODY, listGrants: 'owner' });
  });

  it('switching the grantee\'s memory off closes every read for the grantee, grant metadata included', async () => {
    const parties = await sharedLessonFromLog();

    await parties.grantee.disable({ by: 'operator' });

    expect(await sight(parties, TEXT)).toEqual({ ...OBSERVATION_BEFORE, query: 'owner' });
    expect(await sight(parties, NAME)).toEqual({ ...NAMES_BEFORE, query: 'owner', listGrants: 'owner' });
  });

  it('keeps unrelated records readable after a withdrawal', async () => {
    const parties = await sharedLessonFromLog();
    await appendTexts(parties.log, 'grow', 'two', [`otra nota ${TEXT} sin relación`]);
    await parties.owner.put(episode('grow', 'e2', `segunda lección ${TEXT}`, { scope }));
    await parties.owner.promote({ scope, id: 'e2', gate: await gateFor(parties.owner, scope, 'e2'), by: 'x' });

    await withdraw('revoke', parties.owner);

    expect((await parties.owner.query({ scope, text: TEXT, limit: 5 })).map(record => record.id)).toEqual(['e2']);
    expect((await parties.grantee.query({ scope, text: TEXT, limit: 5 })).map(record => record.id)).toEqual(['e2']);
    expect((await parties.owner.list({ scope })).map(view => view.record.id)).toEqual(['e2']);
    const matches = (await parties.owner.searchLog(parties.log, { text: TEXT })).matches;
    expect(matches.map(match => match.position.sequence)).toEqual([2]);
  });
});
