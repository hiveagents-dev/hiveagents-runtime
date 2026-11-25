import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogCommit, LogDraft } from '../../src/orchestration/log/types.js';
export function logDirectory() { const directory = mkdtempSync(join(tmpdir(), 'oar-log-proof-')); return { directory, file: join(directory, 'log.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }; }
export function logDraft(generation = 1): LogDraft { return {
  identity: { systemId: 'fixture', generation, runId: 'run', agentId: 'agent', harness: { id: 'sdk', version: 'dev', digest: 'a'.repeat(64) } },
  schema: { id: 'test', version: 1 }, type: 'captured', causal: [], payload: { inline: { text: 'captured private text' } },
}; }
export function logCommit(requestId = 'one', generation = 1): LogCommit { return { requestId, records: [logDraft(generation)] }; }
