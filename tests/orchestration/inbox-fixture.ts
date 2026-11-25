import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerInbox, SystemInbox } from '../../src/orchestration/inbox/index.js';
import type { InboxDisplayField, InboxRequestInput } from '../../src/orchestration/inbox/index.js';

/** A fixed starting instant, so no test depends on the hour it runs at. */
export const START = 1_800_000_000_000;

/** The card lines each action kind declares in these tests. */
export const CARDS: Readonly<Record<string, readonly InboxDisplayField[]>> = {
  'email.send': [{ label: 'Para', path: ['to'] }, { label: 'Asunto', path: ['subject'] }],
  'post.publish': [{ label: 'Red', path: ['platform'] }, { label: 'Texto', path: ['caption'] }, { label: 'Archivo', path: ['media', '0'] }],
};

/** The declared lines of the given kinds; a kind these tests do not know shows its first value. */
export function cardsFor(kinds: readonly string[]): Record<string, readonly InboxDisplayField[]> {
  return Object.fromEntries(kinds.map((kind) => [kind, CARDS[kind] ?? [{ label: 'Para', path: ['to'] }]]));
}

/** A temp directory, a movable clock and every handle opened through it, closed by `cleanup`. */
export function inboxFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'oar-inbox-'));
  const file = join(directory, 'inbox.sqlite');
  const handles: { close(): void }[] = [];
  const clock = { now: START };

  function system(
    systemId = 'grow',
    irreversibleActions: readonly string[] = ['email.send', 'post.publish'],
    maxOpenRequests?: number,
    limits: { maxFiledPerHour?: number; busyTimeoutMs?: number } = {},
    display: Readonly<Record<string, readonly InboxDisplayField[]>> = cardsFor(irreversibleActions),
  ) {
    const inbox = new SystemInbox({
      databasePath: file,
      systemId,
      irreversibleActions,
      display,
      now: () => clock.now,
      ...(maxOpenRequests === undefined ? {} : { maxOpenRequests }),
      ...limits,
    });
    handles.push(inbox);
    return inbox;
  }

  function owner(options: { approvalLifetimeMs?: number } = {}) {
    const inbox = new OwnerInbox({ databasePath: file, now: () => clock.now, ...options });
    handles.push(inbox);
    return inbox;
  }

  function cleanup() {
    for (const handle of handles.splice(0)) handle.close();
    rmSync(directory, { recursive: true, force: true });
  }

  return { directory, file, clock, system, owner, cleanup };
}

export function emailRequest(overrides: Partial<InboxRequestInput> = {}): InboxRequestInput {
  return {
    actionKind: 'email.send',
    payload: { to: 'ana@example.com', subject: 'Propuesta', body: 'Hola Ana, te paso la propuesta.' },
    requestedBy: 'grow:run-1',
    ...overrides,
  };
}

/** Unwraps a result that the test expects to have succeeded. */
export function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}
