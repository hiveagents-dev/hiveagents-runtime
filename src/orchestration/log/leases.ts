import { randomUUID } from 'node:crypto';
import { canonical, freeze, object } from '../../shared/json.js';
import { digest } from './encoding.js';
import { captureIdentity } from './reconstruction.js';
import { runKey } from './execution-validation.js';
import { executionFailure } from './execution-types.js';
import type { ExecutionOwnership } from './execution-types.js';
import type { ExecutionDatabaseContext } from './execution-database.js';
import type { LogJsonValue, RunIdentity } from './types.js';
const active = new Set<string>();
function activeKey(context: ExecutionDatabaseContext, ownerId: string): string { return `${context.storageDigest}:${ownerId}`; }
export function inspectOwner(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', key: string): ExecutionOwnership | undefined {
  const row = context.db.prepare('SELECT owner_json,owner_digest FROM main.oar_execution_leases WHERE kind=? AND run_key=?').get(kind, key);
  if (!row) return undefined;
  try {
    if (typeof row.owner_json !== 'string' || row.owner_json.length > 4096 || digest(row.owner_json) !== row.owner_digest) executionFailure('INTEGRITY');
    const owner = JSON.parse(row.owner_json); object(owner, ['format', 'sourceId', 'kind', 'runKey', 'identity', 'ownerId']);
    if (Object.keys(owner).length !== 6 || canonical(owner) !== row.owner_json || owner.format !== 1 || owner.sourceId !== context.source.sourceId
      || owner.kind !== kind || owner.runKey !== key || typeof owner.ownerId !== 'string' || !/^[\da-f-]{36}$/.test(owner.ownerId)) executionFailure('INTEGRITY');
    const identity = captureIdentity(owner.identity as RunIdentity);
    if (identity.systemId !== context.source.systemId || runKey(context.source.sourceId, identity) !== key) executionFailure('INTEGRITY');
    return freeze(owner) as unknown as ExecutionOwnership;
  } catch { return executionFailure('INTEGRITY'); }
}
function ownerEvent(context: ExecutionDatabaseContext, owner: ExecutionOwnership, type: string): void {
  context.binding.appendInTransaction({ requestId: `owner:${type}:${owner.ownerId}`, records: [{ identity: owner.identity, schema: { id: 'oar.execution.ownership', version: 1 }, type: `ownership.${type}`, causal: [], payload: { inline: owner as unknown as LogJsonValue } }] });
}
export function acquireOwner(context: ExecutionDatabaseContext, kind: 'decision' | 'workflow', identity: RunIdentity): ExecutionOwnership {
  const key = runKey(context.source.sourceId, identity); if (inspectOwner(context, kind, key)) executionFailure('RUN_OWNED');
  const owner: ExecutionOwnership = freeze({ format: 1, sourceId: context.source.sourceId, kind, runKey: key, identity, ownerId: randomUUID() });
  const encoded = canonical(owner); context.db.prepare('INSERT INTO main.oar_execution_leases VALUES(?,?,?,?)').run(kind, key, encoded, digest(encoded));
  ownerEvent(context, owner, 'acquired'); return owner;
}
export function markOwnerActive(context: ExecutionDatabaseContext, owner: ExecutionOwnership): void { active.add(activeKey(context, owner.ownerId)); }
export function markOwnerDrained(context: ExecutionDatabaseContext, owner: ExecutionOwnership): void { active.delete(activeKey(context, owner.ownerId)); }
export function assertOwner(context: ExecutionDatabaseContext, owner: ExecutionOwnership): void {
  context.assert();
  const actual = inspectOwner(context, owner.kind, owner.runKey); if (!actual || canonical(actual) !== canonical(owner)) executionFailure('RUN_OWNED');
}
export function releaseOwner(context: ExecutionDatabaseContext, owner: ExecutionOwnership): void {
  assertOwner(context, owner); ownerEvent(context, owner, 'released');
  if (context.db.prepare('DELETE FROM main.oar_execution_leases WHERE kind=? AND run_key=? AND owner_digest=?').run(owner.kind, owner.runKey, digest(canonical(owner))).changes !== 1) executionFailure('RUN_OWNED');
}
export function recoverOwner(context: ExecutionDatabaseContext, expected: LogJsonValue): void {
  try {
    object(expected, ['format', 'sourceId', 'kind', 'runKey', 'identity', 'ownerId']);
    if (!['decision', 'workflow'].includes(expected.kind as string) || typeof expected.runKey !== 'string') executionFailure('INVALID_STATE');
    const owner = inspectOwner(context, expected.kind as 'decision' | 'workflow', expected.runKey);
    if (!owner || canonical(owner) !== canonical(expected) || active.has(activeKey(context, owner.ownerId))) executionFailure('RUN_OWNED');
    ownerEvent(context, owner, 'operator-recovered'); context.db.prepare('DELETE FROM main.oar_execution_leases WHERE kind=? AND run_key=? AND owner_digest=?').run(owner.kind, owner.runKey, digest(canonical(owner)));
  } catch { return executionFailure('RUN_OWNED'); }
}
