import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskHandoff, WorkflowHandoffStore, type TaskHandoffDraft } from '../../src/orchestration/handoff/index.js';
import { CodexThreadRegistry } from '../../src/adapters/codex-control/identity.js';
import { Session } from '../../src/session/session.js';
import { FileWorkflowStore } from '../../src/orchestration/workflow/file-store.js';
import { checksum } from '../../src/orchestration/workflow/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowStore } from '../../src/orchestration/workflow/types.js';

const hash = 'a'.repeat(64);
const draft = (): TaskHandoffDraft => ({ id: 'transfer-1', goal: 'Verify selected report', requirements: ['Check receipt'],
  context: { selected: ['safe-context'], count: 1 }, source: { id: 'producer', version: '1', digest: hash, episodeId: 'episode-1' },
  destination: { id: 'receiver', version: '1', provider: 'codex', model: 'explicit-model' },
  sourceSession: { schemaVersion: 1, provider: 'claude', id: 'old-session', cwd: '/project', transport: 'exec', persistence: 'process', createdAt: '2026-11-09T00:00:00.000Z' },
  evidence: [{ id: 'classification', digest: hash }], artifacts: [{ uri: 'https://never-fetch.invalid/report', digest: hash }],
  pending: ['Verify report'], unresolvedEffects: [] });

function memoryStore() {
  let value: unknown, owned = false, writes = 0;
  const store: WorkflowStore = { async acquire() {
    if (owned) throw Error('owned'); owned = true;
    return { async load() { return value; }, async save(next) { value = structuredClone(next); writes++; }, async release() { owned = false; } };
  } };
  return { store, get: () => value as WorkflowCheckpoint, replace: (next: unknown) => { value = next; }, writes: () => writes };
}

describe('task handoff bundles', () => {
  it('captures all selected JSON and provenance without retaining mutable inputs', () => {
    const input = draft(); const bundle = createTaskHandoff(input);
    (input.context as { selected: string[] }).selected.push('later');
    input.source.version = 'changed';
    expect(bundle.context).toEqual({ count: 1, selected: ['safe-context'] });
    expect(bundle.source.version).toBe('1');
    expect(bundle.sourceSession?.id).toBe('old-session');
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen((bundle.context as { selected: string[] }).selected)).toBe(true);
    expect(Object.isFrozen(bundle.sourceSession)).toBe(true);
  });

  it('accepts real Codex registry Session refs and exports including fork provenance', async () => {
    const registry = new CodexThreadRegistry({ epoch: 'codex-control-epoch' });
    registry.register({ threadId: 'thread-parent', cwd: '/project', persistence: 'provider' });
    const identities = [registry.identity('thread-parent'), registry.register({ threadId: 'thread-child', cwd: '/project',
      persistence: 'provider', forkedFromId: 'thread-parent' })];
    for (const identity of identities) {
      const f = memoryStore(), store = new WorkflowHandoffStore(f.store);
      const session = new Session({ resume: identity, model: { id: 'codex-local', provider: 'codex', aliases: [], source: 'explicit', availability: 'unverified' },
        adapter: { id: 'codex', async detect() { throw Error('no native probe'); }, async auth() { throw Error('no auth probe'); },
          async models() { throw Error('no model probe'); }, async execute() { throw Error('no native execution'); } },
        cwd: '/project', transport: 'control', persistence: 'provider', env: {}, contextArgs: [], permissionArgs: [], warnings: [], features: {} });
      const refBundle = createTaskHandoff({ ...draft(), id: identity.id, sourceSession: session.ref! });
      expect(refBundle.sourceSession).toEqual(session.export());
      expect(refBundle.sourceSession).toMatchObject({ id: identity.id, sessionId: identity.id });
      if (identity.forkedFromId) expect(refBundle.sourceSession).toMatchObject({ forkedFromId: 'thread-parent' });
      await store.save(refBundle);
      expect((await new WorkflowHandoffStore(f.store).load(identity.id))?.sourceSession).toEqual(session.export());
    }
  });

  it('preserves documented parent-session provenance and rejects inconsistent or unknown session metadata', () => {
    const registry = new CodexThreadRegistry({ epoch: 'codex-control-epoch' });
    const identity = registry.register({ threadId: 'thread-child', cwd: '/project', persistence: 'provider', forkedFromId: 'thread-parent' });
    const sourceSession = { ...identity, parentSessionId: 'thread-parent' };
    expect(createTaskHandoff({ ...draft(), sourceSession }).sourceSession).toMatchObject({ parentSessionId: 'thread-parent' });
    const wrongAlias = { ...sourceSession, sessionId: 'other-thread' }, emptyFork = { ...sourceSession, forkedFromId: '' };
    expect(() => createTaskHandoff({ ...draft(), sourceSession: wrongAlias })).toThrow();
    expect(() => createTaskHandoff({ ...draft(), sourceSession: emptyFork })).toThrow();
    expect(() => createTaskHandoff({ ...draft(), sourceSession: { ...sourceSession, parentSessionId: 7 } } as never)).toThrow();
    expect(() => createTaskHandoff({ ...draft(), sourceSession: { ...sourceSession, providerRaw: { secret: true } } } as never)).toThrow();
  });

  it('uses canonical key ordering and no generated timestamp for idempotent identity', () => {
    const input = draft(); const reordered = { ...input, context: { count: 1, selected: ['safe-context'] } };
    expect(createTaskHandoff(input)).toEqual(createTaskHandoff(reordered));
    const bundle = createTaskHandoff(input);
    // Independently calculated with Python hashlib over sorted-key, compact JSON.
    expect(bundle.digest).toBe('066aa9944aefdf0dca652b187852d9ff289b293925190a81ec1425d0a2c6b5c4');
    expect(Object.keys(bundle).sort()).toEqual(['artifacts', 'context', 'destination', 'digest', 'evidence', 'format', 'goal', 'id', 'pending', 'requirements', 'source', 'sourceSession', 'unresolvedEffects']);
  });

  it.each([
    ['unknown root field', () => ({ ...draft(), permission: 'allow' })],
    ['invalid digest', () => ({ ...draft(), source: { ...draft().source, digest: 'broken' } })],
    ['unknown source field', () => ({ ...draft(), source: { ...draft().source, approval: true } })],
    ['unknown destination field', () => ({ ...draft(), destination: { ...draft().destination, resume: 'old' } })],
    ['array-valued session enum', () => ({ ...draft(), sourceSession: { ...draft().sourceSession!, transport: ['exec'] } })],
    ['malformed artifact URI', () => ({ ...draft(), artifacts: [{ uri: 'relative/path', digest: hash }] })],
    ['invalid session provenance', () => ({ ...draft(), sourceSession: { ...draft().sourceSession!, transport: 'invalid' } })],
    ['unknown session provenance field', () => ({ ...draft(), sourceSession: { ...draft().sourceSession!, authorization: true } })],
    ['undefined context', () => ({ ...draft(), context: { invalid: undefined } })],
    ['nonfinite JSON', () => ({ ...draft(), context: Infinity })],
    ['oversized JSON', () => ({ ...draft(), context: 'x'.repeat(1_100_000) })],
    ['oversized list', () => ({ ...draft(), requirements: Array(1001).fill('one') })],
    ['empty goal', () => ({ ...draft(), goal: '' })],
    ['invalid artifact', () => ({ ...draft(), artifacts: [{ uri: '', digest: hash }] })],
  ])('rejects %s at creation', (_name, input) => {
    expect(() => createTaskHandoff(input() as TaskHandoffDraft)).toThrow();
  });

  it('does not invoke accessors or toJSON while validating selected JSON', () => {
    let invoked = false;
    const input = draft(); Object.defineProperty(input, 'goal', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
    expect(() => createTaskHandoff(input)).toThrow(); expect(invoked).toBe(false);
    expect(() => createTaskHandoff({ ...draft(), context: new Date() as never })).toThrow();
  });

  it('rejects array subclasses without invoking inherited serialization', () => {
    let invoked = false;
    class ForeignArray extends Array { toJSON() { invoked = true; return []; } }
    expect(() => createTaskHandoff({ ...draft(), context: new ForeignArray() })).toThrow();
    expect(invoked).toBe(false);
  });

  it('rejects accessor-bearing persisted envelopes without invoking them', async () => {
    const f = memoryStore(); let invoked = false;
    const corrupt = { format: 1, runId: 'handoff:transfer-1', status: 'completed', steps: {} };
    Object.defineProperty(corrupt, 'workflow', { enumerable: true, get() { invoked = true; return {}; } });
    f.replace(corrupt);
    await expect(new WorkflowHandoffStore(f.store).load('transfer-1')).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  it('persists privately across reconstructed stores and treats artifact URIs as inert text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'handoff-'));
    try {
      const bundle = createTaskHandoff(draft());
      await new WorkflowHandoffStore(new FileWorkflowStore(directory)).save(bundle);
      const loaded = await new WorkflowHandoffStore(new FileWorkflowStore(directory)).load(bundle.id);
      expect(loaded).toEqual(bundle); expect(Object.isFrozen(loaded?.context)).toBe(true);
      const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
      expect(await new WorkflowHandoffStore(new FileWorkflowStore(directory)).load('missing')).toBeUndefined();
      const text = JSON.parse(await readFile(join(directory, file), 'utf8'));
      text.checkpoint.steps.bundle.output.goal = 'corrupted';
      text.checksum = checksum(JSON.stringify(text.checkpoint));
      await writeFile(join(directory, file), JSON.stringify(text));
      await expect(new WorkflowHandoffStore(new FileWorkflowStore(directory)).load(bundle.id)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects same-id changed content and avoids rewriting identical bundles', async () => {
    const f = memoryStore(), store = new WorkflowHandoffStore(f.store), one = createTaskHandoff(draft());
    await store.save(one); await store.save(createTaskHandoff(draft()));
    expect(f.writes()).toBe(1);
    await expect(store.save(createTaskHandoff({ ...draft(), goal: 'different' }))).rejects.toThrow(/different|collision|immutable/i);
    expect(await store.load(one.id)).toEqual(one);
  });

  it('validates loaded envelopes, bundle fields, identity, and checksum before reuse', async () => {
    const f = memoryStore(), store = new WorkflowHandoffStore(f.store);
    await store.save(createTaskHandoff(draft())); const good = structuredClone(f.get());
    for (const mutate of [
      (v: WorkflowCheckpoint) => { v.status = 'running'; },
      (v: WorkflowCheckpoint) => { (v.steps.bundle!.output as Record<string, unknown>).id = 'other'; },
      (v: WorkflowCheckpoint) => { (v.steps.bundle!.output as Record<string, unknown>).extra = 'untrusted'; },
      (v: WorkflowCheckpoint) => { v.steps.bundle!.attempts = 0; },
    ]) {
      const bad = structuredClone(good); mutate(bad); f.replace(bad);
      await expect(store.load('transfer-1')).rejects.toThrow();
    }
    f.replace(good); expect((await store.load('transfer-1'))?.id).toBe('transfer-1');
  });

  it('uses existing ownership and releases it when persistence fails', async () => {
    const f = memoryStore(); const held = await f.store.acquire('handoff:transfer-1');
    await expect(new WorkflowHandoffStore(f.store).save(createTaskHandoff(draft()))).rejects.toThrow('owned');
    await held.release();
    const failed: WorkflowStore = { async acquire(id) { const lease = await f.store.acquire(id);
      return { ...lease, async save() { throw Error('disk full'); } }; } };
    await expect(new WorkflowHandoffStore(failed).save(createTaskHandoff(draft()))).rejects.toThrow('disk full');
    await new WorkflowHandoffStore(f.store).save(createTaskHandoff(draft()));
    expect((await new WorkflowHandoffStore(f.store).load('transfer-1'))?.goal).toBe('Verify selected report');
  });
});
