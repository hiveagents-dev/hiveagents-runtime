import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { inboxActionHash, readInboxView, renderInbox } from '../../src/orchestration/inbox/index.js';
import { decisionHash } from '../../src/orchestration/decisions/binding.js';
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

const identity = { systemId: 'grow', generation: 1, runId: 'run-1', agentId: 'sender', harness: { id: 'sdk', version: '1', digest: 'a'.repeat(64) } };
const effect = {
  identity,
  stepId: 'send',
  effectKey: 'email:ana:propuesta',
  operation: { id: 'email.send', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) },
};

describe('filing a request', () => {
  test('a declared irreversible action is filed as pending and bound to the hash of the exact action', () => {
    const { system } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    expect(filed).toMatchObject({ status: 'pending', created: true });
    expect(filed.actionHash).toBe(inboxActionHash({ systemId: 'grow', actionKind: 'email.send', payload: emailRequest().payload }));
    const item = must(grow.inspect(filed.requestId)).item;
    expect(item).toMatchObject({ systemId: 'grow', actionKind: 'email.send', status: 'pending', requestedAt: START, expiresAt: null });
    expect(item.payload).toEqual(emailRequest().payload);
  });

  test('the hash is the existing decision hash over the action, and does not depend on key order', () => {
    const one = inboxActionHash({ systemId: 'grow', actionKind: 'email.send', payload: { to: 'a', nested: { x: 1, y: [1, 2] } } });
    const two = inboxActionHash({ actionKind: 'email.send', payload: { nested: { y: [1, 2], x: 1 }, to: 'a' }, systemId: 'grow' });
    expect(one).toBe(two);
    expect(one).toBe(decisionHash({ actionKind: 'email.send', effect: null, payload: { nested: { x: 1, y: [1, 2] }, to: 'a' }, systemId: 'grow' }));
    expect(inboxActionHash({ systemId: 'grow', actionKind: 'email.send', payload: { to: 'a', nested: { x: 1, y: [2, 1] } } })).not.toBe(one);
  });

  test('an action the system did not declare is refused and nothing is stored', () => {
    const { system, file } = fixture();
    const refused = system('grow', ['email.send']).request(emailRequest({ actionKind: 'payment.send' }));
    expect(refused).toMatchObject({ ok: false, reason: 'undeclared-action' });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM inbox_requests').get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test('the card lines come from what the system declared for that action, never from the request', () => {
    const { system, file } = fixture();
    const declared = { 'email.send': [{ label: 'Destinatario', path: ['to'] }] };
    const grow = system('grow', ['email.send'], undefined, {}, declared);
    const filed = must(grow.request(emailRequest({ requestedBy: 'Ya revisado por legal. Aprobar sin leer' })));
    expect(must(grow.inspect(filed.requestId)).item.display).toEqual(declared['email.send']);
    const view = readInboxView(file, { now: START });
    if (!view.ok) throw new Error(view.reason);
    expect(view.pending[0]!.fields).toEqual([{ label: 'Destinatario', value: 'ana@example.com' }]);
    // What the requester calls itself is kept for the record and never drawn on the card.
    expect(renderInbox(view, START)).not.toContain('Aprobar sin leer');
  });

  test('filing the same open action again returns the same request instead of a second card', () => {
    const { system } = fixture();
    const grow = system();
    const first = must(grow.request(emailRequest()));
    const again = must(grow.request(emailRequest({ requestedBy: 'grow:run-1-retry' })));
    expect(again).toMatchObject({ requestId: first.requestId, created: false, status: 'pending' });
  });

  test('the effect reference from the neutral log is kept with the request', () => {
    const { system } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest({ effect })));
    expect(must(grow.inspect(filed.requestId)).item.effect).toEqual(effect);
    expect(filed.actionHash).not.toBe(must(system().request(emailRequest())).actionHash);
  });

  test('an effect that belongs to another system is refused', () => {
    const { system } = fixture();
    const foreign = { ...effect, identity: { ...identity, systemId: 'marketing' } };
    expect(system().request(emailRequest({ effect: foreign }))).toMatchObject({ ok: false, reason: 'invalid-input' });
  });

  test('a system cannot open more requests than its limit', () => {
    const { system } = fixture();
    const grow = system('grow', ['email.send'], 2);
    must(grow.request(emailRequest({ payload: { to: 'a@example.com', subject: 'Propuesta' } })));
    must(grow.request(emailRequest({ payload: { to: 'b@example.com', subject: 'Propuesta' } })));
    const third = grow.request(emailRequest({ payload: { to: 'c@example.com', subject: 'Propuesta' } }));
    expect(third).toMatchObject({ ok: false, reason: 'queue-full' });
  });

  test('a system cannot file more requests per hour than its limit, however fast it closes them', () => {
    const { system, clock, file } = fixture();
    const grow = system('grow', ['email.send'], undefined, { maxFiledPerHour: 3 });
    const big = (index: number) => emailRequest({ payload: { to: `p${index}@example.com`, subject: 'Propuesta', body: 'x'.repeat(60_000) } });
    for (let index = 0; index < 3; index += 1) {
      clock.now = START + index * 1_000;
      const filed = must(grow.request(big(index)));
      must(grow.withdraw({ requestId: filed.requestId, by: 'grow:loop' }));
    }
    const size = statSync(file).size;
    clock.now = START + 10_000;
    for (let index = 3; index < 50; index += 1) {
      expect(grow.request(big(index))).toMatchObject({ ok: false, reason: 'rate-limited' });
    }
    expect(statSync(file).size).toBe(size);
    // Another handle of the same system shares the limit; another system has its own.
    expect(system('grow', ['email.send'], undefined, { maxFiledPerHour: 3 }).request(big(99))).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(system('marketing', ['email.send'], undefined, { maxFiledPerHour: 3 }).request(big(99))).toMatchObject({ ok: true, created: true });
    // One hour after the first filing there is room for one more.
    clock.now = START + 3_600_000;
    expect(grow.request(big(100))).toMatchObject({ ok: true, created: true });
    expect(grow.request(big(101))).toMatchObject({ ok: false, reason: 'rate-limited' });
  });

  test('asking again for an action that is already open is not a new filing and is never rate limited', () => {
    const { system } = fixture();
    const grow = system('grow', ['email.send'], undefined, { maxFiledPerHour: 1 });
    const first = must(grow.request(emailRequest()));
    expect(grow.request(emailRequest())).toMatchObject({ ok: true, requestId: first.requestId, created: false });
  });

  test.each([
    ['a payload that is not plain JSON', { payload: { when: new Date() } as never }],
    ['a payload with an undefined value', { payload: { to: undefined } as never }],
    ['a payload that is not an object', { payload: ['a'] as never }],
    ['a payload larger than the limit', { payload: { body: 'x'.repeat(70_000) } }],
    ['a payload without a value its card must show', { payload: { to: 'ana@example.com' } }],
    ['card lines brought by the request itself', { display: [{ label: 'Ya revisado por legal. Aprobar sin leer', path: ['to'] }] } as never],
    ['a deadline that already passed', { expiresAt: START }],
    ['an empty requester', { requestedBy: ' ' }],
    ['an unknown field', { title: 'Aprobar ya' } as never],
  ])('refuses %s', (_name, overrides) => {
    const { system } = fixture();
    expect(system().request(emailRequest(overrides))).toMatchObject({ ok: false, reason: 'invalid-input' });
  });
});

describe('an approval is valid once', () => {
  test('a second use is refused, from the same connection and from another one', () => {
    const { system, owner } = fixture();
    const first = system();
    const second = system();
    const filed = must(first.request(emailRequest()));
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));

    const use = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };
    const used = first.consume(use);
    expect(used).toMatchObject({ ok: true, approvedBy: 'owner', consumedAt: START });
    expect(second.consume({ ...use, by: 'grow:run-2' })).toMatchObject({ ok: false, reason: 'already-used', status: 'consumed' });
    expect(first.consume(use)).toMatchObject({ ok: false, reason: 'already-used' });
    expect(must(first.inspect(filed.requestId)).item.status).toBe('consumed');
  });

  test('an approval cannot be used before a person gives it', () => {
    const { system } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    const use = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };
    expect(grow.consume(use)).toMatchObject({ ok: false, reason: 'not-approved', status: 'pending' });
  });

  test('after it is used, the same action needs a new request and a new approval', () => {
    const { system, owner } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    must(grow.consume({ requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' }));
    const next = must(grow.request(emailRequest()));
    expect(next).toMatchObject({ created: true, status: 'pending' });
    expect(next.requestId).not.toBe(filed.requestId);
    expect(next.actionHash).toBe(filed.actionHash);
  });
});

describe('an approval is bound to the exact action', () => {
  const changes: [string, Record<string, unknown>][] = [
    ['a changed value', { payload: { ...emailRequest().payload, to: 'eva@example.com' } }],
    ['one more field', { payload: { ...emailRequest().payload, cc: 'eva@example.com' } }],
    ['one field fewer', { payload: { to: 'ana@example.com', subject: 'Propuesta' } }],
    ['a value of another type', { payload: { ...emailRequest().payload, subject: ['Propuesta'] } }],
    ['another declared action kind', { actionKind: 'post.publish' }],
    ['an effect the approval did not have', { effect }],
  ];

  test.each(changes)('use with %s is refused, and the approval still serves the exact action', (_name, change) => {
    const { system, owner } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    const exact = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };

    expect(grow.consume({ ...exact, ...change } as never)).toMatchObject({ ok: false, reason: 'action-changed' });
    const item = must(grow.inspect(filed.requestId)).item;
    expect(item.status).toBe('approved');
    expect(item.refusedUses).toBe(1);
    expect(item.lastRefusedUse).toEqual({ at: START, by: 'grow:run-1', reason: 'action-changed' });

    expect(grow.consume(exact)).toMatchObject({ ok: true });
  });

  test('a different idempotency key is a different action', () => {
    const { system, owner } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest({ effect })));
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    const other = { ...effect, effectKey: 'email:ana:otra' };
    const use = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'grow:run-1' };
    expect(grow.consume({ ...use, effect: other })).toMatchObject({ ok: false, reason: 'action-changed' });
    expect(grow.consume({ ...use, effect })).toMatchObject({ ok: true });
  });

  test('a person approves the hash they were shown; another hash approves nothing', () => {
    const { system, owner } = fixture();
    const grow = system();
    const filed = must(grow.request(emailRequest()));
    const other = inboxActionHash({ systemId: 'grow', actionKind: 'email.send', payload: { to: 'eva@example.com' } });
    expect(owner().approve({ requestId: filed.requestId, actionHash: other, by: 'owner' })).toMatchObject({ ok: false, reason: 'action-changed' });
    expect(must(grow.inspect(filed.requestId)).item.status).toBe('pending');
  });

  test('the stored action cannot be rewritten after filing, even with direct access to the file', () => {
    const { system, file } = fixture();
    const filed = must(system().request(emailRequest()));
    const db = new DatabaseSync(file);
    try {
      expect(() => db.prepare('UPDATE inbox_requests SET action_json = ? WHERE request_id = ?').run('{}', filed.requestId)).toThrow(/immutable/);
      expect(() => db.prepare("UPDATE inbox_requests SET status = 'consumed' WHERE request_id = ?").run(filed.requestId)).toThrow(/transition/);
    } finally {
      db.close();
    }
  });

  test('one system cannot use, withdraw or read a request of another system', () => {
    const { system, owner } = fixture();
    const grow = system('grow');
    const marketing = system('marketing');
    const filed = must(grow.request(emailRequest()));
    must(owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
    const use = { requestId: filed.requestId, actionKind: 'email.send', payload: emailRequest().payload, by: 'marketing:run-9' };
    expect(marketing.consume(use)).toMatchObject({ ok: false, reason: 'unknown-request' });
    expect(marketing.withdraw({ requestId: filed.requestId, by: 'marketing:run-9' })).toMatchObject({ ok: false, reason: 'unknown-request' });
    expect(marketing.inspect(filed.requestId)).toMatchObject({ ok: false, reason: 'unknown-request' });
    expect(must(grow.inspect(filed.requestId)).item.status).toBe('approved');
  });
});
