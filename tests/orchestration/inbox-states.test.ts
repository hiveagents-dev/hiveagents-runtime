import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { OwnerInbox } from '../../src/orchestration/inbox/index.js';
import { START, emailRequest, inboxFixture, must } from './inbox-fixture.js';

const cleanups: (() => void)[] = [];
function fixture() {
  const created = inboxFixture();
  cleanups.push(created.cleanup);
  return created;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('rejection, expiry and withdrawal are explicit states', () => {
  test('a rejected request cannot be used or approved later', () => {
    const { system, owner } = fixture();
    const grow = system();
    const desk = owner();
    const filed = must(grow.request(emailRequest()));
    expect(desk.reject({ requestId: filed.requestId, by: 'owner', reason: 'No le escribas todavía' })).toMatchObject({ ok: true, status: 'rejected' });
    const use = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };
    expect(grow.consume(use)).toMatchObject({ ok: false, reason: 'rejected', status: 'rejected' });
    expect(desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' })).toMatchObject({ ok: false, reason: 'not-pending', status: 'rejected' });
  });

  test('an unanswered request expires at its deadline and stays expired', () => {
    const { system, owner, clock } = fixture();
    const grow = system();
    const desk = owner();
    const filed = must(grow.request(emailRequest({ expiresAt: START + 60_000 })));
    clock.now = START + 60_000;
    expect(desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' })).toMatchObject({ ok: false, reason: 'expired', status: 'expired' });
    const item = must(grow.inspect(filed.requestId)).item;
    expect(item.status).toBe('expired');
    expect(item.transitions.at(-1)).toEqual({ sequence: 2, from: 'pending', to: 'expired', by: 'inbox:clock', at: START + 60_000, note: 'Nobody answered before the deadline' });
    clock.now = START;
    expect(must(grow.inspect(filed.requestId)).item.status).toBe('expired');
  });

  test('an approval that is not used in time expires and cannot be used', () => {
    const { system, owner, clock } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner', expiresAt: START + 5_000 }));
    clock.now = START + 5_000;
    const use = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };
    expect(grow.consume(use)).toMatchObject({ ok: false, reason: 'expired', status: 'expired' });
    expect(must(grow.inspect(filed.requestId)).item.transitions.at(-1)).toMatchObject({ from: 'approved', to: 'expired', by: 'inbox:clock' });
  });

  test('a sweep makes every due expiry durable and reports how many', () => {
    const { system, owner, clock } = fixture();
    const grow = system();
    must(grow.request(emailRequest({ expiresAt: START + 1_000 })));
    must(grow.request(emailRequest({ payload: { to: 'b@example.com', subject: 'Propuesta' }, expiresAt: START + 2_000 })));
    must(grow.request(emailRequest({ payload: { to: 'c@example.com', subject: 'Propuesta' } })));
    clock.now = START + 2_000;
    expect(owner().sweep()).toEqual({ ok: true, expired: 2 });
    expect(owner().sweep()).toEqual({ ok: true, expired: 0 });
  });

  test('a system withdraws a request it no longer needs, pending or approved', () => {
    const { system, owner } = fixture();
    const grow = system();
    const desk = owner();
    const pending = must(grow.request(emailRequest()));
    expect(grow.withdraw({ requestId: pending.requestId, by: 'grow:run-1', reason: 'run halted' })).toMatchObject({ ok: true, status: 'withdrawn' });
    expect(desk.approve({ requestId: pending.requestId, actionHash: pending.actionHash, by: 'owner' })).toMatchObject({ ok: false, reason: 'not-pending', status: 'withdrawn' });

    const approved = must(grow.request(emailRequest()));
    must(desk.approve({ requestId: approved.requestId, actionHash: approved.actionHash, by: 'owner' }));
    must(grow.withdraw({ requestId: approved.requestId, by: 'grow:run-1' }));
    const use = { requestId: approved.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };
    expect(grow.consume(use)).toMatchObject({ ok: false, reason: 'withdrawn' });
  });
});

describe('an approval that was given but not used yet', () => {
  const HOUR = 3_600_000;
  const use = (requestId: string) => ({ requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' });

  test('the person takes it back, and no connection can use it afterwards', () => {
    const { system, owner, clock } = fixture();
    const grow = system();
    const desk = owner();
    const filed = must(grow.request(emailRequest()));
    must(desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    clock.now = START + 5_000;
    expect(owner().reject({ requestId: filed.requestId, by: 'owner', reason: 'Me arrepentí' })).toEqual({ ok: true, status: 'rejected', wasApproved: true });
    expect(grow.consume(use(filed.requestId))).toMatchObject({ ok: false, reason: 'rejected', status: 'rejected' });
    expect(system().consume(use(filed.requestId))).toMatchObject({ ok: false, reason: 'rejected', status: 'rejected' });
    expect(must(desk.inspect(filed.requestId)).item.transitions.at(-1)).toEqual(
      { sequence: 3, from: 'approved', to: 'rejected', by: 'owner', at: START + 5_000, note: 'Me arrepentí' });
  });

  test('rejecting a pending request says it had not been approved', () => {
    const { system, owner } = fixture();
    const filed = must(system().request(emailRequest()));
    expect(owner().reject({ requestId: filed.requestId, by: 'owner' })).toEqual({ ok: true, status: 'rejected', wasApproved: false });
  });

  test('taking it back after it was used is refused and says it was already used', () => {
    const { system, owner } = fixture();
    const grow = system();
    const desk = owner();
    const filed = must(grow.request(emailRequest()));
    must(desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    must(grow.consume(use(filed.requestId)));
    expect(desk.reject({ requestId: filed.requestId, by: 'owner' })).toMatchObject({ ok: false, reason: 'already-used', status: 'consumed' });
    expect(must(desk.inspect(filed.requestId)).item.status).toBe('consumed');
  });

  test('given without a deadline, it lasts one hour and then cannot be used, however late the system comes back', () => {
    const { system, owner, clock } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    expect(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }))
      .toEqual({ ok: true, status: 'approved', approvalExpiresAt: START + HOUR });
    clock.now = START + HOUR - 1;
    expect(must(grow.inspect(filed.requestId)).item).toMatchObject({ status: 'approved', approvalExpiresAt: START + HOUR });
    clock.now = START + 30 * 24 * HOUR;
    expect(grow.consume(use(filed.requestId))).toMatchObject({ ok: false, reason: 'expired', status: 'expired' });
    expect(must(grow.inspect(filed.requestId)).item.transitions.at(-1)).toMatchObject({ from: 'approved', to: 'expired', by: 'inbox:clock' });
  });

  test('the default lifetime is set where the person answers, and one approval can ask for its own deadline', () => {
    const { system, owner } = fixture();
    const grow = system();
    const desk = owner({ approvalLifetimeMs: 60_000 });
    const first = must(grow.request(emailRequest()));
    expect(must(desk.approve({ requestId: first.requestId, actionHash: first.actionHash, by: 'owner' })).approvalExpiresAt).toBe(START + 60_000);
    must(grow.withdraw({ requestId: first.requestId, by: 'grow:run-1' }));
    const second = must(grow.request(emailRequest()));
    expect(must(desk.approve({ requestId: second.requestId, actionHash: second.actionHash, by: 'owner', expiresAt: START + 5_000 })).approvalExpiresAt).toBe(START + 5_000);
  });

  test('no approval is open-ended: a deadline further than thirty days is refused, and so is a lifetime that is not a time', () => {
    const { system, owner, file } = fixture();
    const filed = must(system().request(emailRequest()));
    const tooFar = START + 30 * 24 * HOUR + 1;
    expect(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner', expiresAt: tooFar })).toMatchObject({ ok: false, reason: 'invalid-input' });
    expect(() => new OwnerInbox({ databasePath: file, approvalLifetimeMs: 0 })).toThrow(TypeError);
    expect(() => new OwnerInbox({ databasePath: file, approvalLifetimeMs: 31 * 24 * HOUR })).toThrow(TypeError);
  });

  test('the file itself refuses an approval without a deadline, and lets an approval be rejected but nothing leave a final state', () => {
    const { system, owner, file } = fixture();
    const grow = system();
    const pending = must(grow.request(emailRequest()));
    const approved = must(grow.request(emailRequest({ payload: { to: 'b@example.com', subject: 'Otra' } })));
    must(owner().approve({ requestId: approved.requestId, actionHash: approved.actionHash, by: 'owner' }));
    const db = new DatabaseSync(file);
    try {
      expect(() => db.prepare("UPDATE inbox_requests SET status = 'approved' WHERE request_id = ?").run(pending.requestId)).toThrow(/constraint/i);
      db.prepare("UPDATE inbox_requests SET status = 'rejected' WHERE request_id = ?").run(approved.requestId);
      expect(() => db.prepare("UPDATE inbox_requests SET status = 'approved' WHERE request_id = ?").run(approved.requestId)).toThrow(/transition/);
      expect(() => db.prepare("UPDATE inbox_requests SET status = 'consumed' WHERE request_id = ?").run(approved.requestId)).toThrow(/transition/);
    } finally {
      db.close();
    }
  });
});

describe('every transition is recorded with who and when', () => {
  test('filed, approved and used', () => {
    const { system, owner, clock } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    clock.now = START + 1_000;
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    clock.now = START + 2_000;
    must(grow.consume({ requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-7' }));
    expect(must(owner().inspect(filed.requestId)).item.transitions).toEqual([
      { sequence: 1, from: null, to: 'pending', by: 'grow:run-1', at: START },
      { sequence: 2, from: 'pending', to: 'approved', by: 'owner', at: START + 1_000 },
      { sequence: 3, from: 'approved', to: 'consumed', by: 'grow:run-7', at: START + 2_000 },
    ]);
  });

  test('a rejection keeps the person and their reason', () => {
    const { system, owner } = fixture();
    const filed = must(system().request(emailRequest()));
    must(owner().reject({ requestId: filed.requestId, by: 'owner', reason: 'No le escribas todavía' }));
    expect(must(owner().inspect(filed.requestId)).item.transitions.at(-1)).toEqual(
      { sequence: 2, from: 'pending', to: 'rejected', by: 'owner', at: START, note: 'No le escribas todavía' });
  });

  test('recorded transitions cannot be rewritten', () => {
    const { system, file } = fixture();
    must(system().request(emailRequest()));
    const db = new DatabaseSync(file);
    try {
      expect(() => db.exec("UPDATE inbox_transitions SET actor = 'someone-else'")).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });

  test('an open request and its history cannot be deleted, and a transition the request did not make cannot be added', () => {
    const { system, owner, file } = fixture();
    const grow = system();
    const pending = must(grow.request(emailRequest()));
    const approved = must(grow.request(emailRequest({ payload: { to: 'b@example.com', subject: 'Otra' } })));
    must(owner().approve({ requestId: approved.requestId, actionHash: approved.actionHash, by: 'owner' }));
    const db = new DatabaseSync(file);
    try {
      for (const id of [pending.requestId, approved.requestId]) {
        expect(() => db.prepare('DELETE FROM inbox_transitions WHERE request_id = ?').run(id)).toThrow(/cannot be deleted/);
        expect(() => db.prepare('DELETE FROM inbox_requests WHERE request_id = ?').run(id)).toThrow(/cannot be deleted/);
      }
      const forge = db.prepare(`INSERT INTO inbox_transitions(request_id, sequence, from_status, to_status, actor, at) VALUES (?, ?, ?, ?, 'owner', ${START})`);
      // An approval the request never received, a second copy of one it did, and one out of order.
      expect(() => forge.run(pending.requestId, 2, 'pending', 'approved')).toThrow(/must record the change/);
      expect(() => forge.run(approved.requestId, 3, 'pending', 'approved')).toThrow(/must record the change/);
      expect(() => forge.run(approved.requestId, 7, 'approved', 'approved')).toThrow(/must record the change/);
      // A request cannot be born approved or used.
      const born = db.prepare(`INSERT INTO inbox_requests(request_id, system_id, action_kind, action_hash, action_json, display_json,
        status, requested_at, approval_expires_at, changed_at) VALUES ('forged', 'grow', 'email.send', ?, '{}', '[]', ?, ${START}, ?, ${START})`);
      expect(() => born.run('f'.repeat(64), 'approved', START + 1_000)).toThrow(/must start pending/);
      expect(() => born.run('f'.repeat(64), 'consumed', null)).toThrow(/must start pending/);
    } finally {
      db.close();
    }
    expect(must(grow.inspect(pending.requestId)).item.transitions).toHaveLength(1);
    expect(must(grow.inspect(approved.requestId)).item.transitions).toHaveLength(2);
  });
});
