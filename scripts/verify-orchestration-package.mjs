/** Build first. Verifies the tarball as a consumer outside this repository, offline. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'oar-packed-consumer-'));
const hash = value => createHash('sha256').update(value).digest('hex');
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root))[0];
  assert.ok(packed && typeof packed.filename === 'string');
  const paths = new Set(packed.files.map(file => file.path));
  for (const path of ['dist/index.js', 'dist/orchestration/index.js', 'dist/orchestration/index.d.ts',
    'dist/orchestration/graph.js', 'dist/orchestration/memory.js', 'dist/routing/index.js', 'dist/routing/index.d.ts',
    'dist/routing/learning/index.js', 'dist/routing/learning/index.d.ts', 'dist/memory-tools.js', 'dist/memory-tools.d.ts',
    'dist/orchestration/dynamic.js', 'dist/orchestration/dynamic.d.ts', 'docs/licenses/ruflo-memory-MIT.txt']) {
    assert.ok(paths.has(path), `Package omitted ${path}`);
  }
  assert.equal([...paths].some(path => /(^|\/)\.env(?:\.|$)/.test(path)), false);
  const consumer = join(temporary, 'consumer');
  const installed = join(consumer, 'node_modules/hiveagents-runtime');
  await mkdir(installed, { recursive: true });
  run('tar', ['-xzf', join(temporary, packed.filename), '--strip-components=1', '-C', installed], root);
  // Reuse already installed dependencies without fetching anything. The package
  // itself must come from the tarball; no source-worktree link is installed.
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const link = join(consumer, 'node_modules', dependency);
    await mkdir(dirname(link), { recursive: true });
    await symlink(await realpath(join(root, 'node_modules', dependency)), link, 'dir');
  }
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  await mkdir(join(consumer, 'examples/document-triage'), { recursive: true });
  await cp(join(root, 'examples/08-document-triage.ts'), join(consumer, 'examples/08-document-triage.ts'));
  await cp(join(root, 'examples/document-triage/triage.ts'), join(consumer, 'examples/document-triage/triage.ts'));

  const state = join(consumer, 'state');
  const example = ['--experimental-strip-types', 'examples/08-document-triage.ts', '--state-dir', state];
  const paused = JSON.parse(run(process.execPath, [...example, '--stop-after-intake'], consumer));
  const resumed = JSON.parse(run(process.execPath, example, consumer));
  const cached = JSON.parse(run(process.execPath, example, consumer));
  assert.equal(paused.status, 'cancelled');
  assert.deepEqual(paused.executedSteps, ['intake']);
  assert.equal(resumed.status, 'completed');
  assert.deepEqual([...resumed.executedSteps].sort(), ['backups', 'network', 'report']);
  assert.equal(resumed.admittedLaunches, 2);
  assert.deepEqual(resumed.report.network.sources, ['vpn']);
  assert.deepEqual(resumed.report.backups.sources, ['backup']);
  assert.deepEqual(cached.executedSteps, []);
  assert.equal(cached.admittedLaunches, 2);
  assert.deepEqual(cached.report, resumed.report);

  // The graph and ranker can be consumed by a renderer without Node shims.
  const browser = await build({
    absWorkingDir: consumer, platform: 'browser', format: 'esm', bundle: true, write: false,
    stdin: { resolveDir: consumer, contents: `
      export { dependencyWaves } from 'hiveagents-runtime/orchestration/graph';
      export { claudeMcpConfig, memoryProviderFromPorts, rankMemories } from 'hiveagents-runtime/orchestration/memory';
    ` },
  });
  const coreIsolation = run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const pkg = await import('hiveagents-runtime');
    const kit = await import('hiveagents-runtime/adapter-kit');
    for (const name of ['AbortError', 'AgentRuntimeError', 'ExecutionHaltedError', 'isExecutionHalted', 'OutputLimitError', 'ProtocolError', 'TimeoutError']) {
      assert.equal(typeof kit[name], 'function', name);
      assert.equal(kit[name], pkg[name], name);
    }
    assert.ok(pkg.isExecutionHalted(new kit.ExecutionHaltedError()));
    const orchestration = await import('hiveagents-runtime/orchestration');
    const graph = await import('hiveagents-runtime/orchestration/graph');
    assert.equal(typeof pkg.Agent, 'function');
    assert.equal('WorkflowRunner' in pkg, false);
    assert.equal('SharedLaunchBudget' in pkg, false);
    for (const name of ['HostLedger', 'hostLedgerPath', 'inspectLegacyLaunchBudget']) {
      assert.equal(name in pkg, false, name);
      assert.equal(typeof orchestration[name], 'function', name);
    }
    const routing = await import('hiveagents-runtime/routing');
    const learning = await import('hiveagents-runtime/routing/learning');
    for (const name of ['LearningRouter', 'SqliteLearningStore', 'hashTaskFeatures', 'buildSnapshot', 'assessGateEvidence']) {
      assert.equal(typeof learning[name], 'function', name);
      assert.equal(name in pkg, false);
      assert.equal(name in orchestration, false);
      assert.equal(name in routing, false);
    }
    for (const name of ['createAgent', 'readRoutingReceipt', 'validateRoutingReceipt', 'WorkflowRoutingReceiptStore', 'RoutingSelectionError']) {
      assert.equal(typeof routing[name], 'function', name);
      assert.equal(name in pkg, false);
      assert.equal(name in orchestration, false);
    }
    for (const name of ['runEvaluation', 'compareEvaluations', 'openTraceEpisode', 'WorkflowTraceStore', 'createTaskHandoff', 'WorkflowHandoffStore', 'runHandoff']) {
      assert.equal(name in pkg, false);
      assert.equal(typeof orchestration[name], 'function', name);
    }
    const runner = new orchestration.WorkflowRunner(new orchestration.FileWorkflowStore('./unused'));
    await assert.rejects(runner.run({ id: 'cycle', version: '1', steps: [
      { id: 'a', dependencies: ['a'], execute: () => null },
    ] }, { runId: 'cycle' }), error => error instanceof graph.DependencyCycleError);
    console.log(JSON.stringify({ Agent: true, optionalExportsAbsent: true, crossEntryErrorIdentity: true }));
  `], consumer);

  // The memory tools entry, imported alone from the tarball: its three surfaces exist, and loading
  // it loads no SQLite binding and prints no SQLite warning (it reaches memory only through a provider).
  const memoryToolsProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const tools = await import('hiveagents-runtime/memory-tools');
    for (const name of ['memoryTools', 'serveMemoryMcp', 'memoryMcpRecipe']) assert.equal(typeof tools[name], 'function', name);
    const sqlite = process.moduleLoadList.filter(name => /sqlite/i.test(name));
    assert.deepEqual(sqlite, [], 'hiveagents-runtime/memory-tools loaded ' + sqlite.join(', '));
    console.log(JSON.stringify({ exports: ['memoryTools', 'serveMemoryMcp', 'memoryMcpRecipe'], sqliteBindings: sqlite.length }));
  `], { cwd: consumer, encoding: 'utf8', timeout: 60_000 });
  assert.equal(memoryToolsProbe.status, 0, `memory-tools probe failed: ${memoryToolsProbe.stderr || memoryToolsProbe.error}`);
  assert.doesNotMatch(memoryToolsProbe.stderr, /SQLite/i, 'importing hiveagents-runtime/memory-tools printed an SQLite warning');
  const memoryTools = JSON.parse(memoryToolsProbe.stdout);

  // The dynamic workflows entry, imported alone from the tarball: its surfaces exist, a plan validates
  // and estimates offline, and loading it loads no SQLite binding and prints no SQLite warning.
  const dynamicProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const dynamic = await import('hiveagents-runtime/orchestration/dynamic');
    const functions = ['runWorkflowScript', 'createDynamicEngine', 'runWorkflowPlan', 'compilePlan', 'validatePlan', 'estimatePlan',
      'checkPlanArgs', 'planWorkflow', 'agentRunner', 'gitWorktreeIsolation', 'memoryDynamicJournal', 'fileDynamicJournal',
      'resolveDynamicLimits', 'DynamicPlanError', 'DynamicPlannerError', 'DynamicJournalCorruptError', 'DynamicJournalLockedError',
      'DynamicJournalWriteError', 'DynamicRunnerError', 'DynamicIsolationError'];
    for (const name of functions) assert.equal(typeof dynamic[name], 'function', name);
    assert.equal(typeof dynamic.DYNAMIC_PLAN_JSON_SCHEMA, 'object');
    const plan = dynamic.validatePlan({ format: 1, meta: { name: 'Probe', description: 'Probe.' },
      steps: [{ kind: 'map', id: 'review', over: 'args.files', prompt: 'Review {{item}}.' }] });
    assert.equal(dynamic.estimatePlan(plan, { files: ['a', 'b'] }).agents, 2);
    assert.throws(() => dynamic.validatePlan({ format: 1, meta: { name: 'Probe', description: 'Probe.' },
      steps: [{ kind: 'agent', id: 'a', prompt: 'A.', schema: { type: 'string', pattern: '^(a+)+$' } }] }),
      error => error instanceof dynamic.DynamicPlanError && error.code === 'SCHEMA_PATTERN');
    const sqlite = process.moduleLoadList.filter(name => /sqlite/i.test(name));
    assert.deepEqual(sqlite, [], 'hiveagents-runtime/orchestration/dynamic loaded ' + sqlite.join(', '));
    console.log(JSON.stringify({ exports: functions.length, estimatedAgents: 2, sqliteBindings: sqlite.length }));
  `], { cwd: consumer, encoding: 'utf8', timeout: 60_000 });
  assert.equal(dynamicProbe.status, 0, `orchestration/dynamic probe failed: ${dynamicProbe.stderr || dynamicProbe.error}`);
  assert.doesNotMatch(dynamicProbe.stderr, /SQLite/i, 'importing hiveagents-runtime/orchestration/dynamic printed an SQLite warning');
  const dynamicWorkflows = JSON.parse(dynamicProbe.stdout);

  console.log(JSON.stringify({
    kind: 'offline-packed-consumer', node: process.version, platform: process.platform, architecture: process.arch,
    package: { filename: packed.filename, bytes: packed.size, unpackedBytes: packed.unpackedSize,
      sha256: hash(await readFile(join(temporary, packed.filename))) },
    core: JSON.parse(coreIsolation), memoryTools, dynamicWorkflows, browserBundleBytes: browser.outputFiles[0].contents.length,
    processInvocations: 3, executedPerInvocation: [paused.executedSteps, resumed.executedSteps, cached.executedSteps],
    admittedLaunchesPerInvocation: [paused.admittedLaunches, resumed.admittedLaunches, cached.admittedLaunches],
    providerTurns: 0, report: cached.report, passed: true,
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
