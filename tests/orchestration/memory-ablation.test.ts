import { describe, expect, it } from 'vitest';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import { runMemoryAblation } from '../../src/orchestration/memory/ablation.js';
import type {
  AblationAgent, AblationCondition, AblationTask, MemoryAblationOptions,
} from '../../src/orchestration/memory/ablation.js';
import type { MemoryOption } from '../../src/public/memory-types.js';
import type { Turn } from '../../src/public/types.js';
import { RecordingExec, item, profileProvider, recordingProvider } from '../unit/memory.fixture.js';
import { completedTurn, hanging } from './memory-agent-fixture.js';

const SCOPE = { tenant: 'acme', namespace: 'support', subject: 'c-42' };
const DECOY = { tenant: 'acme', namespace: 'gardening' };
/** A fake Agent whose turn passes when the memory note recalled an item named `good`. */
function fakeAgents(behaviour: (memory: MemoryOption | false, task: string) => Promise<Turn> | Turn) {
  const built: { memory: MemoryOption | false; closed: boolean }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const makeAgent: MemoryAblationOptions['makeAgent'] = (memory, { taskId }) => {
    const record = { memory, closed: false };
    built.push(record);
    const agent: AblationAgent = {
      send: (async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise(resolve => setTimeout(resolve, 1));
          return await behaviour(memory, taskId);
        } finally {
          inFlight -= 1;
        }
      }) as AblationAgent['send'],
      close: async () => { record.closed = true; },
    };
    return agent;
  };
  return { built, makeAgent, maxInFlight: () => maxInFlight };
}

const tasks = (count: number, check: AblationTask['check'] = turn => turn.text === 'right'): AblationTask[] =>
  Array.from({ length: count }, (_, index) => ({ id: `task-${index + 1}`, input: `question ${index + 1}`, check }));

describe('runMemoryAblation', () => {
  it('runs real Agents: the irrelevant condition recalls another scope of the same store, and nothing is captured', async () => {
    const provider = recordingProvider(async request => (request.scope.namespace === 'support'
      ? [item('good-1', 'The client pays in pesos (secret recalled text).')]
      : [item('decoy-1', 'Water the tomatoes twice a week.')]));
    const exec = new RecordingExec();
    exec.executeImpl = async request => ({
      completed: true, failed: false, refused: false, sessionId: 's', events: [], nativeEvents: [],
      text: request.prompt.includes('pesos') ? 'right' : 'wrong',
      usage: { inputTokens: 10, outputTokens: 2, costMeaning: 'estimate' },
    });
    const runtime = new Runtime({ adapters: [exec] });
    const agents: Agent[] = [];
    let closed = 0;
    const report = await runMemoryAblation({
      id: 'support-ablation', tasks: tasks(5), irrelevantScope: DECOY,
      memory: { provider, scope: SCOPE, capture: true },
      makeAgent: memory => {
        const agent = new Agent({ model: 'opus-5', memory }, runtime);
        const close = agent.close.bind(agent);
        agent.close = async () => { closed += 1; await close(); };
        agents.push(agent);
        return agent;
      },
    });

    expect(report).toMatchObject({ verdict: 'helps', reason: 'GAIN', deltas: { onVsOff: 1, irrelevantVsOff: 0, onVsIrrelevant: 1 } });
    // Format 2: the verdict is a paired sign test, and the report carries its counts and p-values.
    expect(report).toMatchObject({
      format: 2, rule: { minTasks: 5, maxErrorRate: 0.25, margin: 0.2, alpha: 0.05 },
      tests: {
        onVsOff: { better: 5, worse: 0, ties: 0, pBetter: 1 / 32, pWorse: 1 },
        onVsIrrelevant: { better: 5, worse: 0, ties: 0, pBetter: 1 / 32, pWorse: 1 },
      },
    });
    expect(report.conditions.on).toMatchObject({ runs: 5, passed: 5, recalledItems: 5, inputTokens: 50, outputTokens: 10 });
    expect(report.conditions.off.recalledItems).toBe(0);
    expect(provider.recalls.map(request => request.scope.namespace)).toEqual(Array(5).fill(['support', 'gardening']).flat());
    expect(provider.captures).toEqual([]);
    expect(closed).toBe(15);
    const irrelevant = report.runs.find(run => run.condition === 'irrelevant')!;
    expect(irrelevant.memory).toMatchObject({ status: 'recalled', items: [{ id: 'decoy-1', source: 'test-memory' }] });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('pesos');
    expect(serialized).not.toContain('tomatoes');
    expect(serialized).not.toContain('question');
    expect(JSON.parse(serialized)).toEqual(report);
  });

  it('builds every run its own Agent, hands each condition its memory, and closes all of them', async () => {
    const decoy = recordingProvider([item('decoy', 'unrelated')]);
    const memory: MemoryOption = { provider: recordingProvider([item('good', 'relevant')]), scope: SCOPE, capture: true };
    const agents = fakeAgents(() => completedTurn({ text: 'right' }));
    const report = await runMemoryAblation({ id: 'shape', tasks: tasks(2), memory, irrelevantProvider: decoy, makeAgent: agents.makeAgent, repeats: 2 });

    expect(report.runs).toHaveLength(12);
    expect(agents.built).toHaveLength(12);
    expect(agents.built.every(agent => agent.closed)).toBe(true);
    const byCondition = (condition: AblationCondition) => report.runs.filter(run => run.condition === condition).length;
    expect([byCondition('off'), byCondition('on'), byCondition('irrelevant')]).toEqual([4, 4, 4]);
    const [off, on, irrelevant] = agents.built.slice(0, 3).map(agent => agent.memory);
    expect(off).toBe(false);
    expect(on).toMatchObject({ scope: SCOPE, capture: false });
    expect(irrelevant).toMatchObject({ scope: SCOPE, capture: false });
    // Read-only views: the store under test can be recalled from, never written to.
    for (const option of [on, irrelevant] as MemoryOption[]) {
      expect(option.provider.capture).toBeUndefined();
      expect(option.provider.propose).toBeUndefined();
    }
    expect(report).toMatchObject({ verdict: 'inconclusive', reason: 'TOO_FEW_TASKS' });
  });

  it('counts failed builds, turns and checks as errors instead of throwing', async () => {
    let call = 0;
    const agents = fakeAgents(() => {
      call += 1;
      if (call === 2) throw Object.assign(new Error('provider said something private'), { code: 'PROVIDER_DOWN' });
      return completedTurn({ text: 'right' });
    });
    const report = await runMemoryAblation({
      id: 'errors',
      tasks: [
        { id: 'a', input: 'a', check: () => true },
        { id: 'b', input: 'b', check: () => { throw new Error('bad check'); } },
        { id: 'c', input: 'c', check: (() => 'yes') as never },
      ],
      memory: { provider: recordingProvider(), scope: SCOPE },
      irrelevantScope: DECOY,
      makeAgent: (memory, context) => {
        if (context.taskId === 'a' && context.condition === 'irrelevant') throw new TypeError('cannot build');
        return agents.makeAgent(memory, context);
      },
    });

    const errors = report.runs.map(run => [run.task, run.condition, run.error ?? null, run.errorName ?? null]);
    expect(errors).toEqual([
      ['a', 'off', null, null], ['a', 'on', 'turn', 'PROVIDER_DOWN'], ['a', 'irrelevant', 'make-agent', 'TypeError'],
      ['b', 'off', 'check', 'Error'], ['b', 'on', 'check', 'Error'], ['b', 'irrelevant', 'check', 'Error'],
      ['c', 'off', 'check', 'TypeError'], ['c', 'on', 'check', 'TypeError'], ['c', 'irrelevant', 'check', 'TypeError'],
    ]);
    expect(report.conditions.off).toMatchObject({ runs: 3, passed: 1, errors: 2 });
    expect(agents.built.every(agent => agent.closed)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('times out a run that hangs and still closes its Agent', async () => {
    const agents = fakeAgents(() => hanging<Turn>());
    const report = await runMemoryAblation({
      id: 'timeouts', tasks: tasks(1), timeoutMs: 20,
      memory: { provider: recordingProvider(), scope: SCOPE }, irrelevantScope: DECOY, makeAgent: agents.makeAgent,
    });
    expect(report.runs.map(run => run.error)).toEqual(['timeout', 'timeout', 'timeout']);
    expect(agents.built.every(agent => agent.closed)).toBe(true);
  });

  it('bounds concurrency', async () => {
    const agents = fakeAgents(() => completedTurn({ text: 'right' }));
    await runMemoryAblation({
      id: 'parallel', tasks: tasks(4), concurrency: 2,
      memory: { provider: recordingProvider(), scope: SCOPE }, irrelevantScope: DECOY, makeAgent: agents.makeAgent,
    });
    expect(agents.maxInFlight()).toBe(2);
  });

  it('rejects with the abort reason once every Agent it built is closed', async () => {
    const controller = new AbortController();
    const agents = fakeAgents(async (memory) => {
      if (memory !== false) controller.abort(new Error('stop'));
      return completedTurn({ text: 'right' });
    });
    await expect(runMemoryAblation({
      id: 'abort', tasks: tasks(3), signal: controller.signal,
      memory: { provider: recordingProvider(), scope: SCOPE }, irrelevantScope: DECOY, makeAgent: agents.makeAgent,
    })).rejects.toThrow('stop');
    expect(agents.built).toHaveLength(2);
    expect(agents.built.every(agent => agent.closed)).toBe(true);
  });

  it('waits for an Agent still being built before it rejects on abort (rv-r1)', async () => {
    const controller = new AbortController();
    const closed: boolean[] = [];
    const makeAgent: MemoryAblationOptions['makeAgent'] = async () => {
      const index = closed.push(false) - 1;
      // The Agent arrives 80 ms later; the caller aborts at 10 ms.
      await new Promise(resolve => setTimeout(resolve, 80));
      const agent: AblationAgent = {
        send: (async () => completedTurn()) as AblationAgent['send'],
        close: async () => { closed[index] = true; },
      };
      return agent;
    };
    setTimeout(() => controller.abort(new Error('stop')), 10);
    await expect(runMemoryAblation({
      id: 'late', tasks: tasks(1), memory: { provider: recordingProvider(), scope: SCOPE }, irrelevantScope: DECOY,
      makeAgent, signal: controller.signal,
    })).rejects.toThrow('stop');
    expect(closed).toEqual([true]);
  });

  it('reports pass rates over answered runs and leaves errored runs out of them', async () => {
    let call = 0;
    const agents = fakeAgents(() => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('down'), { code: 'PROVIDER_DOWN' });
      return completedTurn({ text: 'right' });
    });
    const report = await runMemoryAblation({
      id: 'rates', tasks: tasks(5), memory: { provider: recordingProvider(), scope: SCOPE }, irrelevantScope: DECOY,
      makeAgent: agents.makeAgent,
    });
    expect(report.conditions.off).toMatchObject({ runs: 5, passed: 4, errors: 1, passRate: 1 });
    expect(report.deltas.onVsOff).toBe(0);
    expect(report).toMatchObject({ verdict: 'inconclusive', reason: 'UNBALANCED_ERRORS' });
  });

  it('carries no profile under any condition: the comparison is about recalled items alone', async () => {
    const provider = profileProvider('The user is a VIP (profile text).', [item('good', 'relevant')]);
    const exec = new RecordingExec();
    exec.executeImpl = async () => ({ completed: true, failed: false, refused: false, sessionId: 's', events: [], nativeEvents: [], text: 'right' });
    const runtime = new Runtime({ adapters: [exec] });
    const built: (MemoryOption | false)[] = [];
    await runMemoryAblation({
      id: 'profile', tasks: tasks(1), memory: { provider, scope: SCOPE }, irrelevantScope: DECOY,
      makeAgent: memory => { built.push(memory); return new Agent({ model: 'opus-5', memory }, runtime); },
    });
    for (const option of built.slice(1) as MemoryOption[]) expect(option.provider.profile).toBeUndefined();
    expect(provider.profiles).toEqual([]);
    expect(exec.requests.some(request => request.prompt.includes('VIP'))).toBe(false);
  });

  it('refuses options that cannot make the comparison', async () => {
    const base = { id: 'x', tasks: tasks(1), memory: { provider: recordingProvider(), scope: SCOPE }, makeAgent: fakeAgents(() => completedTurn()).makeAgent };
    await expect(runMemoryAblation(base)).rejects.toThrow(/exactly one/);
    await expect(runMemoryAblation({ ...base, irrelevantScope: DECOY, irrelevantProvider: recordingProvider() })).rejects.toThrow(/exactly one/);
    await expect(runMemoryAblation({ ...base, irrelevantScope: { ...SCOPE } })).rejects.toThrow(/differ/);
    // A decoy never shows another tenant's memory.
    await expect(runMemoryAblation({ ...base, irrelevantScope: { tenant: 'globex', namespace: 'support' } })).rejects.toThrow(/tenant/);
    await expect(runMemoryAblation({ ...base, irrelevantScope: DECOY, memory: { provider: { id: 'w' }, scope: SCOPE } })).rejects.toThrow(/recall/);
    await expect(runMemoryAblation({ ...base, irrelevantScope: DECOY, repeats: 0 })).rejects.toThrow(RangeError);
    for (const alpha of [0, -0.1, 0.51, Number.NaN, '0.05']) {
      await expect(runMemoryAblation({ ...base, irrelevantScope: DECOY, alpha: alpha as never })).rejects.toThrow(RangeError);
    }
  });
});
