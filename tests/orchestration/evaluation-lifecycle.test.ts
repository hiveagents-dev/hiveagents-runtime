import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEvaluation, validateEvaluationReport } from '../../src/orchestration/evaluation/index.js';
import { finishReport } from '../../src/orchestration/evaluation/report.js';
import type { EvaluationTraceWriter, RunEvaluationOptions } from '../../src/orchestration/evaluation/types.js';

const directories: string[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
const base = (): RunEvaluationOptions => ({
  id: 'lifecycle', suite: { id: 'suite', version: '1', cases: [{ id: 'one', input: true, expected: true }, { id: 'two', input: true, expected: true }] },
  profile: { id: 'local', version: '1', sourceDigest: 'a'.repeat(64) },
  execute: input => ({ output: input }), scorers: [{ id: 'exact', version: '1', score: (output, expected) => ({ value: Number(output === expected), passed: output === expected }) }],
});
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true }))); });

describe('evaluation process and terminal lifecycle', () => {
  it('keeps the deadline alive in standalone Node while execution waits only for abort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oar-evaluation-deadline-')); directories.push(directory);
    const compiled = join(directory, 'evaluation.mjs');
    await build({ entryPoints: ['src/orchestration/evaluation/index.ts'], outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
    const program = `
      import { runEvaluation } from ${JSON.stringify(pathToFileURL(compiled).href)};
      let released = false;
      const report = await runEvaluation({
        id: 'child', suite: { id: 'suite', version: '1', cases: [{ id: 'one', input: true, expected: true }] },
        profile: { id: 'local', version: '1', sourceDigest: '${'a'.repeat(64)}' }, timeoutMs: 25,
        budget: { acquire() { return { release() { released = true; } }; } },
        execute(_input, context) { return new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ output: true }), { once: true })); },
        scorers: [{ id: 'exact', version: '1', score() { return { value: 1, passed: true }; } }],
      });
      console.log(JSON.stringify({ status: report.attempts[0].status, released }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8', timeout: 3000 });
    expect({ status: child.status, signal: child.signal, stderr: child.stderr, error: child.error }).toMatchObject({ status: 0, signal: null });
    expect(JSON.parse(child.stdout.trim())).toEqual({ status: 'timed-out', released: true });
  });

  it.each([
    ['deadline', 'evaluation.attempt.completed'], ['parent-abort', 'evaluation.attempt.completed'],
    ['deadline', 'evaluation.completed'], ['parent-abort', 'evaluation.completed'],
  ] as const)('reconciles %s during slow %s and drains its corrective terminal record', async (cause, delayedType) => {
    vi.useFakeTimers();
    const controller = new AbortController(), entered = deferred(), finish = deferred(), correcting = deferred(), corrected = deferred();
    const events: Parameters<EvaluationTraceWriter['append']>[0][] = [];
    const release = vi.fn(); let executions = 0, waiting = false;
    const options = base(); if (delayedType === 'evaluation.completed') options.suite.cases = options.suite.cases.slice(0, 1);
    const running = runEvaluation({ ...options, timeoutMs: 10, signal: controller.signal,
      budget: { acquire: () => ({ release }) }, execute: input => { executions++; return { output: input }; },
      trace: { async append(event) {
        events.push({ ...event });
        if (event.type === delayedType && !waiting) { waiting = true; entered.resolve(); await finish.promise; }
        if (event.type === 'evaluation.attempt.corrected') { correcting.resolve(); await corrected.promise; }
      } },
    });
    await entered.promise;
    if (cause === 'parent-abort') controller.abort();
    await vi.advanceTimersByTimeAsync(11);
    expect(release).not.toHaveBeenCalled(); expect(executions).toBe(1);
    finish.resolve();
    const next = await Promise.race([running.then(() => 'returned'), correcting.promise.then(() => 'correcting')]);
    expect(next).toBe('correcting');
    expect(release).not.toHaveBeenCalled(); expect(executions).toBe(1);
    await vi.advanceTimersByTimeAsync(20); expect(release).not.toHaveBeenCalled();
    corrected.resolve(); const report = await running;
    const attempt = report.attempts[0]!;
    const final = events.filter(event => event.phaseId === attempt.id && ['evaluation.attempt.completed', 'evaluation.attempt.corrected'].includes(event.type)).at(-1);
    expect(final).toMatchObject({ type: 'evaluation.attempt.corrected', status: attempt.status, code: attempt.failure?.code });
    expect(attempt.status).toBe(cause === 'deadline' ? 'timed-out' : 'cancelled');
    expect(executions).toBe(cause === 'parent-abort' || delayedType === 'evaluation.completed' ? 1 : 2);
    expect(release).toHaveBeenCalledTimes(executions);
    expect(validateEvaluationReport(report)).toEqual(report); expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a budget denial scheduling stop when terminal tracing exceeds its deadline', async () => {
    vi.useFakeTimers(); const entered = deferred(), finish = deferred(); let waited = false;
    const acquire = vi.fn(() => { throw new Error('denied'); }), execute = vi.fn();
    const running = runEvaluation({ ...base(), timeoutMs: 10, budget: { acquire }, execute,
      trace: { async append(event) { if (event.type === 'evaluation.attempt.completed' && !waited) { waited = true; entered.resolve(); await finish.promise; } } },
    });
    await entered.promise; await vi.advanceTimersByTimeAsync(11); finish.resolve(); const report = await running;
    expect(acquire).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.status).toBe('timed-out');
    expect(report.metrics.denials).toBe(1);
    expect(report.attempts[0]).toMatchObject({ admitted: false, budgetDenied: true });
    expect(validateEvaluationReport(report)).toEqual(report);
  });
  it('closes event submission before terminal tracing so late detached calls cannot start hidden writes', async () => {
    const entered = deferred(), finish = deferred(), observe = vi.fn(async () => {});
    let recordEvent!: Parameters<RunEvaluationOptions['execute']>[1]['recordEvent'];
    const options = base(); options.suite.cases = options.suite.cases.slice(0, 1);
    const running = runEvaluation({ ...options, execute(input, context) { recordEvent = context.recordEvent; return { output: input }; },
      trace: { observe, async append(event) { if (event.type === 'evaluation.attempt.completed') { entered.resolve(); await finish.promise; } } },
    });
    await entered.promise;
    const late = recordEvent({ type: 'message.delta', text: 'detached-late-content' }).then(() => 'accepted', () => 'closed');
    finish.resolve(); await running;
    expect(await late).toBe('closed'); expect(observe).not.toHaveBeenCalled();
  });
  it('treats a rejected corrective terminal write as fatal and stops all later attempts', async () => {
    const controller = new AbortController(), failure = new Error('corrective store unavailable'), release = vi.fn(); let calls = 0;
    await expect(runEvaluation({ ...base(), signal: controller.signal, budget: { acquire: () => ({ release }) },
      execute: input => { calls++; return { output: input }; },
      trace: { async append(event) {
        if (event.type === 'evaluation.attempt.completed') controller.abort();
        if (event.type === 'evaluation.attempt.corrected') throw failure;
      } },
    })).rejects.toBe(failure);
    expect(calls).toBe(1); expect(release).toHaveBeenCalledOnce();
  });
  it('rejects forged budget denial causality on an admitted successful attempt', async () => {
    const report = await runEvaluation(base());
    const { digest: _digest, metrics: _metrics, usage: _usage, ...body } = JSON.parse(JSON.stringify(report)) as typeof report;
    body.attempts[0]!.budgetDenied = true;
    expect(() => validateEvaluationReport(finishReport(body))).toThrow(/budget rejection/);
  });
});
