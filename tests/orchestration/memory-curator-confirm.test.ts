import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidateId, curateMemory, memoryCuratorJournal } from '../../src/orchestration/memory/curator.js';
import type { CuratableStore, CurateMemoryOptions, CuratorJournal } from '../../src/orchestration/memory/curator.js';
import { candidateJournalKey } from '../../src/orchestration/memory/curator-journal.js';
import { measurementBudgetJournalKey, pendingJournalKey } from '../../src/orchestration/memory/curator-ledger.js';
import type { MemoryRunContext } from '../../src/orchestration/memory/index.js';
import { episode, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

/**
 * The default acceptance: alpha 0.01, two-stage confirmation on pooled evidence, and a rolling
 * measurement budget per scope (the simulation study behind them: low power, poor system precision).
 */

let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

const scope = scopeOf('grow');
const HELPFUL = 'Invoices for this client are issued in pesos, helpful.';
const tasks = (count: number) => Array.from({ length: count }, (_, n) => ({ id: `t${n + 1}`, input: `task ${n + 1}` }));
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Memory passes every task while `helps()` and its context holds `helpful`; no memory never passes. */
function runner(helps: () => boolean = () => true) {
  const runs = { n: 0 };
  const run = (_task: unknown, { condition, context }: MemoryRunContext) => {
    runs.n += 1;
    if (condition === 'full-history') return { passed: true };
    return { passed: condition === 'memory' && helps() && context.some(text => text.includes('helpful')) };
  };
  return { runs, run };
}

async function seeded(count = 3) {
  const store = workspace.open('grow');
  await store.enable({ by: 'operator' });
  for (let n = 1; n <= count; n += 1) await store.put(episode('grow', `e${n}`, `Episode ${n}: the client paid in pesos.`));
  return store;
}

async function seededTenant(tenant: string) {
  const store = workspace.open(tenant);
  await store.enable({ by: 'operator' });
  for (let n = 1; n <= 3; n += 1) await store.put(episode(tenant, `e${n}`, `Episode ${n}: the client paid in pesos.`));
  return store;
}

function harness(store: CuratableStore, start = Date.parse('2026-11-15T12:00:00.000Z')) {
  const clock = { ms: start };
  const journal = memoryCuratorJournal();
  const pass = (extra: Partial<CurateMemoryOptions> = {}) => curateMemory({
    store, scope, journal, distillerId: 'd1', tasks: tasks(5), history: () => [], run: runner().run,
    distill: async () => [{ text: HELPFUL, sources: ['e1'] }], now: () => new Date(clock.ms), ...extra,
  });
  return { clock, journal, pass };
}

describe('the default acceptance rule', () => {
  it('is two-stage at alpha 0.01 and reports what the task set can detect', async () => {
    const store = await seeded();
    const { pass } = harness(store);
    const report = await pass();
    expect(report.acceptance).toEqual({ tasks: 5, alpha: 0.01, minMargin: 2, confirm: true, pendingAlpha: 0.25, minWins: 7, possible: true });
    expect(report.candidates[0]!.status).toBe('pending');
  });

  it('refuses unmeasured, as INSUFFICIENT_EVIDENCE, when even a clean sweep could not pass alpha', async () => {
    const store = await seeded();
    const { pass } = harness(store);
    const { runs, run } = runner();
    // Single-stage at 0.01: 5 tasks can give at best P = 1/32.
    const short = await pass({ confirm: false, run });
    expect(short.acceptance).toMatchObject({ minWins: 7, possible: false, confirm: false });
    expect(short.candidates).toEqual([{ id: candidateId(scope, HELPFUL), status: 'refused', reason: 'INSUFFICIENT_EVIDENCE' }]);
    expect(runs.n).toBe(0);
    // Seven tasks: a clean 7-0 gives P = 1/128 and promotes on one measurement.
    const seven = await pass({ confirm: false, tasks: tasks(7) });
    expect(seven.candidates[0]).toMatchObject({ status: 'promoted', measurement: { pValue: 1 / 128 } });
  });
});

describe('two-stage confirmation', () => {
  it('journals a first pass as pending, then promotes it on the pooled evidence of a later pass', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    const first = await pass();
    expect(first.candidates).toEqual([expect.objectContaining({
      id, status: 'pending', until: new Date(clock.ms + 3 * DAY).toISOString(),
      measurement: expect.objectContaining({ discordant: { memoryOnly: 5, noMemoryOnly: 0 }, pValue: 1 / 32 }),
    })]);
    expect(first).toMatchObject({ pending: 1, promoted: 0, measured: 1 });
    expect((await store.list({ scope })).find(view => view.record.id === id)!.state).toBe('episode');
    expect(await journal.get(candidateJournalKey(id))).toMatchObject({
      outcome: 'pending', tally: { discordant: { memoryOnly: 5, noMemoryOnly: 0 }, memory: { passed: 5, total: 5 } },
    });
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([id]);

    clock.ms += HOUR;
    // The distiller has nothing new: the pending candidate is measured again anyway.
    const second = await pass({ distill: async () => [] });
    expect(second.candidates).toEqual([expect.objectContaining({
      id, status: 'promoted',
      pooled: expect.objectContaining({ measurements: 2, tasks: 10, discordant: { memoryOnly: 10, noMemoryOnly: 0 }, pValue: 1 / 1024 }),
    })]);
    const lesson = (await store.list({ scope })).find(view => view.record.id === id)!;
    expect(lesson.state).toBe('lesson');
    // The store holds the pooled evidence: both measurements' tallies, one candidate.
    expect(lesson.promotion!.gate).toMatchObject({
      noMemory: { passed: 0, total: 10 }, memory: { passed: 10, total: 10 }, candidateDigests: [lesson.contentDigest],
    });
    expect(lesson.promotion!.gate.measurementId).toMatch(/-pooled$/);
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([]);
  });

  it('refuses on the pooled evidence when the second measurement does not bear the first out', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    let helps = true;
    const { run } = runner(() => helps);
    expect((await pass({ run })).candidates[0]!.status).toBe('pending');
    clock.ms += HOUR;
    helps = false;
    const second = await pass({ run, distill: async () => [] });
    // 5-0 then 0-0: pooled P = 1/32, above 0.01.
    expect(second.candidates[0]).toMatchObject({
      id, status: 'refused', reason: 'NOT_SIGNIFICANT', pooled: { discordant: { memoryOnly: 5, noMemoryOnly: 0 }, pValue: 1 / 32 },
    });
    expect(await journal.get(candidateJournalKey(id))).toMatchObject({ outcome: 'refused', reason: 'NOT_SIGNIFICANT' });
    expect((await store.list({ scope })).every(view => view.state === 'episode')).toBe(true);
    // Decided: proposed again it is held, not measured a third time.
    clock.ms += HOUR;
    const again = await pass({ run, distill: async () => [{ text: HELPFUL, sources: ['e2'] }] });
    expect(again.candidates).toEqual([{ id, status: 'held', reason: 'REFUSED_EARLIER' }]);
  });

  it('refuses a strong first measurement that a reversed second one cancels out', async () => {
    const store = await seeded();
    const { clock, pass } = harness(store);
    let round = 0;
    const run = (_task: unknown, { condition }: MemoryRunContext) => {
      if (condition === 'full-history') return { passed: true };
      return { passed: round === 0 ? condition === 'memory' : condition === 'no-memory' };
    };
    expect((await pass({ run, tasks: tasks(7) })).candidates[0]).toMatchObject({ status: 'pending', measurement: { pValue: 1 / 128 } });
    clock.ms += HOUR;
    round = 1;
    const second = await pass({ run, tasks: tasks(7), distill: async () => [] });
    expect(second.candidates[0]).toMatchObject({ status: 'refused', reason: 'NO_GAIN_OVER_NO_MEMORY', pooled: { discordant: { memoryOnly: 7, noMemoryOnly: 7 } } });
  });

  it('expires a pending candidate not confirmed within confirmWithinMs, unmeasured', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    await pass();
    clock.ms += 3 * DAY;
    const { runs, run } = runner();
    const late = await pass({ run, distill: async () => [] });
    expect(late.candidates).toEqual([{ id, status: 'refused', reason: 'CONFIRMATION_EXPIRED' }]);
    expect(runs.n).toBe(0);
    expect(await journal.get(candidateJournalKey(id))).toMatchObject({ outcome: 'refused', reason: 'CONFIRMATION_EXPIRED' });
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([]);
    const brief = workspace.open('brief');
    await brief.enable({ by: 'operator' });
    await brief.put(episode('brief', 'e1', 'The client paid in pesos.'));
    const shorter = harness(brief);
    const briefScope = scopeOf('brief');
    const briefPass = (extra: Partial<CurateMemoryOptions>) => shorter.pass({ scope: briefScope, confirmWithinMs: HOUR, ...extra });
    expect((await briefPass({})).candidates[0]).toMatchObject({ status: 'pending' });
    shorter.clock.ms += HOUR;
    expect((await briefPass({ distill: async () => [] })).candidates[0]).toMatchObject({ reason: 'CONFIRMATION_EXPIRED' });
  });

  it('measures pending candidates before new ones, and holds a pending one proposed again', async () => {
    const store = await seeded();
    const { clock, pass } = harness(store);
    await pass();
    clock.ms += HOUR;
    const other = `${HELPFUL} Rounded to whole pesos.`;
    const second = await pass({
      maxMeasurementsPerDay: 2, distill: async () => [{ text: other, sources: ['e3'] }],
    });
    // The confirmation came first, took the day's second measurement and the pass's promotion.
    expect(second.candidates.map(outcome => [outcome.id, outcome.status === 'held' ? outcome.reason : outcome.status])).toEqual([
      [candidateId(scope, HELPFUL), 'promoted'],
      [candidateId(scope, other), 'PROMOTION_BUDGET'],
    ]);
    clock.ms += HOUR;
    const third = await pass({ maxMeasurementsPerDay: 2, distill: async () => [{ text: other, sources: ['e3'] }] });
    expect(third.candidates[0]).toMatchObject({ status: 'held', reason: 'MEASUREMENT_BUDGET' });
  });

  it('holds a candidate proposed again while it is pending', async () => {
    const store = await seeded();
    const { pass } = harness(store);
    const { runs, run } = runner();
    // Same pass budget: the pending candidate is not measured twice in one pass, nor as a new candidate.
    await pass({ run, episodeCooldownMs: 0 });
    const measuredRuns = runs.n;
    const report = await pass({ run, episodeCooldownMs: 0, maxMeasurementsPerDay: 1 });
    expect(report.candidates.map(outcome => (outcome.status === 'held' ? outcome.reason : outcome.status)))
      .toEqual(['MEASUREMENT_BUDGET', 'PENDING']);
    expect(runs.n).toBe(measuredRuns);
  });

  it('keeps a lesson with no effect at most alpha, pooled over both measurements', async () => {
    const store = workspace.open('grow');
    await store.enable({ by: 'operator' });
    let seed = 99;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let measured = 0;
    let pending = 0;
    let promoted = 0;
    for (let n = 0; n < 200; n += 1) {
      const local = scopeOf('grow', `null${n}`);
      await store.put({ ...episode('grow', `e${n}`, `Turn ${n}: an unrelated remark.`), scope: local });
      const journal = memoryCuratorJournal();
      const options = {
        store, scope: local, distillerId: 'd1', tasks: tasks(10), journal, history: () => [],
        run: () => ({ passed: random() < 0.5 }), now: () => new Date(Date.parse('2026-11-15T12:00:00.000Z') + n * DAY),
      };
      const first = await curateMemory({ ...options, distill: async () => [{ text: `Unrelated note ${n}.`, sources: [`e${n}`] }] });
      const second = await curateMemory({ ...options, distill: async () => [] });
      measured += first.measured;
      pending += first.pending;
      promoted += first.promoted + second.promoted;
    }
    expect(measured).toBe(200);
    // About a sixth earns a second measurement; promotions stay within alpha of the measured candidates.
    expect(pending).toBeGreaterThan(10);
    expect(promoted / measured).toBeLessThanOrEqual(0.01);
  }, 60_000);
});

describe('confirmation edge cases (review)', () => {
  it('confirms a pooled result of more than 1024 discordant tasks instead of failing every pass', async () => {
    const store = await seeded(1);
    const { clock, pass } = harness(store);
    const first = await pass({ tasks: tasks(600) });
    expect(first.candidates[0]).toMatchObject({ status: 'pending', measurement: { discordant: { memoryOnly: 600, noMemoryOnly: 0 } } });
    clock.ms += HOUR;
    const second = await pass({ tasks: tasks(600), distill: async () => [] });
    expect(second.failure).toBeUndefined();
    expect(second.candidates[0]).toMatchObject({ status: 'promoted', pooled: { discordant: { memoryOnly: 1200, noMemoryOnly: 0 }, pValue: 0 } });
  }, 60_000);

  it('recovers when the pending list cannot be written: nothing is left pending off the list', async () => {
    const store = await seeded();
    const inner = memoryCuratorJournal();
    let fail = true;
    const journal: CuratorJournal = {
      get: key => inner.get(key),
      async set(key, entry) {
        if (fail && key === pendingJournalKey(scope)) {
          fail = false;
          throw Object.assign(new Error('locked'), { code: 'JOURNAL_LOCKED' });
        }
        return inner.set(key, entry);
      },
    };
    const { clock, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    expect((await pass({ journal })).failure).toEqual({ stage: 'journal', error: 'JOURNAL_LOCKED' });
    expect(await inner.get(candidateJournalKey(id))).toBeUndefined();
    clock.ms += 10 * DAY;
    // Not stranded: measured afresh, pending on the list, then confirmed.
    expect((await pass({ journal, distill: async () => [{ text: HELPFUL, sources: ['e2'] }] })).candidates[0]!.status).toBe('pending');
    clock.ms += HOUR;
    expect((await pass({ journal, distill: async () => [] })).candidates[0]!.status).toBe('promoted');
  });

  it('puts a live pending entry found off the list back on it, and expires a lapsed one at once', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    await pass({ episodeCooldownMs: 0 });
    // As a lost list entry leaves it: the candidate pending, the list without it.
    await journal.set(pendingJournalKey(scope), { outcome: 'pending', at: new Date(clock.ms).toISOString(), pending: [] });
    clock.ms += HOUR;
    const held = await pass({ episodeCooldownMs: 0, distill: async () => [{ text: HELPFUL, sources: ['e2'] }] });
    expect(held.candidates).toEqual([{ id, status: 'held', reason: 'PENDING' }]);
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([id]);
    clock.ms += HOUR;
    expect((await pass({ distill: async () => [] })).candidates[0]).toMatchObject({ id, status: 'promoted' });

    const late = harness(await seededTenant('late'));
    const lateScope = scopeOf('late');
    const lateId = candidateId(lateScope, HELPFUL);
    await late.pass({ scope: lateScope });
    await late.journal.set(pendingJournalKey(lateScope), { outcome: 'pending', at: new Date(late.clock.ms).toISOString(), pending: [] });
    late.clock.ms += 10 * DAY;
    const lapsed = await late.pass({ scope: lateScope, distill: async () => [{ text: HELPFUL, sources: ['e2'] }] });
    expect(lapsed.candidates).toEqual([{ id: lateId, status: 'held', reason: 'REFUSED_EARLIER' }]);
    expect(await late.journal.get(candidateJournalKey(lateId))).toMatchObject({ outcome: 'refused', reason: 'CONFIRMATION_EXPIRED' });
  });

  it('never drops a pending id to make room: an orphan meeting a full list is held, and every listed one expires', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const at = new Date(clock.ms).toISOString();
    const until = new Date(clock.ms + 2 * DAY).toISOString();
    const tally = {
      digest: 'a'.repeat(64), contentDigest: 'b'.repeat(64), noMemory: { passed: 0, total: 5 }, memory: { passed: 5, total: 5 },
      fullHistory: { passed: 5, total: 5 }, discordant: { memoryOnly: 5, noMemoryOnly: 0 },
    };
    const fakes = Array.from({ length: 16 }, (_, n) => `curator-fake${n}`);
    for (const fake of fakes) await journal.set(candidateJournalKey(fake), { outcome: 'pending', at, pendingUntil: until, tally });
    await journal.set(pendingJournalKey(scope), { outcome: 'pending', at, pending: fakes });
    const id = candidateId(scope, HELPFUL);
    await journal.set(candidateJournalKey(id), { outcome: 'pending', at, pendingUntil: until, tally });
    const first = await pass();
    expect(first.candidates.at(-1)).toEqual({ id, status: 'held', reason: 'PENDING_LIMIT' });
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual(fakes);
    clock.ms += 5 * DAY;
    const later = await pass({ distill: async () => [] });
    expect(later.candidates.filter(c => c.status === 'refused').map(c => c.id)).toEqual(fakes);
    for (const fake of fakes) expect((await journal.get(candidateJournalKey(fake)))?.outcome).toBe('refused');
  });

  it('refuses to pool when the task count changed, unmeasured, and expires a pending entry that lost its tally', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    const { runs, run } = runner();
    await pass({ run });
    clock.ms += HOUR;
    const before = runs.n;
    const changed = await pass({ run, tasks: tasks(6), distill: async () => [] });
    expect(changed.candidates).toEqual([{ id, status: 'refused', reason: 'TASKS_CHANGED' }]);
    expect(runs.n).toBe(before);
    expect(await journal.get(candidateJournalKey(id))).toMatchObject({ outcome: 'refused', reason: 'TASKS_CHANGED' });

    const at = new Date(clock.ms).toISOString();
    await journal.set(candidateJournalKey('curator-bare'), { outcome: 'pending', at });
    await journal.set(pendingJournalKey(scope), { outcome: 'pending', at, pending: ['curator-bare'] });
    const bare = await pass({ run, distill: async () => [] });
    expect(bare.candidates).toEqual([{ id: 'curator-bare', status: 'refused', reason: 'CONFIRMATION_EXPIRED' }]);
  });

  it('fails closed on an inconsistent pending tally, from any journal: never pooled (review C5)', async () => {
    const store = await seeded();
    const { clock, pass } = harness(store);
    const NEUTRAL = 'Invoices for this client are issued in pesos.';
    const id = candidateId(scope, NEUTRAL);
    await pass({ distill: async () => [{ text: NEUTRAL, sources: ['e1'] }] });
    const view = (await store.list({ scope })).find(listed => listed.record.id === id)!;
    const at = new Date(clock.ms).toISOString();
    // 20 discordant tasks out of 5, with 5 passed under memory: no measurement produces that.
    const forged = {
      outcome: 'pending', at, pendingUntil: new Date(clock.ms + DAY).toISOString(),
      tally: {
        digest: 'a'.repeat(64), contentDigest: view.contentDigest, noMemory: { passed: 0, total: 5 }, memory: { passed: 5, total: 5 },
        fullHistory: { passed: 5, total: 5 }, discordant: { memoryOnly: 20, noMemoryOnly: 0 },
      },
    };
    await expect(memoryCuratorJournal().set(candidateJournalKey(id), forged as never)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' });
    // An application journal that stores anything: the curator checks what it reads back.
    const raw = new Map<string, unknown>([[candidateJournalKey(id), forged], [pendingJournalKey(scope), { outcome: 'pending', at, pending: [id] }]]);
    const loose: CuratorJournal = { get: async key => raw.get(key) as never, set: async (key, entry) => { raw.set(key, entry); } };
    clock.ms += HOUR;
    const report = await pass({ journal: loose, distill: async () => [] });
    expect(report.failure).toEqual({ stage: 'journal', error: 'JOURNAL_INVALID' });
    expect(report.promoted).toBe(0);
    expect((await store.list({ scope })).every(listed => listed.state === 'episode')).toBe(true);
  });
});

describe('the measurement budget', () => {

  it('does not measure again a lesson this pass confirmed, nor turn its entry back to pending', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    const { runs, run } = runner();
    await pass({ run, maxPromotionsPerPass: 2 });
    clock.ms += HOUR;
    const before = runs.n;
    const second = await pass({ run, maxPromotionsPerPass: 2, distill: async () => [{ text: HELPFUL, sources: ['e2'] }] });
    expect(second.candidates).toEqual([
      expect.objectContaining({ id, status: 'promoted' }),
      { id, status: 'existing', state: 'lesson' },
    ]);
    expect(second.measured).toBe(1);
    expect(runs.n - before).toBe(15);
    expect(await journal.get(candidateJournalKey(id))).toMatchObject({ outcome: 'promoted' });
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([]);
  });

  it('asks the current screen before confirming: a refusal is final, a failure leaves it pending', async () => {
    const store = await seeded();
    const { clock, journal, pass } = harness(store);
    const id = candidateId(scope, HELPFUL);
    const { runs, run } = runner();
    await pass({ run });
    clock.ms += HOUR;
    const before = runs.n;
    const failing = await pass({ run, distill: async () => [], screen: async () => { throw Object.assign(new Error('x'), { code: 'SCREEN_DOWN' }); } });
    expect(failing.candidates).toEqual([{ id, status: 'error', stage: 'screen', error: 'SCREEN_DOWN' }]);
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([id]);
    const asked: string[] = [];
    const refusing = await pass({
      run, distill: async () => [], screen: async candidate => { asked.push(candidate.id); return { allow: false, reason: 'INSTRUCTION_OVERRIDE' }; },
    });
    expect(refusing.candidates).toEqual([{ id, status: 'refused', reason: 'SCREENED', screen: 'INSTRUCTION_OVERRIDE' }]);
    expect(asked).toEqual([id]);
    expect(runs.n).toBe(before);
    expect(refusing.measured).toBe(0);
    expect(await journal.get(candidateJournalKey(id))).toMatchObject({ outcome: 'refused', reason: 'SCREENED' });
    expect((await journal.get(pendingJournalKey(scope)))?.pending).toEqual([]);
    expect((await store.list({ scope })).every(view => view.state === 'episode')).toBe(true);
  });
});

describe('the measurement budget', () => {
  async function budgeted() {
    const store = await seeded(6);
    const { clock, journal, pass } = harness(store);
    const { runs, run } = runner(() => false);
    const lessons = ['Weather is mild.', 'Tuesdays are slow.', 'The office has plants.', 'Coffee is free.', 'Parking is far.'];
    const at = (n: number) => pass({
      run, confirm: false, alpha: 0.05, maxMeasurementsPerDay: 2, distill: async () => [{ text: lessons[n]!, sources: [`e${n + 1}`] }],
    });
    return { clock, journal, runs, at };
  }

  it('reserves every measurement in the journal and holds candidates past the rolling day budget', async () => {
    const { clock, journal, runs, at } = await budgeted();
    const statuses: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const report = await at(n);
      statuses.push(report.candidates[0]!.status === 'held' ? (report.candidates[0] as { reason: string }).reason : report.candidates[0]!.status);
      clock.ms += HOUR;
    }
    expect(statuses).toEqual(['refused', 'refused', 'MEASUREMENT_BUDGET']);
    expect(runs.n).toBe(2 * 15);
    expect((await journal.get(measurementBudgetJournalKey(scope)))?.measuredAt).toHaveLength(2);
    // A day after the first measurement one slot is free again.
    clock.ms = Date.parse('2026-11-15T12:00:00.000Z') + DAY + 1;
    expect((await at(2)).measured).toBe(1);
    expect((await at(3)).candidates[0]).toMatchObject({ status: 'held', reason: 'MEASUREMENT_BUDGET' });
  });

  it('counts measurements whatever their outcome, and a failed reservation stops the pass unmeasured', async () => {
    const store = await seeded();
    const inner = memoryCuratorJournal();
    const failing: CuratorJournal = {
      get: key => inner.get(key),
      async set(key, entry) {
        if (key.startsWith('measurements:')) throw Object.assign(new Error('x'), { code: 'JOURNAL_LOCKED' });
        return inner.set(key, entry);
      },
    };
    const { runs, run } = runner();
    const report = await curateMemory({
      store, scope, journal: failing, distillerId: 'd1', tasks: tasks(5), history: () => [], run,
      distill: async () => [{ text: HELPFUL, sources: ['e1'] }],
    });
    expect(report.candidates).toEqual([{ id: candidateId(scope, HELPFUL), status: 'error', stage: 'journal', error: 'JOURNAL_LOCKED' }]);
    expect(report.failure).toEqual({ stage: 'journal', error: 'JOURNAL_LOCKED' });
    expect(runs.n).toBe(0);
  });
});

describe('options', () => {
  it('refuses invalid confirmation, budget and screen options', async () => {
    const store = await seeded();
    const { pass } = harness(store);
    await expect(pass({ confirm: 'yes' as never })).rejects.toThrow(TypeError);
    await expect(pass({ pendingAlpha: 0.005 })).rejects.toThrow(RangeError);
    await expect(pass({ alpha: 0.3, pendingAlpha: 0.3 })).resolves.toMatchObject({ acceptance: { pendingAlpha: 0.3 } });
    await expect(pass({ pendingAlpha: 0.6 })).rejects.toThrow(RangeError);
    await expect(pass({ confirmWithinMs: 0 })).rejects.toThrow(RangeError);
    await expect(pass({ maxMeasurementsPerDay: 0 })).rejects.toThrow(RangeError);
    await expect(pass({ maxMeasurementsPerDay: 65 })).rejects.toThrow(RangeError);
    await expect(pass({ paraphraseSimilarity: 0.4 })).rejects.toThrow(RangeError);
    await expect(pass({ screen: 'strict' as never })).rejects.toThrow(TypeError);
    const journal = memoryCuratorJournal();
    await expect(pass({ journal: { get: journal.get, set: journal.set, update: true } as never })).rejects.toThrow(TypeError);
  });
});
