import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';
import { canaryBudget, PostconditionRegistry, runPromotionGate } from '../../src/orchestration/evaluation/index.js';
import type { PromotionGateOptions, PromotionSubject } from '../../src/orchestration/evaluation/index.js';
import { canaryLastAttempt, freeSilently, jumps, ledgerProcess, ring, until, waiting, witnessJumps } from './budget-fixtures/priority-probe.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const dirs: string[] = [];
const ledgers: HostLedger[] = [];
const children: ChildProcess[] = [];

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oar-gate-canary-'));
  dirs.push(directory);
  return join(directory, 'ledger.sqlite');
}

function open(databasePath: string): HostLedger {
  const ledger = new HostLedger({
    databasePath,
    providers: { claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 80 } },
  });
  ledgers.push(ledger);
  return ledger;
}

/** A system whose run leaves a counter in memory-free JSON state; no model is involved. */
function gate(events: string[], budget: PromotionGateOptions['budget']): PromotionGateOptions {
  const subject = (label: string, prompt: string): PromotionSubject => ({
    profile: { id: 'counter', version: '1', sourceDigest: sha('harness') },
    promptDigest: sha(prompt),
    run: (input) => {
      events.push(`${label} ran`);
      return { state: { written: (input as { value: number }).value }, claim: 'done' };
    },
  });
  const verifiers = new PostconditionRegistry().register({
    id: 'value written',
    version: '1',
    verify: ({ state, input }) => {
      const written = (state as { written: number }).written, wanted = (input as { value: number }).value;
      return written === wanted ? { status: 'verified', evidence: { written } } : { status: 'failed', evidence: { written, wanted } };
    },
  });
  return {
    id: 'counter-gate',
    postconditions: [{ id: 'value written', description: 'The requested value is stored.' }],
    verifiers,
    suite: { id: 'counter', version: '1', cases: [{ id: 'seven', input: { value: 7 }, expected: null }] },
    baseline: subject('baseline', 'prompt one'),
    candidate: subject('candidate', 'prompt two'),
    timeoutMs: 20_000,
    ...(budget === undefined ? {} : { budget }),
  };
}

afterEach(() => {
  children.splice(0).forEach(child => child.kill('SIGKILL'));
  ledgers.splice(0).forEach(ledger => ledger.close());
  dirs.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

test('with the quota full the gate\'s canary runs wait, and a production run that arrives later goes first', async () => {
  const file = path();
  const holder = open(file), evaluation = open(file);
  witnessJumps(file);
  const held = holder.reserve('claude', 'production:earlier');
  if (!held.allowed) throw new Error(held.reason);

  const events: string[] = [];
  const budget = canaryBudget(evaluation, { providerKey: 'claude', owner: 'counter:canary', maxWaitMs: 60_000 });
  const deciding = runPromotionGate({ ...gate(events, budget), timeoutMs: 120_000 });
  await until(() => waiting(file).length === 1, 'the canary to be waiting');
  expect(waiting(file).map(waiter => waiter.priority)).toEqual([0]);

  // Production arrives later from its own process and is held still while the slot frees, so the
  // gate's canary is the only one able to take it. It must leave it: nothing of the system runs.
  const production = ledgerProcess(file, 'production-later', 'normal', children);
  await until(() => production.check() && waiting(file).length === 2, 'the production run to be waiting');
  await production.stall();
  freeSilently(file, held.reservation.token);
  const before = canaryLastAttempt(file);
  await new Promise(resolve => setTimeout(resolve, 5));
  ring(file);
  await until(() => canaryLastAttempt(file) !== before || events.length > 0, 'the canary to try for the free slot');
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(events).toEqual([]);
  expect(holder.status('claude')).toMatchObject({ ok: true, status: { active: 0 } });

  production.resume();
  ring(file);
  await until(() => production.check() && production.admitted(), 'the production run to be admitted');
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(events).toEqual([]);
  expect(holder.status('claude')).toMatchObject({ ok: true, status: { active: 1, reservations: [{ owner: 'production-later' }] } });

  production.finish();
  const decision = await deciding;
  expect(decision.decision).toBe('promote');
  expect(events).toEqual(['baseline ran', 'candidate ran']);
  // Every canary attempt took a slot through the ledger and gave it back.
  expect(holder.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 4 } });
  expect(waiting(file)).toEqual([]);
  expect(jumps(file)).toEqual([]);
}, 60_000);

test('a canary that never gets a slot blocks promotion without running the system', async () => {
  const file = path();
  const holder = open(file), evaluation = open(file);
  expect(holder.reserve('claude', 'production:busy').allowed).toBe(true);
  const events: string[] = [];
  const budget = canaryBudget(evaluation, { providerKey: 'claude', owner: 'counter:canary', maxWaitMs: 60 });
  const decision = await runPromotionGate(gate(events, budget));
  expect(decision.decision).toBe('block');
  expect(decision.blocks).toEqual([{ code: 'BASELINE_INCOMPLETE', planned: 1, completed: 0 }]);
  expect(events).toEqual([]);
  expect(holder.status('claude')).toMatchObject({ ok: true, status: { active: 1, launchesLastDay: 1 } });
});

/** Settles with the decision, or with `undefined` when the gate has not answered in time. */
function decided<T>(deciding: Promise<T>, withinMs = 5000): Promise<T | undefined> {
  return Promise.race([deciding, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), withinMs))]);
}

test('a verifier that never answers is cut off at the attempt deadline and its canary slot is given back', async () => {
  const file = path();
  const evaluation = open(file), production = open(file);
  const events: string[] = [];
  const budget = canaryBudget(evaluation, { providerKey: 'claude', owner: 'counter:canary', maxWaitMs: 200 });
  const verifiers = new PostconditionRegistry().register({ id: 'value written', version: '1', verify: () => new Promise<never>(() => {}) });

  const decision = await decided(runPromotionGate({ ...gate(events, budget), verifiers, timeoutMs: 300 }));
  expect(decision).toMatchObject({ decision: 'block', blocks: [{ code: 'BASELINE_INCOMPLETE', planned: 1, completed: 0 }] });
  expect(decision?.baseline?.report.attempts).toMatchObject([{ status: 'timed-out', failure: { phase: 'verification', code: 'DEADLINE_EXCEEDED' } }]);
  expect(events).toEqual(['baseline ran']);

  // The stuck check no longer holds the provider: production gets the slot at once.
  expect(production.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 1 } });
  expect(production.reserve('claude', 'production')).toMatchObject({ allowed: true });
});

test('a candidate whose verifier answers after the deadline is incomplete, and the late answer is ignored', async () => {
  const file = path();
  const evaluation = open(file), production = open(file);
  const events: string[] = [];
  const budget = canaryBudget(evaluation, { providerKey: 'claude', owner: 'counter:canary', maxWaitMs: 200 });
  let calls = 0;
  let lateAnswerLanded = false;
  const verifiers = new PostconditionRegistry().register({
    id: 'value written',
    version: '1',
    verify: ({ state }) => {
      calls += 1;
      if (calls === 1) return { status: 'verified', evidence: state };
      // The candidate's check ignores the signal and fails long after its attempt was cut off.
      return new Promise((_resolve, reject) => {
        setTimeout(() => { lateAnswerLanded = true; reject(new Error('late failure')); }, 1500);
      });
    },
  });

  const decision = await decided(runPromotionGate({ ...gate(events, budget), verifiers, timeoutMs: 300 }));
  expect(lateAnswerLanded).toBe(false);
  expect(decision).toMatchObject({ decision: 'block', blocks: [{ code: 'CANDIDATE_INCOMPLETE', planned: 1, completed: 0 }] });
  expect(decision?.candidate?.report.attempts).toMatchObject([{ status: 'timed-out', failure: { phase: 'verification', code: 'DEADLINE_EXCEEDED' } }]);
  expect(decision?.candidate?.attempts[0]?.postconditions).toEqual([]);
  expect(production.status('claude')).toMatchObject({ ok: true, status: { active: 0, launchesLastDay: 2 } });
  // Let the late rejection land: it must not surface as an unhandled error.
  await until(() => lateAnswerLanded, 'the late answer');
  await new Promise(resolve => setTimeout(resolve, 20));
});

test('a run that ignores the stop signal keeps its slot until it settles, because its work may still be alive', async () => {
  const file = path();
  const evaluation = open(file), production = open(file);
  const events: string[] = [];
  const budget = canaryBudget(evaluation, { providerKey: 'claude', owner: 'counter:canary', maxWaitMs: 200 });
  const options = gate(events, budget);
  let finish: (() => void) | undefined;
  const stubborn: PromotionSubject = {
    ...options.baseline as PromotionSubject,
    run: () => new Promise((resolve) => { finish = () => resolve({ state: { written: 7 } }); }),
  };

  const deciding = runPromotionGate({ ...options, baseline: stubborn, timeoutMs: 300 });
  expect(await decided(deciding, 1000)).toBeUndefined();
  expect(production.status('claude')).toMatchObject({ ok: true, status: { active: 1, reservations: [{ owner: 'counter:canary' }] } });

  finish!();
  const decision = await decided(deciding);
  expect(decision).toMatchObject({ decision: 'block', blocks: [{ code: 'BASELINE_INCOMPLETE', planned: 1, completed: 0 }] });
  expect(decision?.baseline?.report.attempts).toMatchObject([{ status: 'timed-out', failure: { phase: 'execution', code: 'DEADLINE_EXCEEDED' } }]);
  expect(production.status('claude')).toMatchObject({ ok: true, status: { active: 0 } });
});

test('canaryBudget refuses malformed options', () => {
  const ledger = open(path());
  expect(() => canaryBudget(ledger, { providerKey: '', owner: 'x', maxWaitMs: 10 })).toThrow(TypeError);
  expect(() => canaryBudget(ledger, { providerKey: 'claude', owner: 'x', maxWaitMs: -1 })).toThrow(TypeError);
  expect(() => canaryBudget(ledger, { providerKey: 'claude', owner: 'x', maxWaitMs: 10, priority: 'normal' } as never)).toThrow(TypeError);
  expect(() => canaryBudget({} as never, { providerKey: 'claude', owner: 'x', maxWaitMs: 10 })).toThrow(TypeError);
});
