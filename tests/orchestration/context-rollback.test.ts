// A signed history that lost its newest versions still verifies. These tests remove rows and
// files behind the store, as an agent with disk access could, and show that a caller who states
// what it last saw gets an error instead of older or missing rules.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import {
  compileContext,
  ConstraintAuthority,
  ConstraintIntegrityError,
  ConstraintStore,
  deliverPinned,
  NothingPinnedError,
  requirePinned,
  type CompiledContext,
  type ConstraintExpectation,
} from '../../src/orchestration/context/index.ts';

const dirs: string[] = [];
const stores: ConstraintStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function ownerStore() {
  const dir = mkdtempSync(join(tmpdir(), 'oar-context-'));
  dirs.push(dir);
  const path = join(dir, 'constraints.sqlite');
  const authority = ConstraintAuthority.create();
  let clock = 1_700_000_000_000;
  const store = ConstraintStore.create(authority, { databasePath: path, now: () => clock++ });
  stores.push(store);
  return { authority, store, path };
}
/** What an agent with disk access can do: drop the append-only guard and delete rows. */
function deleteRows(path: string, where: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('DROP TRIGGER IF EXISTS context_constraints_no_delete');
    raw.exec(`DELETE FROM context_constraints WHERE ${where}`);
  } finally {
    raw.close();
  }
}
/** `NOTHING` is a caller with no memory of the store: no earlier call and no manifest list. */
const NOTHING: readonly ConstraintExpectation[] = [];
function compile(store: ConstraintStore, require: readonly ConstraintExpectation[], scopes = ['host']): CompiledContext {
  return compileContext({ constraints: store, scopes, task: { instructions: 'Continue.' }, budget: { maxBytes: 20_000 }, require });
}
const NO_SEND = { scope: 'host', id: 'no-send', setBy: 'owner' };
const LOOSE = 'Sending without approval is allowed this week.';
const TIGHT = 'Never send an email without an approved decision.';

test('the compiled context reports the newest version of every constraint, revoked ones included', () => {
  const { authority, store } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: TIGHT, expectedVersion: 0 });
  store.pin(authority, { scope: 'host', id: 'language', text: 'Reply in Spanish.', setBy: 'owner', expectedVersion: 0 });
  store.pin(authority, { scope: 'host', id: 'language', text: 'Reply in formal Spanish.', setBy: 'owner', expectedVersion: 1 });
  store.pin(authority, { scope: 'host', id: 'old', text: 'A rule of last year.', setBy: 'owner', expectedVersion: 0 });
  store.revoke(authority, { scope: 'host', id: 'old', setBy: 'owner', reason: 'expired', expectedVersion: 1 });

  const compiled = compile(store, NOTHING);
  expect(compiled.seen).toEqual([
    { scope: 'host', id: 'language', minVersion: 2, status: 'active' },
    { scope: 'host', id: 'no-send', minVersion: 1, status: 'active' },
    { scope: 'host', id: 'old', minVersion: 2, status: 'revoked' },
  ]);
  expect(Object.isFrozen(compiled.seen)).toBe(true);
  expect(compiled.pinned.carried.map((entry) => entry.id)).toEqual(['language', 'no-send']);

  // What one call saw is a valid requirement for the next, and stays valid as the owner moves on.
  expect(compile(store, compiled.seen).pinned).toEqual(compiled.pinned);
  store.pin(authority, { ...NO_SEND, text: `${TIGHT} This includes drafts.`, expectedVersion: 1 });
  store.pin(authority, { scope: 'host', id: 'old', text: 'The rule of last year is back.', setBy: 'owner', expectedVersion: 2 });
  const later = compile(store, compiled.seen);
  expect(later.pinned.carried.map((entry) => `${entry.id} v${entry.version}`)).toEqual(['language v2', 'no-send v2', 'old v3']);
});

test('deleting the newest version of a tightened rule does not bring the looser one back', () => {
  const { authority, store, path } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: LOOSE, expectedVersion: 0 });
  store.pin(authority, { ...NO_SEND, text: TIGHT, expectedVersion: 1 });
  const before = compile(store, NOTHING);
  expect(before.pinned.text).toContain(TIGHT);

  deleteRows(path, "constraint_id = 'no-send' AND version = 2");

  // The store on its own serves v1: every row left is signed.
  expect(store.active(['host'])[0]).toMatchObject({ version: 1, text: LOOSE });
  // The caller that remembers what it carried last time is not served it.
  expect(() => compile(store, before.seen)).toThrow(ConstraintIntegrityError);
  expect(() => compile(store, before.seen)).toThrow(/host\/no-send.*v1.*v2/);
  expect(() => compile(store, [{ scope: 'host', id: 'no-send', minVersion: 2 }])).toThrow(ConstraintIntegrityError);
});

test('deleting a revocation does not bring the revoked rule back', () => {
  const { authority, store, path } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: LOOSE, expectedVersion: 0 });
  store.revoke(authority, { scope: 'host', id: 'no-send', setBy: 'owner', reason: 'the week is over', expectedVersion: 1 });
  const before = compile(store, NOTHING);
  expect(before.pinned.text).toBe('');
  expect(before.seen).toEqual([{ scope: 'host', id: 'no-send', minVersion: 2, status: 'revoked' }]);

  deleteRows(path, "constraint_id = 'no-send' AND version = 2");

  expect(store.active(['host'])[0]).toMatchObject({ version: 1, text: LOOSE });
  expect(() => compile(store, before.seen)).toThrow(ConstraintIntegrityError);
  // A caller that states no requirement is served the revoked text as pinned.
  const unguarded = requirePinned(deliverPinned({ options: { model: 'claude/sonnet' }, pinned: compile(store, NOTHING).pinned, turn: 'fresh' }));
  expect(unguarded.options.instructions).toContain(LOOSE);
});

test('a constraint the caller requires and the store no longer holds stops the call', () => {
  const { authority, store, path } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: TIGHT, expectedVersion: 0 });
  store.pin(authority, { scope: 'host', id: 'language', text: 'Reply in Spanish.', setBy: 'owner', expectedVersion: 0 });
  const before = compile(store, NOTHING);

  // One constraint removed whole.
  deleteRows(path, "constraint_id = 'no-send'");
  expect(() => compile(store, before.seen)).toThrow(/host\/no-send is not in the store/);
  // A requirement taken from a manifest, not from an earlier call, catches it too.
  expect(() => compile(store, [{ scope: 'host', id: 'no-send', minVersion: 1 }])).toThrow(ConstraintIntegrityError);
  expect(compile(store, [{ scope: 'host', id: 'language', minVersion: 1 }]).pinned.carried).toHaveLength(1);

  // Every row removed.
  deleteRows(path, '1 = 1');
  expect(() => compile(store, before.seen)).toThrow(ConstraintIntegrityError);
  expect(compile(store, NOTHING).seen).toEqual([]);
});

test('a requirement names the status the caller saw: the same version with another status is refused', () => {
  const { authority, store } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: TIGHT, expectedVersion: 0 });
  expect(() => compile(store, [{ scope: 'host', id: 'no-send', minVersion: 1, status: 'revoked' }])).toThrow(ConstraintIntegrityError);
  expect(compile(store, [{ scope: 'host', id: 'no-send', minVersion: 1, status: 'active' }]).pinned.carried).toHaveLength(1);
  // A later version may have any status: the owner moved on.
  store.revoke(authority, { scope: 'host', id: 'no-send', setBy: 'owner', reason: 'replaced', expectedVersion: 1 });
  expect(compile(store, [{ scope: 'host', id: 'no-send', minVersion: 1, status: 'active' }]).pinned.text).toBe('');
});

test('a mistyped scope is caught when the caller states what it requires', () => {
  const { authority, store } = ownerStore();
  store.pin(authority, { scope: 'system:grow', id: 'no-send', setBy: 'owner', text: TIGHT, expectedVersion: 0 });
  const manifest: ConstraintExpectation[] = [{ scope: 'system:grow', id: 'no-send', minVersion: 1 }];
  expect(compile(store, manifest, ['system:grow']).pinned.text).toContain(TIGHT);
  // Without a requirement the typo compiles to an empty channel.
  expect(compile(store, NOTHING, ['system:gorw']).pinned.text).toBe('');
  // With it, the call does not go ahead.
  expect(() => compile(store, manifest, ['system:gorw'])).toThrow(/system:grow.*not among the requested scopes/);
  expect(() => compile(store, [{ scope: 'system:gorw', id: 'no-send', minVersion: 1 }], ['system:gorw'])).toThrow(ConstraintIntegrityError);
});

test('a deleted store file does not turn into a delivery without rules', () => {
  const { authority, store, path } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: TIGHT, expectedVersion: 0 });
  const before = compile(store, NOTHING);
  store.close();
  rmSync(path);

  // A host that reopens the store for the next turn is stopped at the open.
  expect(() => new ConstraintStore({ databasePath: path, publicKey: authority.publicKey })).toThrow(ConstraintIntegrityError);

  // If the owner's setup code made a new store in its place, both guards still stop the turn.
  const replaced = ConstraintStore.create(authority, { databasePath: path });
  stores.push(replaced);
  expect(() => new ConstraintStore({ databasePath: path, publicKey: authority.publicKey, storeId: store.id })).toThrow(ConstraintIntegrityError);
  expect(() => compile(replaced, before.seen)).toThrow(ConstraintIntegrityError);
  const delivery = deliverPinned({ options: { model: 'claude/sonnet' }, pinned: compile(replaced, NOTHING).pinned, turn: 'fresh' });
  expect(delivery.status).toBe('nothing-pinned');
  expect(() => requirePinned(delivery)).toThrow(NothingPinnedError);
});

test('a requirement is validated at the boundary', () => {
  const { authority, store } = ownerStore();
  store.pin(authority, { ...NO_SEND, text: TIGHT, expectedVersion: 0 });
  const ok = { scope: 'host', id: 'no-send', minVersion: 1 };
  const bad: unknown[] = [
    'host/no-send',
    [{ ...ok, minVersion: 0 }],
    [{ ...ok, minVersion: 1.5 }],
    [{ ...ok, minVersion: '1' }],
    [{ ...ok, status: 'pinned' }],
    [{ ...ok, scope: 'Host' }],
    [{ scope: 'host', id: 'no-send' }],
    [{ ...ok, version: 1 }],
    [ok, ok],
    [ok, { ...ok, minVersion: 2 }],
    [null],
  ];
  for (const require of bad) {
    expect(() => compile(store, require as never)).toThrow(TypeError);
  }
  expect(compile(store, []).pinned.carried).toHaveLength(1);
  // Leaving it out is not a way to say "nothing": the caller has to write the empty list.
  expect(() => compileContext({ constraints: store, scopes: ['host'], task: { instructions: 'x' }, budget: { maxBytes: 9_000 } } as never)).toThrow(TypeError);
  expect(() => compile(store, undefined as never)).toThrow(TypeError);
});
