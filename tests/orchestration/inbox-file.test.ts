import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { OwnerInbox, SystemInbox, hostInboxPath } from '../../src/orchestration/inbox/index.js';
import { hostLedgerPath } from '../../src/orchestration/budget/host-ledger.js';
import { cardsFor, emailRequest, inboxFixture, must } from './inbox-fixture.js';

const cleanups: (() => void)[] = [];
function fixture() {
  const created = inboxFixture();
  cleanups.push(created.cleanup);
  return created;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('waiting for a person without polling', () => {
  test('the wait ends when the person decides', async () => {
    const { system, owner } = fixture();
    const grow = system();
    const desk = owner();
    const filed = must(grow.request(emailRequest()));
    const started = performance.now();
    const waiting = grow.waitForDecision(filed.requestId, { maxWaitMs: 5_000 });
    setTimeout(() => desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }), 50);
    await expect(waiting).resolves.toMatchObject({ ok: true, status: 'approved' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('an unanswered wait returns pending when its time is up, and zero answers at once', async () => {
    const { system } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    await expect(grow.waitForDecision(filed.requestId, { maxWaitMs: 0 })).resolves.toMatchObject({ ok: true, status: 'pending' });
    await expect(grow.waitForDecision(filed.requestId, { maxWaitMs: 40 })).resolves.toMatchObject({ ok: true, status: 'pending' });
  });

  test('the wait ends at the request\'s own deadline, not when the wait itself runs out', async () => {
    const { file } = fixture();
    // The real clock: the deadline has to pass while the waiter sleeps.
    const grow = new SystemInbox({ databasePath: file, systemId: 'grow', irreversibleActions: ['email.send'], display: cardsFor(['email.send']) });
    try {
      const filed = must(grow.request(emailRequest({ expiresAt: Date.now() + 300 })));
      const started = performance.now();
      await expect(grow.waitForDecision(filed.requestId, { maxWaitMs: 12_000 })).resolves.toEqual({ ok: true, status: 'expired' });
      expect(performance.now() - started).toBeLessThan(4_000);
    } finally {
      grow.close();
    }
  }, 20_000);

  test('a file that another process holds for too long answers busy, changes nothing and works again afterwards', () => {
    const { file, system } = fixture();
    const grow = system('grow', ['email.send'], undefined, { busyTimeoutMs: 20 });
    const first = must(grow.request(emailRequest()));
    const holder = new DatabaseSync(file);
    holder.exec('BEGIN IMMEDIATE');
    try {
      expect(grow.request(emailRequest({ payload: { to: 'b@example.com', subject: 'Otra' } }))).toMatchObject({ ok: false, reason: 'busy' });
      expect(grow.inspect(first.requestId)).toMatchObject({ ok: false, reason: 'busy' });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(must(grow.inspect(first.requestId)).item.status).toBe('pending');
    expect(grow.request(emailRequest({ payload: { to: 'b@example.com', subject: 'Otra' } }))).toMatchObject({ ok: true, created: true });
  });

  test('a wait rides out a busy file and still reports the decision', async () => {
    const { file, system, owner } = fixture();
    const grow = system('grow', ['email.send'], undefined, { busyTimeoutMs: 20 });
    const desk = owner();
    const filed = must(grow.request(emailRequest()));
    const holder = new DatabaseSync(file);
    holder.exec('BEGIN IMMEDIATE');
    let released = false;
    try {
      const waiting = grow.waitForDecision(filed.requestId, { maxWaitMs: 10_000 });
      setTimeout(() => {
        holder.exec('ROLLBACK');
        released = true;
        desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' });
      }, 200);
      await expect(waiting).resolves.toEqual({ ok: true, status: 'approved' });
      expect(released).toBe(true);
    } finally {
      if (!released) holder.exec('ROLLBACK');
      holder.close();
    }
  }, 20_000);

  test('a wait that runs out while the file is still busy says busy, not pending', async () => {
    const { file, system } = fixture();
    const grow = system('grow', ['email.send'], undefined, { busyTimeoutMs: 20 });
    const filed = must(grow.request(emailRequest()));
    const holder = new DatabaseSync(file);
    holder.exec('BEGIN IMMEDIATE');
    try {
      await expect(grow.waitForDecision(filed.requestId, { maxWaitMs: 150 })).resolves.toMatchObject({ ok: false, reason: 'busy' });
      await expect(grow.waitForDecision(filed.requestId, { maxWaitMs: 0 })).resolves.toMatchObject({ ok: false, reason: 'busy' });
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  test('an aborted wait rejects with the abort reason', async () => {
    const { system } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    const controller = new AbortController();
    const waiting = grow.waitForDecision(filed.requestId, { maxWaitMs: 5_000, signal: controller.signal });
    controller.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
  });
});

describe('the shared file', () => {
  test('lives next to the shared admission ledger unless a path is given', () => {
    const env = { HOME: '/Users/someone' };
    expect(hostInboxPath(env, 'darwin')).toBe(join(hostLedgerPath(env, 'darwin'), '..', 'inbox.sqlite'));
    expect(hostInboxPath({ ...env, OAR_HOST_LEDGER: '/data/host/admission.sqlite' }, 'darwin')).toBe('/data/host/inbox.sqlite');
    expect(hostInboxPath({ ...env, OAR_HOST_INBOX: '/data/elsewhere/inbox.sqlite' }, 'darwin')).toBe('/data/elsewhere/inbox.sqlite');
    expect(() => hostInboxPath({ ...env, OAR_HOST_INBOX: 'relative.sqlite' }, 'darwin')).toThrow(TypeError);
  });

  test('configuration mistakes are programming errors and create no file', () => {
    const { file } = fixture();
    const display = cardsFor(['email.send']);
    expect(() => new SystemInbox({ databasePath: 'inbox.sqlite', systemId: 'grow', irreversibleActions: ['email.send'], display })).toThrow(TypeError);
    expect(() => new SystemInbox({ databasePath: file, systemId: '', irreversibleActions: ['email.send'], display })).toThrow(TypeError);
    expect(() => new SystemInbox({ databasePath: file, systemId: 'grow', irreversibleActions: 'email.send' as never, display })).toThrow(TypeError);
    expect(() => new OwnerInbox({ databasePath: file, busyTimeoutMs: -1 })).toThrow(TypeError);
    expect(() => statSync(file)).toThrow();
  });

  test.each([
    ['no card lines at all', undefined],
    ['a declared action without card lines', {}],
    ['card lines for an action that was not declared', { ...cardsFor(['email.send']), 'payment.send': [{ label: 'Monto', path: ['amount'] }] }],
    ['an empty card', { 'email.send': [] }],
    ['more than eight lines', { 'email.send': Array.from({ length: 9 }, () => ({ label: 'Para', path: ['to'] })) }],
    ['a label with a line break', { 'email.send': [{ label: 'Para\nAprobá todo', path: ['to'] }] }],
    ['a label longer than 48 characters', { 'email.send': [{ label: 'Ya revisado por legal y por finanzas. Aprobar sin leer', path: ['to'] }] }],
    ['a label with a direction override', { 'email.send': [{ label: 'Para\u202e', path: ['to'] }] }],
    ['a label made of letters that draw as blank space', { 'email.send': [{ label: '\u3164\u3164', path: ['to'] }] }],
    ['a label padded with a blank letter', { 'email.send': [{ label: 'Para\u3164', path: ['to'] }] }],
    ['a label with no letter or digit', { 'email.send': [{ label: '···', path: ['to'] }] }],
    ['a line without a path', { 'email.send': [{ label: 'Para', path: [] }] }],
    ['a line with an unknown field', { 'email.send': [{ label: 'Para', path: ['to'], value: 'ana' }] }],
  ])('card lines are declared once, with the actions: %s is a programming error and creates no file', (_name, display) => {
    const { file } = fixture();
    expect(() => new SystemInbox({ databasePath: file, systemId: 'grow', irreversibleActions: ['email.send'], display: display as never })).toThrow(TypeError);
    expect(() => statSync(file)).toThrow();
  });

  test('a file that is not an inbox is never adopted or reset: every operation fails closed', () => {
    const { file, system } = fixture();
    const foreign = new DatabaseSync(file);
    foreign.exec('CREATE TABLE t(a); INSERT INTO t VALUES (1);');
    foreign.close();
    const before = readFileSync(file);
    const grow = system();
    expect(grow.request(emailRequest())).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(`${file}.bell`)).toBe(false);
  });

  test('an empty file is not treated as a new inbox', () => {
    const { file, system } = fixture();
    writeFileSync(file, '');
    expect(system().request(emailRequest())).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    expect(statSync(file).size).toBe(0);
    expect(existsSync(`${file}.bell`)).toBe(false);
  });

  test('a path that is a link, even to nothing, is refused and nothing is created beside it', () => {
    const { file, directory, system, owner } = fixture();
    symlinkSync(join(directory, 'elsewhere.sqlite'), file);
    expect(system().request(emailRequest())).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    expect(owner().sweep()).toMatchObject({ ok: false, reason: 'storage-unavailable' });
    expect(existsSync(`${file}.bell`)).toBe(false);
    expect(existsSync(join(directory, 'elsewhere.sqlite'))).toBe(false);
  });

  test('a real inbox gets its change hint file', () => {
    const { file, system } = fixture();
    system();
    expect(existsSync(`${file}.bell`)).toBe(true);
  });

  test('a closed handle refuses instead of throwing', () => {
    const { system } = fixture();
    const grow = system();
    grow.close();
    expect(grow.request(emailRequest())).toMatchObject({ ok: false, reason: 'closed' });
  });
});
