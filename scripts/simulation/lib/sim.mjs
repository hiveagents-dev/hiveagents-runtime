/**
 * Shared helpers for the decision simulations (digital twin and live tier).
 *
 * Every simulation runs the SDK's built `dist/` code against a simulated environment, reads its
 * pre-registered thresholds from `hypotheses.json` and prints one JSON result per hypothesis.
 * Thresholds are never passed on the command line: changing one means editing the registry, in
 * a commit of its own, before the run.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Seeded PRNG (mulberry32): the same seed reproduces the same run. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    bernoulli: p => next() < p,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)],
    /** Log-normal by median and p95 (latencies, token counts). */
    lognormal(median, p95) {
      const sigma = Math.log(p95 / median) / 1.6448536269514722;
      const u1 = Math.max(next(), 1e-12);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * next());
      return median * Math.exp(sigma * z);
    },
  };
}

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k, n, z = 1.959963984540054) {
  if (n === 0) return { p: 0, low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const registry = JSON.parse(readFileSync(resolve(root, 'scripts/simulation/hypotheses.json'), 'utf8'));

/** The pre-registered hypothesis, by id; throws for an unknown id. */
export function hypothesis(id) {
  const found = registry.hypotheses.find(h => h.id === id);
  if (!found) throw new Error(`Unknown hypothesis ${id}`);
  return found;
}

/**
 * Verdict of a proportion against a pre-registered bound, judged on the 95% interval so a
 * small sample cannot pass by luck: `at-most` passes when the upper bound is within it and
 * fails when the lower bound is beyond it; `at-least` mirrors that. Anything else is inconclusive.
 */
export function judgeProportion(k, n, bound, direction) {
  const ci = wilson(k, n);
  let verdict = 'inconclusive';
  if (direction === 'at-most') verdict = ci.high <= bound ? 'supported' : ci.low > bound ? 'refuted' : 'inconclusive';
  else if (direction === 'at-least') verdict = ci.low >= bound ? 'supported' : ci.high < bound ? 'refuted' : 'inconclusive';
  else throw new Error(`Unknown direction ${direction}`);
  return { k, n, rate: ci.p, ci95: [ci.low, ci.high], bound, direction, verdict };
}

/** Verdict of an exact invariant: any violation refutes it. */
export function judgeInvariant(violations, trials) {
  return { violations, trials, verdict: violations === 0 ? 'supported' : 'refuted' };
}

/** Loads a built entry of the SDK (`npm run build` first). */
export async function sdk(entry) {
  return import(pathToFileURL(resolve(root, 'dist', `${entry}.js`)).href);
}

/** Source binding for a result: commit, dirty flag and the registry's digest. */
export function receipt() {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--', 'src']).length > 0,
    registrySha256: createHash('sha256').update(readFileSync(resolve(root, 'scripts/simulation/hypotheses.json'))).digest('hex'),
    node: process.version,
  };
}

/** Prints one simulation's results as a single JSON document on stdout. */
export function emit(simulation, results, extra = {}) {
  process.stdout.write(`${JSON.stringify({ simulation, receipt: receipt(), ...extra, results }, null, 2)}\n`);
}
