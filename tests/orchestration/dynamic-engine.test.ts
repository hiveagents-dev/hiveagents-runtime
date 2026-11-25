import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDynamicEngine, runWorkflowScript } from '../../src/orchestration/dynamic/engine.js';
import { memoryDynamicJournal } from '../../src/orchestration/dynamic/journal.js';
import type { DynamicAgentResult, DynamicWorkflowContext } from '../../src/orchestration/dynamic/types.js';
import { deferred, fakeRunner, meta, recorder, untilAborted, usage } from './dynamic-engine-fixture.js';

afterEach(() => { vi.useRealTimers(); });

describe('dynamic workflow engine: keys and resume', () => {
  it('derives deterministic keys, distinct for duplicate calls and independent of labels and defaults', async () => {
    const keys = async (labelled: boolean) => {
      const collected: string[] = [];
      await runWorkflowScript(meta, async context => {
        for (const options of [{}, { permissions: 'analyze' as const }, labelled ? { label: 'third' } : {}]) {
          collected.push((await context.agentResult('same prompt', options)).key);
        }
        collected.push((await context.agentResult('other prompt')).key);
        return null;
      }, { runId: 'keys', runner: fakeRunner().runner });
      return collected;
    };
    const first = await keys(false);
    expect(await keys(false)).toEqual(first);
    expect(await keys(true)).toEqual(first);
    expect(new Set(first).size).toBe(4);
    for (const key of first) expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('replays completed calls from the journal without running them and re-runs failed ones', async () => {
    const journal = memoryDynamicJournal();
    const script = async (context: DynamicWorkflowContext) =>
      context.parallel(['a', 'b', 'c'].map(prompt => () => context.agent(prompt)));
    const failing = fakeRunner(request => {
      if (request.prompt === 'b') throw new Error('provider exploded');
      return { text: `first:${request.prompt}`, usage: usage(5, 5) };
    });
    const first = await runWorkflowScript(meta, script, { runId: 'resume', runner: failing.runner, journal });
    expect(first.result).toEqual(['first:a', null, 'first:c']);
    expect(first.agents.map(agent => agent.status)).toEqual(['completed', 'failed', 'completed']);

    const second = fakeRunner(request => ({ text: `second:${request.prompt}` }));
    const resumed = await runWorkflowScript(meta, script, { runId: 'resume', runner: second.runner, journal });
    expect(second.prompts).toEqual(['b']);
    expect(resumed.result).toEqual(['first:a', 'second:b', 'first:c']);
    expect(resumed.agents.map(agent => agent.cached)).toEqual([true, false, true]);
    expect(resumed.agents.map(agent => agent.key)).toEqual(first.agents.map(agent => agent.key));
    expect(resumed.spent).toBe(20); // replayed usage counts toward the run's spend
  });

  it('keys identical concurrent calls by call order, whatever order they finish in', async () => {
    const journal = memoryDynamicJournal();
    let started = 0, finished = 0;
    const script = async (context: DynamicWorkflowContext) => context.parallel([0, 1, 2].map(() => () => context.agent('same')));
    const reversed = fakeRunner(async () => {
      await new Promise(resolve => setTimeout(resolve, 30 - 10 * started++));
      return { text: `finished-${finished++}` };
    });
    const first = await runWorkflowScript(meta, script, { runId: 'dupes', runner: reversed.runner, journal });
    expect(first.result).toEqual(['finished-2', 'finished-1', 'finished-0']);
    const resumed = await runWorkflowScript(meta, script, { runId: 'dupes', runner: fakeRunner().runner, journal });
    expect(resumed.result).toEqual(first.result);
    expect(resumed.agents.every(agent => agent.cached)).toBe(true);
  });

  it('fails a call whose result cannot be journaled and reports the run as failed with JOURNAL', async () => {
    const journal = { get: async () => undefined, put: async () => { throw new Error('disk full'); } };
    const report = await runWorkflowScript(meta, async context => context.agent('a'), { runId: 'journal-put', runner: fakeRunner().runner, journal });
    expect(report.result).toBeNull();
    expect(report.agents[0]!.error?.code).toBe('JOURNAL');
    expect(report).toMatchObject({ status: 'failed', error: { code: 'JOURNAL' } });
  });
});

describe('dynamic workflow engine: limits', () => {
  it('bounds concurrent agent calls by the run concurrency', async () => {
    const fake = fakeRunner(async request => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { text: request.prompt };
    });
    const report = await runWorkflowScript(meta, async context =>
      context.parallel(Array.from({ length: 7 }, (_, index) => () => context.agent(`p${index}`))),
    { runId: 'concurrency', runner: fake.runner, limits: { concurrency: 2 } });
    expect(report.status).toBe('completed');
    expect(fake.calls).toHaveLength(7);
    expect(fake.peak).toBe(2);
  });

  it('refuses calls beyond maxAgents with LIMIT without running them', async () => {
    const fake = fakeRunner();
    const report = await runWorkflowScript(meta, async context =>
      [await context.agent('a'), await context.agent('b'), await context.agent('c')],
    { runId: 'max-agents', runner: fake.runner, limits: { maxAgents: 2 } });
    expect(fake.prompts).toEqual(['a', 'b']);
    expect(report.result).toEqual(['done:a', 'done:b', null]);
    expect(report.agents[2]!.error?.code).toBe('LIMIT');
    expect(report.status).toBe('completed');
  });

  it('spends input + output tokens, refuses calls once the budget is spent and reports budget-exhausted', async () => {
    const fake = fakeRunner(() => ({ text: 'ok', usage: usage(30, 30, { cachedInputTokens: 1000 }) }));
    const seen: Array<number | undefined> = [];
    const report = await runWorkflowScript(meta, async context => {
      const results = [];
      for (const prompt of ['a', 'b', 'c']) {
        results.push(await context.agent(prompt));
        seen.push(context.budget.remaining());
      }
      return results;
    }, { runId: 'budget', runner: fake.runner, limits: { tokens: 100 } });
    expect(fake.prompts).toEqual(['a', 'b']);
    expect(seen).toEqual([40, 0, 0]);
    expect(report.spent).toBe(120);
    expect(report.status).toBe('budget-exhausted');
    expect(report.error?.code).toBe('BUDGET');
    expect(report.result).toEqual(['ok', 'ok', null]);
    expect(report.agents[2]!.error?.code).toBe('BUDGET');
  });

  it('refuses parallel and pipeline beyond maxItems before running anything', async () => {
    const fake = fakeRunner();
    let started = 0;
    const errors: unknown[] = [];
    await runWorkflowScript(meta, async context => {
      await context.parallel([1, 2, 3, 4].map(() => async () => { started++; return context.agent('x'); })).catch(error => errors.push(error));
      await context.pipeline([1, 2, 3, 4], async () => { started++; }).catch(error => errors.push(error));
      return null;
    }, { runId: 'items', runner: fake.runner, limits: { maxItems: 3 } });
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toBeInstanceOf(TypeError);
    expect(started).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('dynamic workflow engine: parallel and pipeline', () => {
  it('parallel turns a rejected thunk into null', async () => {
    const report = await runWorkflowScript(meta, async context => context.parallel([
      async () => 1, async () => { throw new Error('boom'); }, () => context.agent('a'),
    ]), { runId: 'parallel', runner: fakeRunner().runner });
    expect(report.result).toEqual([1, null, 'done:a']);
  });

  it('pipeline flows items independently (no barrier) and a throwing stage nulls that item only', async () => {
    const firstReachedStageTwo = deferred();
    const stageTwo: number[] = [];
    const report = await runWorkflowScript(meta, async context => context.pipeline([0, 1, 2],
      async (item: number) => {
        // Item 1 cannot leave stage one until item 0 has reached stage two: a barrier would deadlock.
        if (item === 1) await firstReachedStageTwo.promise;
        if (item === 2) throw new Error('bad item');
        return item * 10;
      },
      async (value: number, item: number, index: number) => {
        if (item === 0) firstReachedStageTwo.resolve();
        stageTwo.push(index);
        return value + 1;
      },
    ) as never, { runId: 'pipeline', runner: fakeRunner().runner });
    expect(report.result).toEqual([1, 11, null]);
    expect(stageTwo).toEqual([0, 1]);
  });
});

describe('dynamic workflow engine: structured output', () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

  it('validates structured output, falls back to JSON text, and re-asks with bounded schema feedback', async () => {
    let attempt = 0;
    const fake = fakeRunner(request => {
      if (request.prompt.startsWith('text')) return { text: '{"answer":"from text"}' };
      attempt++;
      return attempt === 1
        ? { text: 'raw', output: { wrong: true }, usage: usage(1, 2) }
        : { text: 'raw', output: { answer: 'fixed' }, usage: usage(3, 4) };
    });
    const report = await runWorkflowScript(meta, async context => [
      await context.agent('text please', { schema }),
      (await context.agentResult('retry please', { schema })) as unknown as DynamicAgentResult,
    ] as never, { runId: 'schema', runner: fake.runner });
    const [fromText, retried] = report.result as [unknown, DynamicAgentResult];
    expect(fromText).toEqual({ answer: 'from text' });
    expect(retried.output).toEqual({ answer: 'fixed' });
    expect(retried.usage).toMatchObject({ inputTokens: 4, outputTokens: 6 });
    expect(fake.calls).toHaveLength(3);
    const feedback = fake.prompts[2]!;
    expect(feedback.startsWith('retry please\n\n[Structured output check]')).toBe(true);
    expect(feedback).toContain("must have required property 'answer'");
    expect(feedback).not.toContain('raw');
    expect(fake.calls[2]!.key).toBe(fake.calls[1]!.key);
  });

  it('fails with SCHEMA after the retries, which count as one call against maxAgents', async () => {
    const fake = fakeRunner(request => ({ text: request.prompt === 'next' ? 'next done' : 'provider secret prose' }));
    const report = await runWorkflowScript(meta, async context =>
      [await context.agent('never valid', { schema }), await context.agent('next'), await context.agent('third')],
    { runId: 'schema-fail', runner: fake.runner, limits: { schemaRetries: 1, maxAgents: 2 } });
    expect(fake.calls).toHaveLength(3);
    expect(report.result).toEqual([null, 'next done', null]);
    expect(report.agents[0]!.error).toEqual({ code: 'SCHEMA', message: 'The structured output did not match the schema after 2 attempt(s)' });
    expect(report.agents[1]!.status).toBe('completed');
    expect(report.agents[2]!.error?.code).toBe('LIMIT');
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});

describe('dynamic workflow engine: failures, timeouts and abort', () => {
  it('turns runner failures into bounded SDK errors and never rejects', async () => {
    class ProviderQuotaError extends Error { override name = 'ProviderQuotaError'; }
    const fake = fakeRunner(request => {
      if (request.prompt === 'a') throw new Error('provider text: secret');
      throw new ProviderQuotaError('provider text: secret');
    });
    const report = await runWorkflowScript(meta, async context => [await context.agent('a'), await context.agent('b')],
      { runId: 'runner-errors', runner: fake.runner });
    expect(report.status).toBe('completed');
    expect(report.agents.map(agent => agent.error)).toEqual([
      { code: 'AGENT_ERROR', message: 'The agent run failed' },
      { code: 'AGENT_ERROR', message: 'The agent run failed (ProviderQuotaError)' },
    ]);
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('times out an attempt through its signal and fails it with TIMEOUT', async () => {
    vi.useFakeTimers();
    const fake = fakeRunner(request => untilAborted(request));
    const pending = runWorkflowScript(meta, async context => context.agent('slow', { timeoutMs: 1000 }),
      { runId: 'timeout', runner: fake.runner });
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;
    expect(report.result).toBeNull();
    expect(report.agents[0]!.error).toEqual({ code: 'TIMEOUT', message: 'The agent call exceeded its 1000 ms timeout' });
  });

  it('aborts in-flight calls, skips pending ones and reports aborted', async () => {
    const controller = new AbortController();
    const events = recorder();
    const fake = fakeRunner(request => {
      queueMicrotask(() => controller.abort());
      return untilAborted(request);
    });
    const report = await runWorkflowScript(meta, async context =>
      context.parallel([() => context.agent('a'), () => context.agent('b')]),
    { runId: 'abort', runner: fake.runner, signal: controller.signal, limits: { concurrency: 1 }, onEvent: events.onEvent });
    expect(fake.prompts).toEqual(['a']);
    expect(report.status).toBe('aborted');
    expect(report.agents.map(agent => [agent.status, agent.error?.code])).toEqual([['failed', 'ABORTED'], ['skipped', 'ABORTED']]);
    expect(events.types().at(-1)).toBe('run.finished');
  });

  it('skips agent calls made through a context kept past the end of its run', async () => {
    const fake = fakeRunner();
    let kept: DynamicWorkflowContext | undefined;
    const report = await runWorkflowScript(meta, async context => { kept = context; return null; },
      { runId: 'kept-context', runner: fake.runner, journal: memoryDynamicJournal() });
    expect(report.status).toBe('completed');
    expect((await kept!.agentResult('late')).status).toBe('skipped');
    expect(fake.calls).toHaveLength(0);
  });

  it('runs nothing when the signal is already aborted', async () => {
    const script = vi.fn(async () => null);
    const report = await runWorkflowScript(meta, script, { runId: 'pre-aborted', runner: fakeRunner().runner, signal: AbortSignal.abort() });
    expect(script).not.toHaveBeenCalled();
    expect(report).toMatchObject({ status: 'aborted', result: null, agents: [] });
  });

  it('reports a throwing script as SCRIPT_ERROR without its text and aborts the calls it left running', async () => {
    const fake = fakeRunner(request => untilAborted(request));
    const report = await runWorkflowScript(meta, async context => {
      void context.agent('left running');
      await Promise.resolve();
      throw new Error('provider said: secret');
    }, { runId: 'script-error', runner: fake.runner });
    expect(report.status).toBe('failed');
    expect(report.error).toEqual({ code: 'SCRIPT_ERROR', message: 'The workflow script threw' });
    expect(report.agents[0]!.error?.code).toBe('ABORTED');
  });

  it('reports engine usage errors with their message and a non-JSON result as SCRIPT_ERROR', async () => {
    const runner = fakeRunner().runner;
    const unknownPhase = await runWorkflowScript({ ...meta, phases: [{ title: 'Scan' }] }, async context => {
      context.phase('Other');
      return null;
    }, { runId: 'usage', runner });
    expect(unknownPhase.error?.message).toBe('The workflow script failed: Phase "Other" is not declared in meta.phases');
    const nonJson = await runWorkflowScript(meta, async () => ({ when: new Date(0) }) as never, { runId: 'non-json', runner });
    expect(nonJson).toMatchObject({ status: 'failed', result: null, error: { code: 'SCRIPT_ERROR' } });
  });
});

describe('dynamic workflow engine: validation, events, isolation and launch', () => {
  it('requires unique labels, declared phases, allowed permissions and configured isolation', async () => {
    const errors: unknown[] = [];
    await runWorkflowScript({ ...meta, phases: [{ title: 'Scan' }] }, async context => {
      await context.agent('a', { label: 'one' });
      await context.agent('b', { label: 'one' }).catch(error => errors.push(error));
      await context.agent('c', { phase: 'Nope' }).catch(error => errors.push(error));
      await context.agent('d', { permissions: 'edit' }).catch(error => errors.push(error));
      await context.agent('e', { isolation: 'worktree' }).catch(error => errors.push(error));
      await context.agent('f', { model: 'unlisted' }).catch(error => errors.push(error));
      await context.agent('g', { timeoutMs: 15 * 60_000 + 1 }).catch(error => errors.push(error));
      return null;
    }, { runId: 'validation', runner: fakeRunner().runner });
    expect(errors).toHaveLength(6);
    for (const error of errors) expect(error).toBeInstanceOf(TypeError);
  });

  it('emits events in order and swallows observer failures', async () => {
    const events = recorder();
    const report = await runWorkflowScript({ ...meta, phases: [{ title: 'Scan' }] }, async context => {
      context.phase('Scan');
      context.log('starting');
      return context.agent('a', { label: 'A' });
    }, {
      runId: 'events', runner: fakeRunner(() => ({ text: 'ok', usage: usage(1, 1) })).runner,
      onEvent: event => { events.onEvent(event); throw new Error('observer failed'); },
    });
    expect(report.status).toBe('completed');
    expect(events.types()).toEqual(['run.started', 'phase.started', 'log', 'agent.started', 'budget', 'agent.finished', 'run.finished']);
    expect(events.events[3]).toMatchObject({ label: 'A', phase: 'Scan' });
    expect(events.events[6]).toMatchObject({ status: 'completed', agents: 1, spent: 2 });
  });

  it('runs an isolated agent in its worktree and reports whether it changed', async () => {
    const created: unknown[] = [];
    const isolation = {
      async create(request: { runId: string; key: string; label?: string }) { created.push(request.label); return { path: '/tmp/wt-1', branch: 'dw/1' }; },
      async inspect() { return { changed: true }; },
    };
    const fake = fakeRunner();
    const report = await runWorkflowScript(meta, async context => context.agent('edit it', { isolation: 'worktree', label: 'W' }),
      { runId: 'isolation', runner: fake.runner, isolation, limits: { permissions: 'edit' } });
    expect(created).toEqual(['W']);
    expect(fake.calls[0]!.cwd).toBe('/tmp/wt-1');
    expect(report.agents[0]!.worktree).toEqual({ path: '/tmp/wt-1', branch: 'dw/1', changed: true });
  });

  it('holds an engine launch gate around each agent and fails the call with LAUNCH when refused', async () => {
    let held = 0, acquired = 0;
    const engine = createDynamicEngine({ launch: { async acquire() {
      if (++acquired === 2) throw new Error('host cap');
      held++;
      return { release() { held--; } };
    } } });
    const report = await engine(meta, async context => [await context.agent('a'), await context.agent('b')],
      { runId: 'launch', runner: fakeRunner().runner });
    expect(held).toBe(0);
    expect(report.result).toEqual(['done:a', null]);
    expect(report.agents[1]!.error).toEqual({ code: 'LAUNCH', message: 'The launch gate refused the agent call' });
  });

  it('rejects invalid run options and meta with TypeError', async () => {
    const runner = fakeRunner().runner;
    const script = async () => null;
    await expect(runWorkflowScript(meta, script, { runId: '../escape', runner })).rejects.toThrow(TypeError);
    await expect(runWorkflowScript({ ...meta, phases: [{ title: 'A' }, { title: 'A' }] }, script, { runId: 'ok', runner })).rejects.toThrow(TypeError);
    await expect(runWorkflowScript(meta, script, { runId: 'ok', runner, limits: { concurrency: 17 } })).rejects.toThrow(TypeError);
    await expect(runWorkflowScript(meta, script, { runId: 'ok', runner, args: { bad: undefined } as never })).rejects.toThrow(TypeError);
    await expect(runWorkflowScript(meta, script, { runId: 'ok', runner, extra: 1 } as never)).rejects.toThrow(TypeError);
    await expect(runWorkflowScript(meta, script, { runId: 'ok', runner: {} as never })).rejects.toThrow(TypeError);
  });
});
