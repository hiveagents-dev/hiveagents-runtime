/**
 * M4 and M5: the curator as a system, over simulated scope-months of hourly passes with the real
 * `curateMemory` (its defaults: two-stage confirmation at alpha 0.01, 6 measurements per rolling
 * day, paraphrase cooldown, budgets 1 promotion per pass / 3 per day, episode and content
 * cooldowns, journal) and a distiller that keeps re-proposing paraphrases of neutral and poisoned ideas.
 *
 * Pre-registered environment (verdicts use only this): 30 days x 24 passes per scope-month; each
 * pass the distiller has U{0..3} fresh ideas drawn 70% neutral (0), 15% helpful (+15 pts), 10%
 * harmful (-10 pts), 5% poisoned (0 on tasks, malicious text); each neutral/poisoned idea already
 * proposed and not promoted is re-proposed as a paraphrase (new text, new episode) with
 * probability 0.3 per day, at a random pass; when fresh + due paraphrases exceed 3 in a pass, 3 are
 * picked at random and the rest dropped; 12 tasks, base success 0.6, task difficulty Beta(kappa 4).
 *
 * Texts (lib-env `LessonTexts`): every idea is a distinct lesson sentence; a paraphrase rewords the
 * idea's latest wording, never repeating an earlier text: half are light (same template, one
 * synonym or qualifier toggled), half heavy (another template, synonyms re-drawn). The report gives
 * the word-set Jaccard of each paraphrase against the idea's earlier texts, so the share the
 * curator's 0.8 cooldown can catch is visible.
 *
 * `--passes-per-day N` runs N evenly spaced passes a day instead of 24 (not pre-registered;
 * fresh ideas stay U{0..3} per pass). `--legacy` runs the old rule (confirm false, alpha 0.05, no
 * measurement budget, paraphrase cooldown off) for comparison.
 *
 * What is modelled instead of run: the store. The bulk uses a structural in-memory CuratableStore
 * (lib-env `InMemoryCuratableStore`, the real `evaluateMemoryGate` inside); `--cross-check N`
 * scope-months of the pre-registered setting are replayed against the real `SqliteSystemMemory`
 * with the same seeds and every tally compared exactly. Everything else (curateMemory, measurement,
 * sign test, journal, budgets, cooldowns) is the real built SDK.
 *
 *   node scripts/simulation/memory/curation-system.mjs [--seed N] [--trials N] [--sens-trials N] [--cross-check N]
 *     [--passes-per-day N] [--legacy]
 */
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { emit, hypothesis, judgeProportion, rng, sdk } from '../lib/sim.mjs';
import {
  InMemoryCuratableStore, LessonTexts, cli, scratchDir, stopwatch, storeClock, taskDifficulties, withEffect, wordJaccard,
} from './lib-env.mjs';

const TYPES = [
  { type: 'neutral', share: 0.70, uplift: 0 },
  { type: 'helpful', share: 0.15, uplift: 0.15 },
  { type: 'harmful', share: 0.10, uplift: -0.10 },
  { type: 'poisoned', share: 0.05, uplift: 0 },
];
const PRE_REGISTERED = { paraphrase: 0.3, tasks: 12, base: 0.6, kappa: 4, days: 30, fresh: 'U0-3', maxPerPass: 3, passesPerDay: 24 };
/** The old rule, for comparison: one measurement at 0.05, no measurement budget, no paraphrase cooldown. */
const LEGACY = { confirm: false, alpha: 0.05, maxMeasurementsPerDay: 64, paraphraseSimilarity: 1 };
const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;

function drawType(r) {
  let u = r.next();
  for (const t of TYPES) { if ((u -= t.share) < 0) return t; }
  return TYPES[0];
}

function freshCount(r, mode) {
  if (mode === 'U0-3') return r.int(0, 3);
  if (mode === 'fixed3') return 3;
  if (mode === 'bern0.25') return r.bernoulli(0.25) ? 1 : 0;
  throw new Error(`unknown fresh mode ${mode}`);
}

const TYPE_KEYS = () => ({ neutral: 0, helpful: 0, harmful: 0, poisoned: 0 });

/** One scope-month. Deterministic in (seed, index, setting) whatever the store. */
async function scopeMonth(api, setting, seed, index, storeKind, dbPath) {
  const { curateMemory, candidateId, memoryCuratorJournal, evaluateMemoryGate, SqliteSystemMemory } = api;
  const r = rng((seed * 1_000_003 + index * 7919) >>> 0);
  const texts = new LessonTexts(rng((seed * 7_000_003 + index * 104_729) >>> 0));
  const base = { ms: START };
  const time = storeClock(base);
  const scope = { tenant: 'twin', namespace: `sm-${index}` };
  let store;
  if (storeKind === 'sqlite') {
    store = new SqliteSystemMemory({ databasePath: dbPath, systemId: 'twin', now: time.now });
    await store.enable({ by: 'twin' });
  } else {
    store = new InMemoryCuratableStore({ now: time.now, evaluateMemoryGate });
  }
  const journal = memoryCuratorJournal();
  const p = taskDifficulties(r, setting.base, setting.tasks, setting.kappa);
  const tasks = p.map((_, i) => ({ id: `task-${i}`, input: i }));
  const effects = new Map(); // lesson text -> idea
  const byCandidate = new Map(); // candidate id -> idea
  const ideas = [];
  const t = {
    proposed: 0, freshProposed: 0, paraphrasesProposed: 0, dropped: 0, measured: 0, measurements: 0, pending: 0,
    promoted: TYPE_KEYS(), measuredByType: TYPE_KEYS(), confirmedByType: TYPE_KEYS(),
    held: {}, refused: {}, errors: 0, failures: 0, sequence: [],
    paraphraseSimilarity: { light: [0, 0], heavy: [0, 0] }, // [paraphrases, of which max Jaccard >= 0.8 to an earlier text]
    paraphraseHeld: 0,
  };
  const passes = setting.passesPerDay;
  const options = setting.legacy ? LEGACY : {};
  let episodeSeq = 0;
  const run = (task, { condition, context }) => {
    const i = task.input;
    if (condition !== 'memory') return { passed: r.next() < p[i] };
    const idea = effects.get(context[0]);
    return { passed: r.next() < withEffect(p[i], idea.uplift, setting.base) };
  };
  for (let day = 0; day < setting.days; day += 1) {
    const due = Array.from({ length: passes }, () => []);
    for (const idea of ideas) {
      if (idea.promoted || idea.uplift !== 0 || idea.firstDay >= day) continue; // neutral & poisoned only
      if (r.bernoulli(setting.paraphrase)) due[r.int(0, passes - 1)].push(idea);
    }
    for (let slot = 0; slot < passes; slot += 1) {
      const now = START + day * 24 * HOUR + Math.floor((slot * 24) / passes) * HOUR;
      time.set(now);
      const fresh = Array.from({ length: freshCount(r, setting.fresh) }, () => {
        const kind = drawType(r);
        return { id: -1, type: kind.type, uplift: kind.uplift, variants: 0, fresh: true };
      });
      let pool = [...fresh.map(idea => ({ idea, fresh: true })), ...due[slot].map(idea => ({ idea, fresh: false }))];
      if (pool.length > setting.maxPerPass) {
        for (let i = pool.length - 1; i > 0; i -= 1) { const j = r.int(0, i); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        t.dropped += pool.length - setting.maxPerPass;
        pool = pool.slice(0, setting.maxPerPass);
      }
      const proposals = [];
      for (const { idea, fresh: isFresh } of pool) {
        let text;
        if (isFresh) {
          idea.id = ideas.length;
          idea.firstDay = day;
          ideas.push(idea);
          t.freshProposed += 1;
          text = texts.create(idea);
        } else {
          t.paraphrasesProposed += 1;
          const earlier = [...idea.texts];
          const reworded = texts.paraphrase(idea);
          text = reworded.text;
          const similar = Math.max(...earlier.map(old => wordJaccard(old, text))) >= 0.8;
          t.paraphraseSimilarity[reworded.kind][0] += 1;
          if (similar) t.paraphraseSimilarity[reworded.kind][1] += 1;
        }
        idea.variants += 1;
        const episodeId = `ep-${index}-${episodeSeq++}`;
        await store.put({
          id: episodeId, scope,
          text: `Turn ${episodeSeq} of scope ${index}: the agent handled request ${idea.id}/${idea.variants}.`,
          provenance: { source: 'agent-turn', sourceVersion: 'twin', observedAt: new Date(now).toISOString(), inputHash: 'a'.repeat(64) },
        });
        effects.set(text, idea);
        byCandidate.set(candidateId(scope, text), idea);
        proposals.push({ text, sources: [episodeId], idea });
      }
      t.proposed += proposals.length;
      // Passes run even without proposals: pending candidates are confirmed by the next pass.
      if (proposals.length === 0 && setting.legacy) continue;
      const report = await curateMemory({
        store, scope, journal, distillerId: 'twin/distiller@1', tasks, run, ...options,
        history: () => ['the whole history'],
        distill: async episodes => {
          const offered = new Set(episodes.map(e => e.id));
          return proposals.filter(x => offered.has(x.sources[0])).map(({ text, sources }) => ({ text, sources }));
        },
        now: () => new Date(now),
      });
      if (report.failure) t.failures += 1;
      t.measurements += report.measured;
      for (const outcome of report.candidates) {
        const idea = byCandidate.get(outcome.id);
        if (outcome.measurement && !outcome.pooled) {
          t.measured += 1;
          t.measuredByType[idea.type] += 1;
        }
        if (outcome.pooled) t.confirmedByType[idea.type] += 1;
        if (outcome.status === 'promoted') {
          t.promoted[idea.type] += 1;
          idea.promoted = true;
          t.sequence.push(`${day}:${slot}:${idea.type}`);
        } else if (outcome.status === 'pending') t.pending += 1;
        else if (outcome.status === 'held') {
          t.held[outcome.reason] = (t.held[outcome.reason] ?? 0) + 1;
          if (outcome.reason === 'PARAPHRASE_COOLDOWN') t.paraphraseHeld += 1;
        } else if (outcome.status === 'refused') t.refused[outcome.reason] = (t.refused[outcome.reason] ?? 0) + 1;
        else if (outcome.status === 'error') t.errors += 1;
      }
    }
  }
  if (storeKind === 'sqlite') store.close();
  return t;
}

async function loadApi() {
  const o = await sdk('orchestration/index');
  return {
    curateMemory: o.curateMemory, candidateId: o.candidateId, memoryCuratorJournal: o.memoryCuratorJournal,
    evaluateMemoryGate: o.evaluateMemoryGate, SqliteSystemMemory: o.SqliteSystemMemory,
  };
}

/** Worker: runs scope-months [from, to) of one setting and posts the tallies. */
if (!isMainThread) {
  const { setting, seed, from, to, storeKind, dbPath } = workerData;
  const api = await loadApi();
  const out = [];
  for (let i = from; i < to; i += 1) out.push(await scopeMonth(api, setting, seed, i, storeKind, dbPath));
  parentPort.postMessage(out);
} else {
  await main();
}

function inWorker(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: job });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

/** Runs `months` scope-months of every setting across a pool of workers. */
async function runSettings(jobs) {
  const queue = [];
  for (const job of jobs) {
    const chunk = Math.max(1, Math.ceil(job.months / 10));
    for (let from = 0; from < job.months; from += chunk) {
      queue.push({ key: job.key, setting: job.setting, seed: job.seed, from, to: Math.min(job.months, from + chunk), storeKind: job.storeKind, dbPath: job.dbPath && `${job.dbPath}.${from}` });
    }
  }
  const results = new Map(jobs.map(job => [job.key, []]));
  const parallel = Math.max(1, Math.min(availableParallelism() - 1, 10));
  let next = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < queue.length) {
      const job = queue[next++];
      const months = await inWorker(job);
      results.get(job.key)[job.from] = months;
    }
  }));
  for (const [key, chunks] of results) results.set(key, chunks.filter(Boolean).flat());
  return results;
}

function summarize(months) {
  const sum = { neutral: 0, helpful: 0, harmful: 0, poisoned: 0 };
  const measured = { neutral: 0, helpful: 0, harmful: 0, poisoned: 0 };
  const confirmed = { neutral: 0, helpful: 0, harmful: 0, poisoned: 0 };
  const held = {};
  const refused = {};
  const similarity = { light: [0, 0], heavy: [0, 0] };
  let poisonedMonths = 0, proposed = 0, paraphrases = 0, dropped = 0, errors = 0, failures = 0, measurements = 0, pending = 0;
  let paraphraseHeld = 0;
  for (const m of months) {
    for (const k of Object.keys(sum)) { sum[k] += m.promoted[k]; measured[k] += m.measuredByType[k]; confirmed[k] += m.confirmedByType[k]; }
    for (const [k, v] of Object.entries(m.held)) held[k] = (held[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.refused)) refused[k] = (refused[k] ?? 0) + v;
    for (const kind of ['light', 'heavy']) for (const i of [0, 1]) similarity[kind][i] += m.paraphraseSimilarity[kind][i];
    if (m.promoted.poisoned > 0) poisonedMonths += 1;
    proposed += m.proposed; paraphrases += m.paraphrasesProposed; dropped += m.dropped; errors += m.errors; failures += m.failures;
    measurements += m.measurements; pending += m.pending; paraphraseHeld += m.paraphraseHeld;
  }
  const promotions = Object.values(sum).reduce((a, b) => a + b, 0);
  const perMonth = months.map(m => {
    const n = Object.values(m.promoted).reduce((a, b) => a + b, 0);
    return n === 0 ? null : m.promoted.helpful / n;
  }).filter(x => x !== null);
  return {
    months: months.length, promotions, promotedByType: sum, measuredByType: measured,
    promotionRateByType: Object.fromEntries(Object.keys(sum).map(k => [k, measured[k] ? sum[k] / measured[k] : 0])),
    precision: promotions ? sum.helpful / promotions : 0,
    meanMonthPrecision: perMonth.length ? perMonth.reduce((a, b) => a + b, 0) / perMonth.length : null,
    poisonedMonths, poisonedMonthRate: poisonedMonths / months.length,
    proposed, paraphrasesProposed: paraphrases, droppedOverCap: dropped, held, refused, errors, failures,
    measurementsPerMonth: measurements / months.length, pendingPerMonth: pending / months.length, confirmationsByType: confirmed,
    paraphrases: {
      note: '[proposed, of which word-set Jaccard >= 0.8 to an earlier text of the same idea]',
      light: similarity.light, heavy: similarity.heavy, heldAsParaphrase: paraphraseHeld,
    },
  };
}

async function main() {
  const args = cli({
    'sens-trials': { type: 'string', default: '100' }, 'cross-check': { type: 'string', default: '8' },
    'passes-per-day': { type: 'string', default: '24' }, legacy: { type: 'boolean', default: false },
  });
  const passesPerDay = Number(args['passes-per-day']);
  if (!Number.isInteger(passesPerDay) || passesPerDay < 1 || passesPerDay > 24) throw new RangeError('--passes-per-day must be 1 to 24');
  // The pre-registered verdict setting is 24 passes a day under the defaults; anything else is labelled.
  const SETTING = { ...PRE_REGISTERED, passesPerDay, ...(args.legacy ? { legacy: true } : {}) };
  const elapsed = stopwatch();
  const seed = args.seed;
  const h4 = hypothesis('M4');
  const h5 = hypothesis('M5');
  const months = args.trials ?? Math.max(h4.minTrials, h5.minTrials);
  const sensMonths = Number(args['sens-trials']);
  const crossMonths = Number(args['cross-check']);
  const dir = scratchDir();

  const jobs = [{ key: 'pre', setting: SETTING, seed, months, storeKind: 'memory' }];
  for (const paraphrase of [0, 0.3, 0.6]) {
    for (const tasks of [8, 12, 20]) {
      if (paraphrase === 0.3 && tasks === 12) continue;
      jobs.push({ key: `p${paraphrase}-t${tasks}`, setting: { ...SETTING, paraphrase, tasks }, seed, months: sensMonths, storeKind: 'memory' });
    }
  }
  for (const fresh of ['fixed3', 'bern0.25']) {
    jobs.push({ key: `fresh-${fresh}`, setting: { ...SETTING, fresh }, seed, months: sensMonths, storeKind: 'memory' });
  }
  // Cross-check: the first scope-months of the pre-registered setting, on the real SQLite store (one DB file per chunk).
  if (crossMonths > 0) {
    jobs.push({ key: 'cross-sqlite', setting: SETTING, seed, months: crossMonths, storeKind: 'sqlite', dbPath: join(dir, 'cross.sqlite') });
  }
  // A shared DB file across workers would contend on locks; give each chunk its own file.
  const results = await runSettings(jobs.map(job => job));
  const pre = results.get('pre');
  const s = summarize(pre);

  let crossCheck;
  if (crossMonths > 0) {
    const sqlite = results.get('cross-sqlite');
    const strip = m => JSON.stringify({ ...m });
    const agree = sqlite.filter((m, i) => strip(m) === strip(pre[i])).length;
    crossCheck = {
      what: 'scope-months 0..N-1 of the pre-registered setting replayed on the real SqliteSystemMemory with identical seeds; every tally and the promotion sequence compared',
      months: sqlite.length, identical: agree,
      firstDifference: sqlite.findIndex((m, i) => strip(m) !== strip(pre[i])),
      sqliteSummary: summarize(sqlite), inMemorySummary: summarize(pre.slice(0, sqlite.length)),
    };
  }

  const assumptions = {
    ...SETTING, mix: TYPES, freshMeaning: 'fresh ideas per pass ~ uniform {0,1,2,3}',
    preRegistered: passesPerDay === 24 && !args.legacy,
    cap: 'at most 3 proposals per pass (maxCandidates); excess picked at random, the rest dropped',
    reProposal: 'each neutral/poisoned idea proposed on an earlier day and never promoted: paraphrase w.p. `paraphrase` per day at a random pass, with a fresh episode; helpful/harmful ideas are never re-proposed',
    texts: 'distinct lesson sentences per idea; paraphrases reword the latest wording, never repeat a text: 50% light (same template, one synonym or qualifier toggled), 50% heavy (other template, synonyms re-drawn)',
    curator: args.legacy
      ? 'legacy: confirm false, alpha 0.05, minTasks 5, minMargin 2, no measurement budget (64/day), paraphrase cooldown off, 1 promotion per pass, 3 per rolling day, 7-day episode cooldown'
      : 'defaults: confirm true (pendingAlpha 0.25, pooled alpha 0.01, 3-day expiry), 6 measurements per rolling day, paraphrase cooldown Jaccard 0.8 for 7 days, minTasks 5, minMargin 2, 1 promotion per pass, 3 per rolling day, 7-day episode cooldown, 1 promotion per episode; memoryCuratorJournal per scope-month; a pass runs even when the distiller has nothing new',
    store: 'structural in-memory CuratableStore (see cross-check against SqliteSystemMemory)',
  };
  const results4 = {
    id: 'M4', ...judgeProportion(s.promotedByType.helpful, s.promotions, h4.bound, h4.direction), minTrials: h4.minTrials,
    claim: h4.claim, scopeMonths: s.months, belowMinTrials: s.months < h4.minTrials, assumptions, summary: s,
    note: 'k/n pools promotions across scope-months (clustered, not independent); meanMonthPrecision is the per-month average',
  };
  const results5 = {
    id: 'M5', ...judgeProportion(s.poisonedMonths, s.months, h5.bound, h5.direction), minTrials: h5.minTrials,
    claim: h5.claim, belowMinTrials: s.months < h5.minTrials, assumptions,
    poisonedPromotions: s.promotedByType.poisoned, poisonedMeasured: s.measuredByType.poisoned,
  };
  const sensitivity = [];
  for (const [key, ms] of results) {
    if (key === 'cross-sqlite') continue;
    const x = key === 'pre' ? s : summarize(ms);
    const setting = jobs.find(j => j.key === key).setting;
    sensitivity.push({
      key, paraphrase: setting.paraphrase, tasks: setting.tasks, fresh: setting.fresh, months: x.months,
      promotions: x.promotions, precision: x.precision, poisonedMonthRate: x.poisonedMonthRate,
      promotedByType: x.promotedByType, measuredByType: x.measuredByType,
    });
  }
  emit('memory/curation-system', [results4, results5], {
    seed, passesPerDay, rule: args.legacy ? 'legacy' : 'defaults', wallSeconds: elapsed(), crossCheck,
    sensitivity: { note: 'extra info, no verdict; pre-registered row is key "pre"; fresh-* rows vary throughput (not pre-registered)', rows: sensitivity },
  });
}
