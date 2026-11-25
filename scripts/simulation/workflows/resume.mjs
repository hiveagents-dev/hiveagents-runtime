/**
 * W1 — crash/resume twin of dynamic workflows.
 *
 * Each trial draws a workflow (a script mixing agent/parallel/pipeline/phase, or a plan with agent and
 * map steps), runs it once uninterrupted in this process (the reference), then runs it in child
 * processes against the REAL `fileDynamicJournal`, SIGKILLing them at random times (from the parent) or
 * inside a journal append (the child kills itself as `put` starts), and between processes randomly
 * truncates or corrupts the journal tail. The last process runs to the end. Checked:
 * - reruns: a runner invocation (in any process) of a key that the journal held as completed when that
 *   process started (by an independent oracle of the documented format);
 * - silent corruptions: a process that ran while the oracle says the journal must be refused, or a
 *   refusal that is not DynamicJournalCorruptError at the documented line;
 * - result mismatches: final result, status, error code, spent tokens or per-key statuses differ
 *   from the reference.
 *
 * Usage: node scripts/simulation/workflows/resume.mjs [--seed 1] [--trials 2000] [--width 8]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit, hypothesis, judgeInvariant, rng, sdk } from '../lib/sim.mjs';
import { deterministicRunner, planSpec, scriptFromSpec, scriptSpec } from './lib-flows.mjs';
import { flags, journalLine, journalOracle, lineRanges, pool, same } from './lib-twin.mjs';

const SELF = fileURLToPath(import.meta.url);
const LIMITS = { maxAgents: 1000 };

async function execute(dynamic, spec, options) {
  if (spec.kind === 'plan') return dynamic.runWorkflowPlan(spec.plan, { ...options, args: spec.args });
  return dynamic.runWorkflowScript(spec.meta, scriptFromSpec(spec), options);
}

// ------------------------------------------------------------------------------------------ child
async function child(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const write = value => writeFileSync(cfg.resultPath, JSON.stringify(value));
  const dynamic = await sdk('orchestration/dynamic');
  const journal = dynamic.fileDynamicJournal(cfg.journalDir);
  try {
    const owner = await journal.inspectOwner(cfg.runId);
    // The parent waited for the previous process to exit: its agents have stopped.
    if (owner) await journal.recoverAbandoned(cfg.runId, owner.token, { ownerStopped: true });
  } catch (error) { write({ kind: 'recover-failed', message: String(error?.message).slice(0, 200) }); return; }
  let puts = 0;
  const kill = () => process.kill(process.pid, 'SIGKILL');
  const wrapped = {
    open: runId => journal.open(runId),
    close: runId => journal.close(runId),
    // Negative control (--control no-replay): a journal that never replays must be caught as reruns.
    get: (runId, key) => (cfg.control === 'no-replay' ? Promise.resolve(undefined) : journal.get(runId, key)),
    put(runId, result) {
      puts++;
      if (cfg.selfKill && puts === cfg.selfKill.atPut) {
        const mode = cfg.selfKill.mode;
        if (mode === 'before') kill();
        else if (mode === 'microtask') queueMicrotask(kill);
        else if (mode === 'immediate') setImmediate(kill);
        else setTimeout(kill, mode === 'timeout1' ? 1 : 0);
      }
      return journal.put(runId, result);
    },
  };
  const runner = deterministicRunner({
    seed: cfg.seed, RunnerError: dynamic.DynamicRunnerError, latency: () => 1 + Math.random() * cfg.latencyMs,
    onInvoke: request => appendFileSync(cfg.invocationLog, `${JSON.stringify({ proc: cfg.proc, key: request.key })}\n`),
  });
  try {
    const report = await execute(dynamic, cfg.spec, { runId: cfg.runId, runner, journal: wrapped, limits: cfg.limits });
    write({ kind: 'report', report });
  } catch (error) {
    write({ kind: error?.name === 'DynamicJournalCorruptError' ? 'refused' : 'error', name: error?.name, line: error?.line, message: String(error?.message).slice(0, 200) });
  }
}

// ------------------------------------------------------------------------------------------ parent
function runChild(cfg, killAfterMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const proc = spawn(process.execPath, [SELF, '--child', cfg.configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk; });
    const timer = killAfterMs === undefined ? undefined : setTimeout(() => proc.kill('SIGKILL'), killAfterMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(readFileSync(cfg.resultPath, 'utf8')); } catch { result = undefined; }
      resolve({ code, signal, result, stderr: stderr.slice(0, 500), ms: Date.now() - started });
    });
  });
}

const CORRUPTIONS = ['truncate', 'flip-last', 'flip-middle', 'garbage-tail', 'garbage-line', 'garbage-before-last', 'duplicate-line', 'foreign-run', 'empty'];

/** Applies one corruption to the journal; returns its name (or undefined when it did not apply). */
function corrupt(r, path, runId) {
  if (!existsSync(path)) return undefined;
  const data = readFileSync(path);
  const { ranges, tail } = lineRanges(data);
  // Lines the documented rules accept (a recoverable journal may still end in a corrupt, dropped line).
  const valid = ranges.filter(([, end]) => end < (journalOracle(data, runId).validBytes ?? 0));
  const mode = r.pick(CORRUPTIONS);
  const flip = (buffer, at) => { const copy = Buffer.from(buffer); let byte; do { byte = 0x41 + r.int(0, 25); } while (byte === copy[at]); copy[at] = byte; return copy; };
  const garbage = () => Buffer.from(Array.from({ length: r.int(1, 40) }, () => 0x21 + r.int(0, 90)));
  let next;
  if (mode === 'truncate') {
    if (data.length === 0) return undefined;
    const span = ranges.length ? (ranges.at(-1)[1] - ranges.at(-1)[0] + 1) * 1.5 : data.length;
    next = data.subarray(0, Math.max(0, data.length - r.int(1, Math.max(1, Math.floor(span)))));
  } else if (mode === 'flip-last' || mode === 'flip-middle') {
    const pool = mode === 'flip-last' ? ranges.slice(-1) : ranges.slice(0, -1);
    if (pool.length === 0) return undefined;
    const [start, end] = r.pick(pool);
    next = flip(data, r.int(start, end - 1));
  } else if (mode === 'garbage-tail') next = Buffer.concat([data, garbage()]);
  else if (mode === 'garbage-line') next = Buffer.concat([data, garbage(), Buffer.from('\n')]);
  else if (mode === 'garbage-before-last') {
    if (ranges.length === 0 || tail > 0) return undefined;
    const [start] = ranges.at(-1);
    next = Buffer.concat([data.subarray(0, start), garbage(), Buffer.from('\n'), data.subarray(start)]);
  } else if (mode === 'duplicate-line') {
    if (valid.length === 0 || tail > 0) return undefined;
    const [start, end] = r.pick(valid);
    next = Buffer.concat([data, data.subarray(start, end + 1)]);
  } else if (mode === 'foreign-run') {
    if (valid.length === 0 || tail > 0) return undefined;
    const [start, end] = r.pick(valid);
    const record = JSON.parse(data.subarray(start, end).toString('utf8')).record;
    // A well-formed line of ANOTHER run, then (sometimes) a valid line of this run after it.
    const foreign = Buffer.from(journalLine(`${runId}-other`, record));
    next = r.bernoulli(0.5) ? Buffer.concat([data, foreign]) : Buffer.concat([data, foreign, data.subarray(start, end + 1)]);
  } else next = Buffer.alloc(0);
  writeFileSync(path, next);
  return mode;
}

async function trial(index, opts, dynamic) {
  const r = rng(opts.seed * 1_000_003 + index);
  const seed = `${opts.seed}:${index}`;
  const spec = r.bernoulli(0.45) ? planSpec(r) : scriptSpec(r);
  const limits = { ...LIMITS, concurrency: r.int(1, 6) };
  const latencyMs = r.int(2, 25);
  const out = { index, kind: spec.kind, reruns: [], silent: [], mismatches: [], falseRefusals: [], errors: [], refusals: 0, kills: 0, selfKills: 0, corruptions: {}, stuckLocks: 0, processes: 0, resumedWithJournal: 0, journaledAtStart: 0 };

  // Reference: uninterrupted, same seed, no journal.
  const t0 = Date.now();
  const runner = deterministicRunner({ seed, RunnerError: dynamic.DynamicRunnerError, latency: () => 1 + Math.random() * latencyMs });
  const reference = await execute(dynamic, spec, { runId: `ref-${index}`, runner, limits });
  const refMs = Date.now() - t0;

  const dir = mkdtempSync(join(tmpdir(), 'oar-w1-'));
  const runId = `w1-${opts.seed}-${index}`;
  const journalDir = join(dir, 'journal');
  const journalPath = join(journalDir, `${runId}.jsonl`);
  const invocationLog = join(dir, 'invocations.jsonl');
  writeFileSync(invocationLog, '');
  const crashes = r.int(1, 3);
  let backup;
  let final;
  try {
    for (let proc = 0, crashed = 0; proc < 40; proc++) {
      const planned = crashed < crashes;
      const before = existsSync(journalPath) ? readFileSync(journalPath) : Buffer.alloc(0);
      const oracle = journalOracle(before, runId);
      const selfKill = planned && r.bernoulli(0.35)
        ? { atPut: r.int(1, Math.max(1, reference.agents.filter(a => a.status === 'completed').length)), mode: r.pick(['before', 'microtask', 'immediate', 'timeout0', 'timeout1']) }
        : undefined;
      const cfg = {
        proc, seed, runId, spec, limits, latencyMs, journalDir, invocationLog, selfKill, control: opts.control,
        configPath: join(dir, `cfg-${proc}.json`), resultPath: join(dir, `result-${proc}.json`),
      };
      writeFileSync(cfg.configPath, JSON.stringify(cfg));
      const killAt = planned && !selfKill ? Math.floor(r.next() * (refMs * 1.4 + 150)) : undefined;
      const outcome = await runChild(cfg, killAt);
      out.processes++;
      const invoked = readFileSync(invocationLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.proc === proc);
      if (oracle.refuse) {
        if (invoked.length > 0) out.silent.push({ proc, reason: 'agents ran on a journal that must be refused', line: oracle.line });
      } else {
        for (const { key } of invoked) if (oracle.keys.has(key)) out.reruns.push({ proc, key: key.slice(0, 16) });
        if (oracle.keys.size > 0) { out.resumedWithJournal++; out.journaledAtStart += oracle.keys.size; }
      }
      const result = outcome.result;
      if (outcome.signal === 'SIGKILL') { out.kills++; if (selfKill) out.selfKills++; }
      if (result?.kind === 'recover-failed') {
        // Operator action after an interrupted recovery (see report): remove the stale lock and tombstones.
        out.stuckLocks++;
        out.stuckMessages = [...(out.stuckMessages ?? []), result.message];
        for (const name of readdirSync(journalDir)) if (name.startsWith(`${runId}.lock`)) unlinkSync(join(journalDir, name));
        continue;
      }
      if (result?.kind === 'refused') {
        out.refusals++;
        if (!oracle.refuse) out.falseRefusals.push({ proc, line: result.line });
        else if (result.line !== oracle.line) out.silent.push({ proc, reason: 'refused at another line', expected: oracle.line, got: result.line });
        writeFileSync(journalPath, backup ?? Buffer.alloc(0)); // operator repair
        continue;
      }
      if (oracle.refuse && result?.kind === 'report') out.silent.push({ proc, reason: 'corrupt journal accepted', line: oracle.line });
      if (result?.kind === 'error') { out.errors.push({ proc, name: result.name, message: result.message }); break; }
      if (outcome.signal !== 'SIGKILL' && result?.kind !== 'report') { out.errors.push({ proc, code: outcome.code, stderr: outcome.stderr }); break; }
      if (outcome.signal === 'SIGKILL') crashed++;
      if (result?.kind === 'report' && !planned) { final = result.report; break; }
      // Between processes: sometimes corrupt the journal (only a recoverable one, so a repair can restore it).
      const now = existsSync(journalPath) ? readFileSync(journalPath) : undefined;
      if (now && r.bernoulli(0.5) && !journalOracle(now, runId).refuse) {
        backup = now;
        const mode = corrupt(r, journalPath, runId);
        if (mode) out.corruptions[mode] = (out.corruptions[mode] ?? 0) + 1;
      }
    }
    if (!final) out.errors.push({ reason: 'no final report' });
    else {
      const keyed = report => report.agents.map(a => `${a.key}:${a.status}:${a.error?.code ?? ''}`).sort();
      const fields = {
        result: same(final.result, reference.result), status: final.status === reference.status,
        error: final.error?.code === reference.error?.code, spent: final.spent === reference.spent, agents: same(keyed(final), keyed(reference)),
      };
      const failed = Object.entries(fields).filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length) out.mismatches.push({ fields: failed, refSpent: reference.spent, spent: final.spent, refStatus: reference.status, status: final.status });
      out.cachedFinal = final.agents.filter(a => a.cached).length;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

async function main() {
  const h = hypothesis('W1');
  const opts = flags({ seed: 1, trials: h.minTrials, width: 8 });
  const dynamic = await sdk('orchestration/dynamic');
  const started = Date.now();
  const trials = await pool(opts.trials, opts.width, index => trial(index, opts, dynamic));
  const sum = field => trials.reduce((total, t) => total + (Array.isArray(t[field]) ? t[field].length : t[field]), 0);
  const corruptions = {};
  for (const t of trials) for (const [mode, n] of Object.entries(t.corruptions)) corruptions[mode] = (corruptions[mode] ?? 0) + n;
  const reruns = sum('reruns'), silent = sum('silent') + sum('falseRefusals'), mismatches = sum('mismatches'), errors = sum('errors');
  const examples = trials.filter(t => t.reruns.length || t.silent.length || t.falseRefusals.length || t.mismatches.length || t.errors.length)
    .slice(0, 8).map(t => ({ trial: t.index, kind: t.kind, reruns: t.reruns.slice(0, 3), silent: t.silent.slice(0, 3), falseRefusals: t.falseRefusals.slice(0, 3), mismatches: t.mismatches, errors: t.errors.slice(0, 2) }));
  emit('workflows/resume', [{
    id: 'W1', claim: h.claim,
    ...judgeInvariant(reruns + silent + mismatches + errors, opts.trials),
    counts: {
      reruns, silentCorruptions: sum('silent'), falseRefusals: sum('falseRefusals'), resultMismatches: mismatches, harnessErrors: errors,
      trials: opts.trials, scripts: trials.filter(t => t.kind === 'script').length, plans: trials.filter(t => t.kind === 'plan').length,
      processes: sum('processes'), sigkills: sum('kills'), selfKillsInsidePut: sum('selfKills'), refusalsExpectedAndTyped: sum('refusals') - sum('falseRefusals'),
      corruptionsApplied: corruptions, interruptedRecoveryStuckLocks: sum('stuckLocks'),
      stuckLockMessages: [...new Set(trials.flatMap(t => t.stuckMessages ?? []))],
      processesStartedWithJournaledCalls: sum('resumedWithJournal'), journaledKeysGuardedAtProcessStart: sum('journaledAtStart'),
      cachedReplaysInFinalRuns: trials.reduce((total, t) => total + (t.cachedFinal ?? 0), 0),
    },
    examples,
    assumptions: {
      reference: 'same workflow and seed, run uninterrupted in-process without a journal',
      runner: 'outputs, failures (6%), schema-invalid outputs (15% per attempt) and usage are functions of (seed, prompt); latency 1..25 ms uniform, honours request.signal',
      crashes: '1-3 crashes per trial: parent SIGKILL at uniform(0, 1.4 x reference duration + 150 ms) after spawn, or (35%) the child SIGKILLs itself as the n-th journal put starts (before / microtask / setImmediate / setTimeout 0-1 ms)',
      corruption: 'after a process, with p=0.5 and only on a recoverable journal: one of ' + CORRUPTIONS.join(', '),
      oracle: 'independent re-implementation of the documented line format and torn-tail rule (journal-file.ts header)',
      recovery: 'each process calls inspectOwner + recoverAbandoned (documented operator recovery) after the parent observed the previous process exit',
      repair: 'a refused journal is restored to the copy taken before the corruption (operator repair) and the run continues',
      limits: 'maxAgents 1000 (so LIMIT refusals cannot depend on timing), concurrency 1..6',
    },
    crossCheck: 'none needed: the engine, the file journal and the crashes are all real; only agents are simulated',
  }], { seed: opts.seed, ...(opts.control ? { control: opts.control } : {}), wallMs: Date.now() - started });
}

if (process.argv[2] === '--child') await child(process.argv[3]);
else await main();
