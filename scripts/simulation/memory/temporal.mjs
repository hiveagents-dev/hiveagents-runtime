/**
 * M6: supersedes / validUntil against the real SQLite store. A stream of fact updates (each new
 * version supersedes the live lesson of its fact, some carry a validUntil, some already expired),
 * with adversarial events: two concurrent updates superseding the same lesson, late promotion of a
 * stale pending update, never-promoted episodes that name live lessons, supersedes naming another
 * scope's id or a rolled-back lesson, rollbacks, and clocks/validUntil written with UTC offsets.
 *
 * After every step, random facts are recalled through three surfaces: the writer handle's
 * `query`, a second connection's `query`, and `memoryProviderFromPorts(...).recall` (the agent's
 * path). Every returned record is checked against an independent model of the store: a
 * superseded (invalidated) or expired record returned is an M6 violation. The model also predicts
 * every promotion's outcome; disagreements are reported separately.
 *
 *   node scripts/simulation/memory/temporal.mjs [--seed N] [--trials N] [--streams N]
 */
import { join } from 'node:path';
import { emit, hypothesis, judgeInvariant, rng, sdk } from '../lib/sim.mjs';
import { cli, scratchDir, stopwatch } from './lib-env.mjs';

const args = cli({ streams: { type: 'string', default: '4' } });
const elapsed = stopwatch();
const h = hypothesis('M6');
const steps = args.trials ?? 4000;
const streams = Number(args.streams);
const { SqliteSystemMemory, memoryProviderFromPorts } = await sdk('orchestration/index');
const dir = scratchDir();
const FACTS = 25;
const ATTRS = ['billing currency', 'support tier', 'region', 'contact email', 'renewal date'];
const HOUR = 3_600_000;
const GATE = digest => ({
  measurementId: 'twin-measurement', digest: 'b'.repeat(64), candidateDigests: [digest],
  noMemory: { passed: 1, total: 4 }, memory: { passed: 3, total: 4 }, fullHistory: { passed: 3, total: 4 },
});

/** The same instant written with a UTC offset of `minutes` (toISOString-like, with milliseconds). */
function withOffset(ms, minutes) {
  if (minutes === 0) return new Date(ms).toISOString();
  const local = new Date(ms + minutes * 60_000).toISOString().slice(0, 23);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

async function stream(index, perStream) {
  const r = rng((args.seed * 104_729 + index) >>> 0);
  // Odd streams run a store clock that writes one fixed UTC offset (+05:30 or -05:00); stream 2 (mod 4)
  // one whose offset changes on every call (-10:00 .. +14:00), as after the offset-clock fix the store
  // normalizes to UTC. The instants are the same in every stream.
  const VARYING = [-600, -300, 0, 330, 540, 840];
  let calls = 0;
  const clock = { ms: Date.UTC(2026, 0, 1), offset: index % 4 === 1 ? 330 : index % 4 === 3 ? -300 : 0 };
  const now = () => withOffset(clock.ms, index % 4 === 2 ? VARYING[calls++ % VARYING.length] : clock.offset);
  const path = join(dir, `temporal-${index}.sqlite`);
  const writer = new SqliteSystemMemory({ databasePath: path, systemId: 'twin', now });
  const reader = new SqliteSystemMemory({ databasePath: path, systemId: 'twin', now });
  await writer.enable({ by: 'twin' });
  const provider = memoryProviderFromPorts({ recall: writer, now: () => new Date(clock.ms) });
  const scope = { tenant: 'twin', namespace: 'facts' };
  const other = { tenant: 'twin', namespace: 'other-facts' };

  const model = new Map(); // id -> { fact, scopeKey, promoted, invalidated, withdrawn, validUntilMs, digest, supersedes }
  const live = new Map(); // fact -> id of the live lesson in `scope`
  const pending = []; // unpromoted update ids
  let seq = 0;
  const t = {
    steps: 0, recalls: 0, returned: 0, violations: 0, violationExamples: [], otherLeaks: 0, otherLeakExamples: [],
    promotions: 0, expectedRefusals: {}, predictionMismatches: 0, mismatchExamples: [], liveChecked: 0, liveRecalled: 0,
    listChecks: 0, listMismatches: 0, listMismatchExamples: [], events: {},
    orderChecks: 0, orderViolations: 0,
  };

  async function put(target, fact, { supersedes, validUntilMs, offset = 0 }) {
    const id = `fact-${index}-${seq++}`;
    const record = {
      id, scope: target,
      text: `Account ${fact}: the ${ATTRS[fact % ATTRS.length]} of account ${fact} is value-${seq} (version ${seq}).`,
      provenance: { source: 'operator-note', sourceVersion: 'twin', observedAt: new Date(clock.ms).toISOString(), inputHash: 'a'.repeat(64) },
      ...(supersedes?.length ? { supersedes } : {}),
      ...(validUntilMs !== undefined ? { validUntil: withOffset(validUntilMs, offset) } : {}),
    };
    await writer.put(record);
    const listed = await writer.list({ scope: target, limit: 8 });
    const view = listed.find(v => v.record.id === id);
    if (!view) throw new Error(`stream ${index}: the record just stored is not among the 8 newest listed`);
    model.set(id, {
      fact, scopeKey: target.namespace, promoted: false, invalidated: false, withdrawn: false,
      validUntilMs, digest: view.contentDigest, supersedes: supersedes ?? [],
    });
    return id;
  }

  function predict(id) {
    const m = model.get(id);
    if (m.withdrawn) return 'WITHDRAWN';
    if (m.promoted) return 'ALREADY';
    if (m.validUntilMs !== undefined && m.validUntilMs < clock.ms) return 'EXPIRED';
    for (const target of m.supersedes) {
      const x = model.get(target);
      if (!x || x.scopeKey !== m.scopeKey || !x.promoted || x.invalidated || x.withdrawn) return 'INVALID_SUPERSESSION';
    }
    return 'PROMOTED';
  }

  async function promote(id) {
    const m = model.get(id);
    const expected = predict(id);
    let actual;
    try {
      const result = await writer.promote({ scope: { tenant: 'twin', namespace: m.scopeKey }, id, gate: GATE(m.digest), by: 'twin' });
      actual = result.promoted ? (expected === 'ALREADY' ? 'ALREADY' : 'PROMOTED') : result.reason;
    } catch (error) {
      actual = error?.code ?? String(error);
    }
    if (actual !== expected) {
      t.predictionMismatches += 1;
      if (t.mismatchExamples.length < 5) t.mismatchExamples.push({ stream: index, step: t.steps, id, expected, actual });
    }
    if (actual === 'PROMOTED') {
      t.promotions += 1;
      m.promoted = true;
      for (const target of m.supersedes) model.get(target).invalidated = true;
      if (m.scopeKey === 'facts') live.set(m.fact, id);
    } else if (actual !== 'ALREADY') t.expectedRefusals[actual] = (t.expectedRefusals[actual] ?? 0) + 1;
    return actual;
  }

  function check(surface, records, fact) {
    t.recalls += 1;
    for (const rec of records) {
      t.returned += 1;
      const m = model.get(rec.id);
      const expired = m?.validUntilMs !== undefined && m.validUntilMs < clock.ms;
      if (m && (m.invalidated || expired)) {
        t.violations += 1;
        if (t.violationExamples.length < 5) {
          t.violationExamples.push({ stream: index, step: t.steps, surface, id: rec.id, invalidated: m.invalidated, expired, validUntil: rec.validUntil, now: now() });
        }
      } else if (!m || !m.promoted || m.withdrawn || m.scopeKey !== 'facts') {
        t.otherLeaks += 1;
        if (t.otherLeakExamples.length < 5) t.otherLeakExamples.push({ stream: index, step: t.steps, surface, id: rec.id, model: m ?? null });
      }
    }
    const liveId = live.get(fact);
    const lm = liveId && model.get(liveId);
    if (surface === 'writer' && lm && !lm.invalidated && !lm.withdrawn && !(lm.validUntilMs !== undefined && lm.validUntilMs < clock.ms)) {
      t.liveChecked += 1;
      if (records.some(rec => rec.id === liveId)) t.liveRecalled += 1;
    }
  }

  const validity = () => {
    const u = r.next();
    if (u < 0.65) return undefined;
    if (u < 0.75) return clock.ms - r.int(1, 2 * HOUR); // already expired: promotion must be EXPIRED
    if (u < 0.80) return clock.ms + r.int(1, 1000); // expires within a second: lands mid-stream
    return clock.ms + r.int(HOUR, 72 * HOUR);
  };
  const offset = () => (r.bernoulli(0.5) ? 0 : r.pick([-720, -330, -60, 60, 330, 545, 840]));
  const liveOf = fact => (live.has(fact) && !model.get(live.get(fact)).withdrawn ? [live.get(fact)] : []);
  const event = name => { t.events[name] = (t.events[name] ?? 0) + 1; };

  // A lesson in the other scope whose id the stream later names from `facts`.
  const foreign = await put(other, 0, {});
  await promote(foreign);

  for (let step = 0; step < perStream; step += 1) {
    t.steps += 1;
    clock.ms += Math.round(-Math.log(Math.max(r.next(), 1e-9)) * 2 * HOUR) + r.int(0, 999);
    const fact = r.int(0, FACTS - 1);
    const u = r.next();
    if (u < 0.55) {
      event('update');
      const id = await put(scope, fact, { supersedes: liveOf(fact), validUntilMs: validity(), offset: offset() });
      if (r.bernoulli(0.85)) await promote(id); else pending.push(id);
    } else if (u < 0.65 && pending.length) {
      event('late-promotion');
      await promote(pending.splice(r.int(0, pending.length - 1), 1)[0]);
    } else if (u < 0.75) {
      event('concurrent-updates');
      const sup = liveOf(fact);
      const a = await put(scope, fact, { supersedes: sup, validUntilMs: validity(), offset: offset() });
      const b = await put(scope, fact, { supersedes: sup, validUntilMs: validity(), offset: offset() });
      await promote(a);
      await promote(b);
    } else if (u < 0.82) {
      event('unpromoted-supersedes');
      if (liveOf(fact).length) await put(scope, fact, { supersedes: liveOf(fact) });
    } else if (u < 0.86) {
      event('foreign-supersedes');
      await promote(await put(scope, fact, { supersedes: [foreign] }));
    } else if (u < 0.91 && live.has(fact) && !model.get(live.get(fact)).withdrawn) {
      event('rollback');
      const id = live.get(fact);
      await writer.rollback({ scope, id, by: 'twin', reason: 'measured regression' });
      model.get(id).withdrawn = true;
    } else if (u < 0.95) {
      event('supersede-withdrawn-or-invalidated');
      const dead = [...model.entries()].filter(([, m]) => m.scopeKey === 'facts' && (m.withdrawn || m.invalidated));
      if (dead.length) await promote(await put(scope, fact, { supersedes: [r.pick(dead)[0]] }));
    } else {
      event('quiet');
    }
    for (let q = 0; q < 3; q += 1) {
      const f = r.int(0, FACTS - 1);
      const text = `account ${f} ${ATTRS[f % ATTRS.length]}`;
      check('writer', await writer.query({ scope, text, limit: 3 }), f);
      check('second-connection', await reader.query({ scope, text, limit: 3 }), f);
      check('provider', await provider.recall({ scope, text, limit: 3, provider: 'claude', transport: 'exec', cwd: '/' }), f);
    }
    if (step % 50 === 49) {
      t.listChecks += 1;
      const views = await writer.list({ scope, limit: 256 });
      // Newest first by instant (recordedAt), whatever offset the clock wrote.
      for (let v = 1; v < views.length; v += 1) {
        t.orderChecks += 1;
        if (Date.parse(views[v].recordedAt) > Date.parse(views[v - 1].recordedAt)) t.orderViolations += 1;
      }
      for (const view of views) {
        const m = model.get(view.record.id);
        const expired = m.validUntilMs !== undefined && m.validUntilMs < clock.ms;
        const expected = m.invalidated ? 'invalidated' : expired ? 'expired' : m.promoted ? 'lesson' : 'episode'; // invalidation wins (records.ts stateOf)
        if (view.state !== expected) {
          t.listMismatches += 1;
          if (t.listMismatchExamples.length < 5) t.listMismatchExamples.push({ stream: index, step, id: view.record.id, expected, actual: view.state });
        }
      }
    }
  }
  writer.close();
  reader.close();
  return t;
}

const perStream = Math.ceil(steps / streams);
const tallies = [];
for (let i = 0; i < streams; i += 1) tallies.push(await stream(i, perStream));
const total = key => tallies.reduce((s, t) => s + t[key], 0);
const merge = key => tallies.reduce((acc, t) => { for (const [k, v] of Object.entries(t[key])) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
const examples = key => tallies.flatMap(t => t[key]).slice(0, 5);

emit('memory/temporal', [{
  id: 'M6', ...judgeInvariant(total('violations'), total('steps')), minTrials: h.minTrials, claim: h.claim,
  recallCalls: total('recalls'), recordsReturned: total('returned'), violationExamples: examples('violationExamples'),
  assumptions: {
    streams, stepsPerStream: perStream, facts: FACTS, interArrival: 'exponential, mean 2 h, plus 0-999 ms',
    events: 'update 55% (85% promoted at once), late promotion 10%, two concurrent updates 10%, unpromoted episode naming a live lesson 7%, supersedes naming another scope\'s id 4%, rollback 5%, supersedes naming a withdrawn/invalidated lesson 4%, quiet otherwise',
    validUntil: '35% of updates: 10% already expired (1 ms-2 h ago), 5% within 1 s, 20% 1-72 h ahead; half written with a UTC offset',
    clocks: 'streams 1 and 3 (mod 4): store clock written with a fixed UTC offset (+05:30, -05:00); stream 2 (mod 4): offset varying per call (-10:00 .. +14:00); same instants',
    surfaces: ['writer.query', 'second connection query', 'memoryProviderFromPorts.recall'],
    gate: 'synthetic passing gate naming the record digest (measurement is out of scope for M6)',
  },
  events: merge('events'), promotions: total('promotions'), refusals: merge('expectedRefusals'),
  otherFindings: {
    promotionPredictionMismatches: total('predictionMismatches'), mismatchExamples: examples('mismatchExamples'),
    nonLessonLeaks: total('otherLeaks'), leakExamples: examples('otherLeakExamples'),
    listStateChecks: total('listChecks'), listStateMismatches: total('listMismatches'), listMismatchExamples: examples('listMismatchExamples'),
    listNewestFirst: { pairsChecked: total('orderChecks'), outOfOrder: total('orderViolations') },
    liveness: { liveLessonsQueried: total('liveChecked'), recalled: total('liveRecalled'), rate: total('liveRecalled') / Math.max(1, total('liveChecked')) },
  },
}], { seed: args.seed, wallSeconds: elapsed() });
