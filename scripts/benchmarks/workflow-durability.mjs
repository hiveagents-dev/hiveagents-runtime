/** Offline callback benchmark. Synthetic timers do not measure provider performance. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
// The baseline is the Marketing app at a pinned commit of the platform repository.
const baselineRoot = process.env.OAR_BASELINE_CHECKOUT;
assert.ok(baselineRoot, 'Set OAR_BASELINE_CHECKOUT to a checkout of the platform repository (it holds apps/marketing-swarm)');
const base = execFileSync('git', ['rev-parse', '171d67f'], { cwd: baselineRoot, encoding: 'utf8' }).trim();
const hash = text => createHash('sha256').update(text).digest('hex');
const baselineFiles = [
  'apps/marketing-swarm/shared/roster.ts',
  'apps/marketing-swarm/electron/hive/waves.ts',
  'apps/marketing-swarm/electron/hive/rehydrate.ts',
];
const baselineSources = Object.fromEntries(baselineFiles.map(path => [path,
  execFileSync('git', ['show', `${base}:${path}`], { cwd: baselineRoot, encoding: 'utf8' }),
]));
// Execute the actual pinned function, with TypeScript erased. The callback driver
// below mirrors the app's Promise.all barrier; it is not the app/provider runtime.
const parsed = ts.createSourceFile('roster.ts', baselineSources[baselineFiles[0]], ts.ScriptTarget.Latest, true);
const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readWaves');
assert.ok(fn);
const baselineJs = ts.transpileModule(fn.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const load = code => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const { readWaves } = await load(baselineJs);
const candidate = await build({ entryPoints: [join(root, 'src/orchestration/workflow/index.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
const { WorkflowRunner, FileWorkflowStore } = await load(candidate.outputFiles[0].text);
const tasks = [
  { id: 'a' }, { id: 'b' }, { id: 'c' },
  { id: 'd', dependencies: ['a', 'b'] }, { id: 'e', dependencies: ['b', 'c'] },
  { id: 'f', dependencies: ['d', 'e'] },
];
const waves = readWaves(tasks.map(task => ({ id: task.id, reads: task.dependencies })));
assert.deepEqual(waves.map(wave => wave.map(task => task.id)), [['a', 'b', 'c'], ['d', 'e'], ['f']]);
const delay = () => new Promise(resolve => setTimeout(resolve, 20));
function meter() {
  let active = 0; let peak = 0; const calls = [];
  return {
    calls, get peak() { return peak; },
    async execute(id) { calls.push(id); peak = Math.max(peak, ++active); await delay(); active--; return { id }; },
  };
}
const baseline = meter(); const started = performance.now();
for (const wave of waves) await Promise.all(wave.map(task => baseline.execute(task.id)));
const baselineMs = performance.now() - started;
const naive = meter();
await Promise.all(waves[0].map(task => naive.execute(task.id)));
for (const wave of waves) await Promise.all(wave.map(task => naive.execute(task.id)));
const directory = await mkdtemp(join(tmpdir(), 'oar-workflow-benchmark-'));
try {
  const healthy = meter();
  const definition = { id: 'benchmark', version: '1', steps: tasks.map(task => ({
    ...task, execute: () => healthy.execute(task.id),
  })) };
  const begin = performance.now();
  const completed = await new WorkflowRunner(new FileWorkflowStore(directory)).run(definition, { runId: 'normal', concurrency: 3 });
  const candidateMs = performance.now() - begin;
  assert.equal(completed.status, 'completed'); assert.equal(healthy.calls.length, 6); assert.ok(healthy.peak <= 3);
  const resumed = meter(); const abort = new AbortController(); let firstWaveCompleted = 0;
  const recoverable = { id: 'benchmark', version: '1', steps: tasks.map(task => ({
    ...task, async execute() {
      const result = await resumed.execute(task.id);
      if (!task.dependencies && ++firstWaveCompleted === 3) abort.abort();
      return result;
    },
  })) };
  const interrupted = await new WorkflowRunner(new FileWorkflowStore(directory)).run(recoverable, { runId: 'resume', concurrency: 3, signal: abort.signal });
  assert.equal(interrupted.status, 'cancelled'); assert.equal(resumed.calls.length, 3);
  const recovered = await new WorkflowRunner(new FileWorkflowStore(directory)).run(recoverable, { runId: 'resume', concurrency: 3 });
  assert.equal(recovered.status, 'completed'); assert.equal(resumed.calls.length, 6);
  const sourcePaths = (await readdir(join(root, 'src/orchestration/workflow'))).filter(path => path.endsWith('.ts')).sort();
  const candidateHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [
    `src/orchestration/workflow/${path}`, hash(await readFile(join(root, 'src/orchestration/workflow', path))),
  ])));
  console.log(JSON.stringify({
    kind: 'offline synthetic callbacks; no provider calls or production throughput claims',
    baseline: { commit: base, sourceHashes: Object.fromEntries(Object.entries(baselineSources).map(([path, text]) => [path, hash(text)])),
      driver: 'actual pinned readWaves plus Promise.all wave callback harness', executions: baseline.calls.length,
      peakConcurrency: baseline.peak, milliseconds: baselineMs },
    candidate: { sourceHashes: candidateHashes, executions: healthy.calls.length, peakConcurrency: healthy.peak, milliseconds: candidateMs },
    recovery: { boundary: 'graceful cancellation after wave 1; new runner and file-store objects',
      priorExecutions: 3, naiveRestartExecutionsTotal: naive.calls.length, resumedExecutionsTotal: resumed.calls.length,
      executionsSaved: naive.calls.length - resumed.calls.length, completedStepsRepeated: 0 },
    parameters: { callbacks: 6, waves: [3, 2, 1], syntheticTimerMs: 20, concurrency: 3 },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    conclusion: 'Durability saves repeated completed callbacks on resume; fsync checkpoints add healthy-run overhead. No speed gain versus app wave orchestration is established.',
  }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
