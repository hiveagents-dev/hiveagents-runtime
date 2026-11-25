import { describe, expect, it, vi } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import { createDynamicEngine, runWorkflowScript } from '../../src/orchestration/dynamic/engine.js';
import { agentRunner } from '../../src/orchestration/dynamic/agent-runner.js';
import type { DynamicAgentRequest, JsonValue } from '../../src/orchestration/dynamic/types.js';
import { runEvaluation } from '../../src/orchestration/evaluation/index.js';
import type { RunEvaluationOptions } from '../../src/orchestration/evaluation/types.js';
import { ExecutionHaltedError, isExecutionHalted } from '../../src/public/execution-halt.js';
import { RecordingExec } from '../unit/memory.fixture.js';
import { deferred, fakeRunner, meta, recorder, untilAborted, usage } from './dynamic-engine-fixture.js';

// Found by the multi-model council review (2026-11-17). ExecutionHaltedError means a
// failed infrastructure boundary: execution, selection and dependent retries must stop.
// The static WorkflowRunner already honours that; these engines did not.

const halted = () => new ExecutionHaltedError({ provider: 'claude' });

describe('dynamic orchestration', () => {
  it('stops dispatching after a halt and rejects the run with the halt', async () => {
    const fake = fakeRunner(request => {
      if (request.prompt === 'first') throw halted();
      return { text: 'should not run' };
    });
    const run = runWorkflowScript(meta, async context => {
      const first = await context.agentResult('first');
      const second = await context.agentResult('second');
      return { first: first.status, second: second.status };
    }, { runId: 'halt-sequential', runner: fake.runner });
    const error = await run.then(() => undefined, (failure: unknown) => failure);
    expect(isExecutionHalted(error)).toBe(true);
    expect(fake.prompts).toEqual(['first']);
  });

  it('cancels sibling calls still in flight when one call halts', async () => {
    const sibling = deferred();
    let siblingSignal: AbortSignal | undefined;
    const fake = fakeRunner(async request => {
      if (request.prompt === 'halts') { await sibling.promise; throw halted(); }
      siblingSignal = request.signal; sibling.resolve();
      return untilAborted(request);
    });
    const run = runWorkflowScript(meta, context => context.parallel([
      () => context.agentResult('halts'),
      () => context.agentResult('sibling'),
    ]).then(() => null), { runId: 'halt-parallel', runner: fake.runner, limits: { concurrency: 2 } });
    const error = await run.then(() => undefined, (failure: unknown) => failure);
    expect(isExecutionHalted(error)).toBe(true);
    expect(siblingSignal?.aborted).toBe(true);
  });

  it.each(['acquire', 'release'] as const)('stops further dispatch when the launch gate halts in %s', async stage => {
    const fake = fakeRunner();
    const error = halted();
    const { events, onEvent } = recorder();
    const run = createDynamicEngine({ launch: { async acquire() {
      if (stage === 'acquire') throw error;
      return { async release() { throw error; } };
    } } });
    const journal = { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
    await expect(run(meta, async context => {
      await context.agentResult('first');
      await context.agentResult('second');
      return null;
    }, { runId: 'gate-halt', runner: fake.runner, onEvent, journal })).rejects.toBe(error);
    expect(fake.prompts).toEqual(stage === 'acquire' ? [] : ['first']);
    expect(journal.put).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' });
  });

  it('halts if the gate cannot confirm release and preserves the failure as its cause', async () => {
    const fake = fakeRunner();
    const failure = new Error('fixture release failure');
    const run = createDynamicEngine({ launch: { async acquire() {
      return { async release() { throw failure; } };
    } } });
    const outcome = await run(meta, async context => {
      await context.agentResult('first');
      await context.agentResult('second');
      return null;
    }, { runId: 'unknown-release', runner: fake.runner }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ExecutionHaltedError);
    expect(outcome).toHaveProperty('cause', failure);
    expect(fake.prompts).toEqual(['first']);
  });

  it('keeps the window slot and waits for asynchronous release before reporting success', async () => {
    const releasing = deferred(), settled = deferred();
    const release = vi.fn(async () => { releasing.resolve(); await settled.promise; });
    const fake = fakeRunner();
    const run = createDynamicEngine({ launch: { async acquire() { return { release }; } } });
    let finished = false;
    const running = run(meta, async context => {
      await Promise.all([context.agentResult('first'), context.agentResult('second')]);
      return null;
    }, { runId: 'async-release', runner: fake.runner, limits: { concurrency: 1 } });
    void running.then(() => { finished = true; });
    try {
      await releasing.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(fake.prompts).toEqual(['first']);
      expect(finished).toBe(false);
    } finally { settled.resolve(); await running; }
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('discards a late reply while retaining its reported usage', async () => {
    const fake = fakeRunner(async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { text: 'late', usage: usage(3, 4) };
    });
    const report = await runWorkflowScript(meta, async context => {
      const result = await context.agentResult('first');
      return { error: result.error?.code ?? null, output: result.output };
    }, { runId: 'late-reply', runner: fake.runner, limits: { agentTimeoutMs: 20 } });
    expect(report.result).toEqual({ error: 'TIMEOUT', output: null });
    expect(report.spent).toBe(7);
  });

  it('preserves a late exec halt and holds capacity until the adapter has settled', async () => {
    const started = deferred(), aborted = deferred(), settle = deferred();
    const stop = new AbortController(), error = halted();
    const exec = new RecordingExec();
    exec.executeImpl = async request => {
      request.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await settle.promise;
      throw error;
    };
    const release = vi.fn();
    const run = createDynamicEngine({ launch: { async acquire() { return { release }; } } });
    const running = run(meta, async context => {
      await context.agentResult('first');
      return null;
    }, { runId: 'exec-settlement', signal: stop.signal,
      runner: agentRunner({ agent: { model: 'opus-5' }, runtime: new Runtime({ adapters: [exec] }) }) });
    const outcome = running.catch((failure: unknown) => failure);
    try {
      await started.promise;
      stop.abort();
      await aborted.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
    } finally { settle.resolve(); await outcome; }
    expect(await outcome).toBe(error);
    expect(release).toHaveBeenCalledOnce();
  });

  it('the bundled agent runner passes a halt through instead of a provider failure', async () => {
    const exec = new RecordingExec();
    exec.executeImpl = async () => { throw halted(); };
    const runner = agentRunner({ agent: { model: 'opus-5' }, runtime: new Runtime({ adapters: [exec] }) });
    const request: DynamicAgentRequest = {
      runId: 'run-1', key: 'k1', prompt: 'p', options: { permissions: 'analyze' }, signal: new AbortController().signal,
    };
    const error = await runner.run(request).then(() => undefined, (failure: unknown) => failure);
    expect(isExecutionHalted(error)).toBe(true);
  });
});

describe('evaluation', () => {
  const options = (execute: RunEvaluationOptions['execute']): RunEvaluationOptions => ({
    id: 'run', suite: { id: 'suite', version: '1', cases: [{ id: 'one', input: 1, expected: 1 }, { id: 'two', input: 2, expected: 2 }] },
    profile: { id: 'local', version: '1', sourceDigest: 'a'.repeat(64) }, repetitions: 2, execute,
    scorers: [{ id: 'exact', version: '1', score: (output, expected) => ({ value: Number(output === expected), passed: output === expected }) }],
  });

  it('stops all remaining attempts and rejects when execution halts', async () => {
    const execute = vi.fn(() => { throw halted(); });
    const error = await runEvaluation(options(execute)).then(() => undefined, (failure: unknown) => failure);
    expect(isExecutionHalted(error)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('treats a halt raised by a scorer the same way', async () => {
    const execute = vi.fn((input: JsonValue) => ({ output: input }));
    const run = options(execute);
    run.scorers = [{ id: 'exact', version: '1', score: () => { throw halted(); } }];
    const error = await runEvaluation(run).then(() => undefined, (failure: unknown) => failure);
    expect(isExecutionHalted(error)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});
