import { expect, it } from 'vitest';
import { join } from 'node:path';
import { realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { SqliteRunLogStore } from '../../src/orchestration/log/sqlite-store.js';
import { createLogArtifactStore } from '../../src/orchestration/log/artifacts.js';
import { logDirectory, logDraft } from './log-store-fixture.js';
it('joint real artifact+SQLite stores durably pin a 20MiB Unicode payload without inline truncation', async () => {
  const files = logDirectory(); let artifacts: Awaited<ReturnType<typeof createLogArtifactStore>> | undefined;
  const log = new SqliteRunLogStore({ databasePath: files.file, systemId: 'fixture', supportedSchemas: [{ id: 'test', version: 1 }],
    payloadVerifier: { verify: (ref, options) => { if (!artifacts) throw Error('not configured'); return artifacts.verify(ref, options); } } });
  try {
    const artifactDirectory = join(realpathSync(files.directory), 'private-artifacts');
    artifacts = await createLogArtifactStore({ directory: artifactDirectory, binding: { sourceId: log.sourceId, systemId: 'fixture', generation: 1 } });
    const text = '😀'.repeat(5 * 1024 * 1024), reference = await artifacts.write(text, { mediaType: 'application/octet-stream' });
    expect(reference.bytes).toBe(20 * 1024 * 1024);
    await log.append({ requestId: 'real-artifact', records: [{ ...logDraft(), payload: { artifact: reference } }] });
    expect((await log.inspectRun(logDraft().identity)).kind).toBe('complete');
    expect(Buffer.from(await artifacts.read(reference)).toString('utf8')).toBe(text);
    const events = await log.readPage(); expect(events.items[0]!.record.payload).toEqual({ artifact: reference }); expect(artifacts.snapshot().pending).toBe(0);
    const scope = readdirSync(artifactDirectory)[0]!; unlinkSync(join(artifactDirectory, scope, `${reference.digest}.blob`));
    expect(await log.inspectRun(logDraft().identity)).toMatchObject({ kind: 'incomplete', issues: ['PAYLOAD_MISSING'] });
  } finally { log.close(); files.cleanup(); }
}, 15000);
