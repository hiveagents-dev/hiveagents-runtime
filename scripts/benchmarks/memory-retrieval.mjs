#!/usr/bin/env node
/**
 * Controlled authored quality/latency comparison. No provider calls or downloads.
 * Usage: npm run build && node scripts/benchmarks/memory-retrieval.mjs
 *        node scripts/benchmarks/memory-retrieval.mjs --module /absolute/module.js --iterations 300
 * JSON goes to stdout; redirect it to retain an immutable evidence artifact.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--module', '--iterations'].includes(args[i]) || args[i + 1] === undefined || flags.has(args[i])) {
    throw new Error('Expected --module <path> and/or --iterations <positive integer>');
  }
  flags.set(args[i], args[i + 1]);
}
const iterations = Number(flags.get('--iterations') ?? 300);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive safe integer');
const warmupIterations = 50;
const modulePath = resolve(root, flags.get('--module') ?? 'dist/orchestration/memory.js');
const fixturePath = resolve(root, 'tests/orchestration/memory-fixtures/retrieval-v1.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = await readFile(fixturePath);
const frozenFixtureSha256 = '1b203af2c356f60b3e3b39ce27422c59f2262b4e1c30128614b0d223da8a54f5';
if (digest(fixtureBytes) !== frozenFixtureSha256) throw new Error('Frozen judgments changed; create a new version instead of tuning this fixture');
const fixture = JSON.parse(fixtureBytes);
const source = execFileSync('git', ['show', `${fixture.baseline.commit}:${fixture.baseline.path}`], { cwd: root, encoding: 'utf8' });
if (digest(source) !== fixture.baseline.sha256) throw new Error('Pinned baseline source hash mismatch');
const start = source.indexOf('        const terms = task.toLowerCase()');
const end = source.indexOf('\n      },\n      async list', start);
if (start < 0 || end < 0) throw new Error('Pinned fallback method was not found');
const fallbackBody = source.slice(start, end);
// This is the exact, hash-verified repository fallback body, without importing
// AgentDB or changing its text processing, scoring, sorting, or truncation.
const fallback = new Function('task', 'limit', 'ledger', fallbackBody);
const { rankMemories } = await import(pathToFileURL(modulePath).href);
const documents = fixture.documents.map((document) => Object.freeze({
  ...document, text: `${document.task} ${document.output ?? ''}`,
}));
const ledger = { list: () => ({ episodes: fixture.documents }) };
const rankers = {
  baseline: (query, limit) => fallback(query, limit, ledger).map(({ id }) => id),
  lexical: (query, limit) => rankMemories(query, documents, { limit }).map(({ record }) => record.id),
};
function quality(ids, relevant) {
  const first = ids.findIndex((id) => relevant.includes(id));
  return {
    top3: ids.slice(0, 3),
    firstRelevantRank: first < 0 ? null : first + 1,
    recallAt3: relevant.length ? ids.slice(0, 3).filter((id) => relevant.includes(id)).length / relevant.length : null,
    reciprocalRank: relevant.length ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    falsePositiveOnNegative: relevant.length === 0 && ids.length > 0,
  };
}
const perQuery = fixture.queries.map((query) => ({
  ...query,
  baseline: quality(rankers.baseline(query.query, documents.length), query.relevant),
  lexical: quality(rankers.lexical(query.query, documents.length), query.relevant),
}));
function summarize(rows, key) {
  const positive = rows.filter(({ relevant }) => relevant.length > 0);
  const negative = rows.filter(({ relevant }) => relevant.length === 0);
  return {
    positiveQueries: positive.length,
    recallAt3: positive.reduce((sum, row) => sum + row[key].recallAt3, 0) / (positive.length || 1),
    mrr: positive.reduce((sum, row) => sum + row[key].reciprocalRank, 0) / (positive.length || 1),
    negativeQueries: negative.length,
    falsePositiveNegativeQueries: negative.filter((row) => row[key].falsePositiveOnNegative).length,
  };
}
const latency = [];
for (const query of fixture.queries) {
  for (let i = 0; i < warmupIterations; i++) {
    rankers.baseline(query.query, 3);
    rankers.lexical(query.query, 3);
  }
  const samples = { baseline: [], lexical: [] };
  for (let i = 0; i < iterations; i++) {
    // Alternate measurement order; includes rebuilding the ranker's corpus.
    for (const key of i % 2 ? ['lexical', 'baseline'] : ['baseline', 'lexical']) {
      const before = performance.now();
      rankers[key](query.query, 3);
      samples[key].push(performance.now() - before);
    }
  }
  const stats = (values) => {
    values.sort((a, b) => a - b);
    return {
      meanMs: values.reduce((a, b) => a + b, 0) / values.length,
      p50Ms: values[Math.ceil(values.length * 0.5) - 1],
      p95Ms: values[Math.ceil(values.length * 0.95) - 1],
    };
  };
  latency.push({ id: query.id, query: query.query, baseline: stats(samples.baseline), lexical: stats(samples.lexical) });
}
const sourcePaths = ['src/orchestration/memory/index.ts', 'src/orchestration/memory/ranker.ts', 'scripts/benchmarks/memory-retrieval.mjs'];
const sources = await Promise.all(sourcePaths.map(async (path) => ({ path, sha256: digest(await readFile(resolve(root, path))) })));
console.log(JSON.stringify({
  benchmark: fixture.name,
  measuredAt: new Date().toISOString(),
  scope: fixture.scope,
  limitations: [
    'Authored examples and judgments are controlled contract evidence, not independently sampled user-quality evidence.',
    'No embedding model was invoked. Semantic vectors and MMR are not evaluated for real retrieval quality.',
    'Exact token matching has no stemming or synonyms; inflection and semantic-gap controls are retained, including regressions.',
    'Latency is one process on this small corpus, includes tokenization/statistics each call, and supports no broad speed claim.',
    'Recall@3 and MRR exclude negative queries; negative false positives are reported separately. MRR uses all returned ranks.',
  ],
  environment: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  configuration: { documents: documents.length, queries: fixture.queries.length, iterationsPerQuery: iterations, warmupIterations, latencyLimit: 3, candidate: 'default lexical BM25; semanticWeight=0, diversity=0; no tuning' },
  evidence: { baseline: { ...fixture.baseline, extractedBodySha256: digest(fallbackBody) }, fixtureSha256: digest(fixtureBytes), builtModule: { path: isAbsolute(modulePath) ? modulePath : resolve(modulePath), sha256: digest(await readFile(modulePath)) }, sources },
  summary: { baseline: summarize(perQuery, 'baseline'), lexical: summarize(perQuery, 'lexical') },
  categories: Object.fromEntries([...new Set(perQuery.map(({ category }) => category))].map((category) => {
    const rows = perQuery.filter((row) => row.category === category);
    return [category, { baseline: summarize(rows, 'baseline'), lexical: summarize(rows, 'lexical') }];
  })),
  perQuery,
  latency,
}, null, 2));
