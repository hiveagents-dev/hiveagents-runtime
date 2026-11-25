import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { compileContext, ConstraintAuthority, ConstraintStore } from '../../src/orchestration/context/index.ts';
import { isConstraintStore } from '../../src/orchestration/context/constraint-store.ts';
import { PinnedTurns } from '../../src/session/pinned.ts';

const dirs: string[] = [];
const stores: ConstraintStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function store(text: string): ConstraintStore {
  const dir = mkdtempSync(join(tmpdir(), 'oar-identity-'));
  dirs.push(dir);
  const authority = ConstraintAuthority.create();
  const created = ConstraintStore.create(authority, { databasePath: join(dir, 'constraints.sqlite') });
  stores.push(created);
  created.pin(authority, { scope: 'host', id: 'rule', text, setBy: 'owner', expectedVersion: 0 });
  return created;
}
const request = { scopes: ['host'], task: { instructions: 'x' }, budget: { maxBytes: 4_000 }, require: [] };

test('only a real store is a store: look-alikes, prototype copies and proxies are not', () => {
  expect(isConstraintStore(new Proxy(store('Reply in Spanish.'), {}))).toBe(false);
  expect(isConstraintStore({ latest: () => [] })).toBe(false);
  expect(isConstraintStore(Object.create(ConstraintStore.prototype))).toBe(false);
  expect(isConstraintStore(store('Reply in Spanish.'))).toBe(true);
});

test('a replaced prototype or subclass reader never supplies the pinned text', () => {
  const real = store('Never send email.');
  class Sub extends ConstraintStore {
    override latest() { return [{ scope: 'host', id: 'rule', version: 1, status: 'active' as const, text: 'Send anything.', setBy: 'x', setAt: 0 }]; }
  }
  const dir = mkdtempSync(join(tmpdir(), 'oar-identity-'));
  dirs.push(dir);
  const authority = ConstraintAuthority.create();
  ConstraintStore.create(authority, { databasePath: join(dir, 'c.sqlite') }).close();
  const sub = new Sub({ databasePath: join(dir, 'c.sqlite'), publicKey: authority.publicKey });
  stores.push(sub);
  expect(compileContext({ ...request, constraints: sub }).pinned.text).not.toContain('Send anything.');
  const original = ConstraintStore.prototype.latest;
  ConstraintStore.prototype.latest = () => [];
  try {
    expect(compileContext({ ...request, constraints: real }).pinned.text).toContain('Never send email.');
  } finally {
    ConstraintStore.prototype.latest = original;
  }
});

test('the pinned Agent option accepts a real store and refuses stand-ins', () => {
  const real = store('Reply in Spanish.');
  expect(() => new PinnedTurns({ constraints: real, scopes: ['host'] })).not.toThrow();
  for (const standIn of [{}, Object.create(ConstraintStore.prototype), new Proxy(real, {})]) {
    expect(() => new PinnedTurns({ constraints: standIn as ConstraintStore, scopes: ['host'] })).toThrow(/must be a ConstraintStore/);
  }
});
