import { afterEach, expect, test } from 'vitest';
import { bindDecision } from '../../src/orchestration/decisions/binding.js';
import { DecisionRunner } from '../../src/orchestration/decisions/runner.js';
import { readInboxView } from '../../src/orchestration/inbox/index.js';
import { LogDecisionStore } from '../../src/orchestration/log/decision-store.js';
import { inspectManagedEffect } from '../../src/orchestration/log/effects.js';
import { LogExecutionDatabase } from '../../src/orchestration/log/execution-database.js';
import type { JsonValue } from '../../src/orchestration/workflow/types.js';
import { emailRequest, inboxFixture, must } from './inbox-fixture.js';
import { logDirectory, logDraft } from './log-store-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// The neutral log's own fixture identity: system `fixture`, generation 1, run `run`, agent `agent`.
const association = {
  identity: logDraft().identity,
  stepId: 'send',
  effectKey: 'email:ana:propuesta',
  operation: { id: 'email.send', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) },
};

test('an approval is traced to the effect recorded in the neutral log, and the effect ran once', async () => {
  const files = logDirectory();
  cleanups.push(files.cleanup);
  const database = new LogExecutionDatabase({ databasePath: files.file, systemId: 'fixture' });
  cleanups.push(() => database.close());
  const fixture = inboxFixture();
  cleanups.push(fixture.cleanup);
  const system = fixture.system('fixture', ['email.send']);
  const desk = fixture.owner();
  const payload = emailRequest().payload;

  // The system asks, a person approves, and the approval is used immediately before the effect.
  const filed = must(system.request(emailRequest({ effect: association, requestedBy: 'fixture:run' })));
  must(desk.approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
  let sent = 0;
  const run = () => new DecisionRunner(new LogDecisionStore({ database, association })).run({
    id: 'send-proposal',
    binding: bindDecision({ input: payload as JsonValue, authority: null, inputVersion: '1', authorityVersion: '1' }),
    authorize: () => {
      const used = system.consume({ requestId: filed.requestId, actionKind: 'email.send', payload, effect: association, by: 'fixture:run' });
      return used.ok
        ? { decision: 'allow', reason: `approved by ${used.approvedBy}`, expiresAt: Date.now() + 60_000 }
        : { decision: 'deny', reason: used.reason, expiresAt: Date.now() + 60_000 };
    },
    isCurrent: () => true,
    execute: () => {
      sent += 1;
      return { delivered: true };
    },
    verify: () => ({ verified: true, evidence: ['smtp:250'] }),
  });
  expect((await run()).status).toBe('verified');
  // Running the same decision again neither sends again nor needs the approval again.
  expect((await run()).status).toBe('verified');
  expect(sent).toBe(1);

  // From the request to the effect: the stored reference is the log's own association.
  const item = must(desk.inspect(filed.requestId)).item;
  expect(item.status).toBe('consumed');
  expect(item.effect).toEqual(association);
  const effect = inspectManagedEffect(database, item.effect!);
  expect(effect?.decisionId).toBe('send-proposal');
  expect(effect?.record?.status).toBe('verified');
  expect(effect?.record?.authorization?.reason).toBe('approved by owner');

  // From the screen: the outcome names the run, the agent and the idempotency key.
  const view = readInboxView(fixture.file, { now: fixture.clock.now });
  if (!view.ok) throw new Error(view.reason);
  expect(view.recent[0]!.effect).toEqual({ runId: 'run', agentId: 'agent', effectKey: 'email:ana:propuesta' });
});

test('an approval given for one effect does not serve the same payload under another idempotency key', () => {
  const fixture = inboxFixture();
  cleanups.push(fixture.cleanup);
  const system = fixture.system('fixture', ['email.send']);
  const payload = emailRequest().payload;
  const filed = must(system.request(emailRequest({ effect: association, requestedBy: 'fixture:run' })));
  must(fixture.owner().approve({ requestId: filed.requestId, actionHash: filed.actionHash, by: 'owner' }));
  const resend = { ...association, effectKey: 'email:ana:propuesta:otra-vez' };
  const use = { requestId: filed.requestId, actionKind: 'email.send', payload, by: 'fixture:run' };
  expect(system.consume({ ...use, effect: resend })).toMatchObject({ ok: false, reason: 'action-changed' });
  expect(system.consume(use)).toMatchObject({ ok: false, reason: 'action-changed' });
  expect(system.consume({ ...use, effect: association })).toMatchObject({ ok: true });
});
