/**
 * M8: the recall budget as the real Agent applies it (dist `Agent` + `Runtime` over a stub CLI, so
 * `MemoryTurns` selects, renders and budgets the items exactly as in production, defaults:
 * maxItems 2, maxBytes 8 KiB, maxProfileBytes 2 KiB since the profile-budget change, was 1 KiB). Each turn the provider returns 1-6 ranked
 * items with log-normal text sizes (median 400 B, p95 3 KiB) and, half the time, a profile of
 * 0-6 KiB. The question: how often is the top-ranked (relevant) item cut by the byte budget?
 *
 * Also reported (no verdict): the relevant item at a random rank (cut by count vs by bytes), how
 * often the profile is omitted, and whether carrying a profile ever changes which items are kept.
 *
 *   node scripts/simulation/memory/recall-budget.mjs [--seed N] [--trials N]
 */
import { createHash } from 'node:crypto';
import { emit, hypothesis, judgeProportion, rng, sdk } from '../lib/sim.mjs';
import { cli, stopwatch } from './lib-env.mjs';

const args = cli();
const elapsed = stopwatch();
const h = hypothesis('M8');
const n = args.trials ?? h.minTrials;
const { Agent, Runtime, MEMORY_DEFAULT_MAX_BYTES, MEMORY_DEFAULT_MAX_ITEMS, MEMORY_DEFAULT_MAX_PROFILE_BYTES } = await sdk('index');
const r = rng(args.seed);
const WORDS = ['invoice', 'client', 'region', 'currency', 'renewal', 'ticket', 'escalate', 'policy', 'refund', 'account', 'the', 'is', 'in', 'for', 'and'];

/** ASCII text of exactly `bytes` bytes, in lines of at most 100 characters. */
function textOf(bytes) {
  let out = '';
  let line = 0;
  while (out.length < bytes) {
    const word = r.pick(WORDS);
    if (line + word.length + 1 > 100) { out += '\n'; line = 0; continue; }
    out += (line ? ' ' : '') + word;
    line += word.length + (line ? 1 : 0);
  }
  out = out.slice(0, bytes).trim();
  return out.length ? out : 'x';
}

let current = { items: [], profile: undefined };
const provider = {
  id: 'memory-ports',
  recall: async () => current.items,
  profile: async () => current.profile,
};
const exec = {
  id: 'claude',
  async detect() { return { installed: true, path: '/bin/claude', version: '1.0.0' }; },
  async auth() { return { authenticated: true, source: 'subscription' }; },
  async models() { return []; },
  async execute() { return { completed: true, failed: false, refused: false, sessionId: 's', text: 'ok', events: [{ type: 'message.completed', text: 'ok' }], nativeEvents: [] }; },
  async *stream(request) { yield { kind: 'result', result: await this.execute(request) }; },
};
const scope = { tenant: 'twin', namespace: 'agents', subject: 'budget' };
const withProfile = new Agent({ model: 'opus-5', memory: { provider, scope } }, new Runtime({ adapters: [exec] }));
const noProfileProvider = { id: 'memory-ports', recall: async () => current.items };
const withoutProfile = new Agent({ model: 'opus-5', memory: { provider: noProfileProvider, scope } }, new Runtime({ adapters: [exec] }));

const keptOf = turn => {
  const note = turn.providerMetadata?.memory;
  return { note, kept: note?.status === 'recalled' ? note.items.map(i => i.id) : [] };
};

const t = {
  topCut: 0, topOversize: 0, randomRankTurns: 0, randomCutByBytes: 0, randomCutByCount: 0,
  profiles: 0, profileOmitted: 0, profileCarried: 0, independenceChecked: 0, independenceMismatch: 0,
  sizes: [], itemsPerTurn: {},
};
let seq = 0;
for (let turn = 0; turn < n; turn += 1) {
  const count = r.int(1, 6);
  t.itemsPerTurn[count] = (t.itemsPerTurn[count] ?? 0) + 1;
  const items = Array.from({ length: count }, () => {
    const bytes = Math.max(20, Math.round(r.lognormal(400, 3072)));
    t.sizes.push(bytes);
    const id = `curator-${createHash('sha256').update(String(seq++)).digest('hex')}`;
    return { id, source: 'curator', observedAt: '2026-11-10T10:00:00.000Z', text: textOf(bytes) };
  });
  const hasProfile = r.bernoulli(0.5);
  const profile = hasProfile ? textOf(r.int(1, 6144)) : undefined;
  const relevantRank = r.int(0, count - 1); // for the random-rank view
  current = { items, profile };
  const sent = await withProfile.send(`Turn ${turn}: what currency do we invoice in?`);
  const { note, kept } = keptOf(sent);
  if (!kept.includes(items[0].id)) {
    t.topCut += 1;
    // The first item can only be cut by bytes: count never cuts the first.
  }
  if (Buffer.byteLength(items[0].text) > MEMORY_DEFAULT_MAX_BYTES) t.topOversize += 1;
  t.randomRankTurns += 1;
  if (!kept.includes(items[relevantRank].id)) {
    // Cut by count when maxItems items were already kept before it; otherwise by bytes.
    const keptBefore = items.slice(0, relevantRank).filter(item => kept.includes(item.id)).length;
    if (keptBefore >= MEMORY_DEFAULT_MAX_ITEMS) t.randomCutByCount += 1; else t.randomCutByBytes += 1;
  }
  if (hasProfile) {
    t.profiles += 1;
    if (note?.profile?.status === 'omitted') t.profileOmitted += 1;
    if (note?.profile?.status === 'carried') t.profileCarried += 1;
    if (turn % 4 === 0) {
      t.independenceChecked += 1;
      const again = keptOf(await withoutProfile.send(`Turn ${turn}: what currency do we invoice in?`)).kept;
      if (JSON.stringify(again) !== JSON.stringify(kept)) t.independenceMismatch += 1;
    }
  }
}
await withProfile.close();
await withoutProfile.close();

const sorted = [...t.sizes].sort((a, b) => a - b);
const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
emit('memory/recall-budget', [{
  id: 'M8', ...judgeProportion(t.topCut, n, h.bound, h.direction), minTrials: h.minTrials, belowMinTrials: n < h.minTrials, claim: h.claim,
  assumptions: {
    itemsPerTurn: 'uniform 1-6', itemTextBytes: 'log-normal, median 400 B, p95 3072 B, min 20 B, ASCII, lines <= 100 chars',
    item: 'curator-<sha256> id, source curator, observedAt set, no title', relevant: 'ranked first',
    profile: '50% of turns, uniform 1-6144 B ASCII', budgets: { maxItems: MEMORY_DEFAULT_MAX_ITEMS, maxBytes: MEMORY_DEFAULT_MAX_BYTES, maxProfileBytes: MEMORY_DEFAULT_MAX_PROFILE_BYTES },
    path: 'real dist Agent + Runtime with a stub CLI; MemoryTurns applies the budget',
  },
  topCutWithTextOver8KiB: t.topOversize,
  sampledSizes: { n: sorted.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.at(-1) },
  randomRank: {
    note: 'extra info: the relevant item at a uniformly random rank among the candidates',
    turns: t.randomRankTurns, cutByBytes: t.randomCutByBytes, cutByCount: t.randomCutByCount,
    cutByBytesRate: t.randomCutByBytes / t.randomRankTurns, cutByCountRate: t.randomCutByCount / t.randomRankTurns,
  },
  profile: {
    turnsWithProfile: t.profiles, omitted: t.profileOmitted, carried: t.profileCarried, omittedRate: t.profileOmitted / Math.max(1, t.profiles),
    itemSelectionIndependentOfProfile: { checked: t.independenceChecked, mismatches: t.independenceMismatch },
  },
  itemsPerTurn: t.itemsPerTurn,
}], { seed: args.seed, wallSeconds: elapsed() });
