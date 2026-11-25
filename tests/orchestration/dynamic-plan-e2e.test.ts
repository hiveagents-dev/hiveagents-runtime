// End to end: planWorkflow -> runWorkflowPlan(agentRunner, fileDynamicJournal, gitWorktreeIsolation)
// -> abort -> resume replays the finished calls. Real git; the provider is a recording exec adapter.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { Runtime } from '../../src/core/runtime.js';
import {
  agentRunner, fileDynamicJournal, gitWorktreeIsolation, planWorkflow, runWorkflowPlan, DYNAMIC_PLAN_JSON_SCHEMA,
} from '../../src/orchestration/dynamic/index.js';
import type { DynamicWorkflowEvent } from '../../src/orchestration/dynamic/types.js';
import { RecordingExec, success } from '../unit/memory.fixture.js';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['file', 'ok'],
  properties: { file: { type: 'string' }, ok: { type: 'boolean' } },
};
const PLAN = {
  format: 1,
  meta: { name: 'Review', description: 'Review each file, then report.' },
  steps: [
    { kind: 'map', id: 'review', over: 'args.files', prompt: 'Review this file:\n{{item}}', schema: REVIEW_SCHEMA, isolation: 'worktree' },
    { kind: 'agent', id: 'report', prompt: 'Summarise these reviews:\n{{steps.review}}' },
  ],
  result: 'report',
};
const ARGS = { files: ['a.ts', 'b.ts'] };
const LIMITS = { maxAgents: 10, concurrency: 2, maxItems: 8, permissions: 'analyze' as const };

describe('dynamic workflows end to end', () => {
  let base: string;
  let repo: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'oar-dynamic-e2e-')));
    repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('plans, runs isolated agents, is interrupted, and resumes replaying finished calls', async () => {
    const exec = new RecordingExec();
    let hangB = true;
    const agentRequests: ExecTurnRequest[] = [];
    exec.executeImpl = async (request): Promise<ProtocolResult> => {
      if (request.outputSchema && JSON.stringify(request.outputSchema) === JSON.stringify(DYNAMIC_PLAN_JSON_SCHEMA)) {
        return success('planner', { text: JSON.stringify(PLAN), output: PLAN });
      }
      agentRequests.push(request);
      const usage = { inputTokens: 10, outputTokens: 5, costMeaning: 'provider-reported' as const };
      if (request.prompt.includes('b.ts') && !request.prompt.includes('Summarise') && hangB) {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
        });
      }
      if (request.outputSchema) {
        const file = request.prompt.includes('a.ts') ? 'a.ts' : 'b.ts';
        return success('agent', { text: JSON.stringify({ file, ok: true }), output: { file, ok: true }, usage });
      }
      return success('agent', { text: 'All good.', usage });
    };
    const runtime = new Runtime({ adapters: [exec] });

    const planned = await planWorkflow({ goal: 'Review every file.', agent: { model: 'opus-5' }, runtime, limits: LIMITS, args: ARGS });
    expect(planned.plan.steps.map(step => step.id)).toEqual(['review', 'report']);
    expect(planned.estimate.agents).toBe(3);

    const journalDir = join(base, 'journal');
    const isolation = gitWorktreeIsolation({ repository: repo, root: join(base, 'worktrees') });
    const runner = agentRunner({ agent: { model: 'opus-5', cwd: repo }, runtime });

    // Run 1: interrupted once review[0] finished while review[1] still runs.
    const controller = new AbortController();
    const events: DynamicWorkflowEvent[] = [];
    const first = await runWorkflowPlan(planned.plan, {
      runId: 'e2e-1', runner, limits: LIMITS, args: ARGS, isolation,
      journal: fileDynamicJournal(journalDir), signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'agent.finished' && event.result.label === 'review[0]') controller.abort();
      },
    });
    expect(first.status).toBe('aborted');
    const firstReview = first.agents.find(agent => agent.label === 'review[0]');
    expect(firstReview?.status).toBe('completed');
    expect(firstReview?.worktree?.path).toBeDefined();
    expect(existsSync(firstReview!.worktree!.path)).toBe(true);
    expect(agentRequests[0]!.cwd).toBe(firstReview!.worktree!.path);
    expect(first.agents.find(agent => agent.label === 'review[1]')?.status).not.toBe('completed');
    // Lock released on close.
    expect(existsSync(join(journalDir, 'e2e-1.lock'))).toBe(false);

    // Run 2: same runId, fresh journal instance: review[0] replays, review[1] and report run.
    hangB = false;
    const before = agentRequests.length;
    const second = await runWorkflowPlan(planned.plan, {
      runId: 'e2e-1', runner, limits: LIMITS, args: ARGS, isolation, journal: fileDynamicJournal(journalDir),
    });
    expect(second.status).toBe('completed');
    expect(second.result).toBe('All good.');
    expect(second.agents.map(agent => [agent.label, agent.status, agent.cached])).toEqual([
      ['review[0]', 'completed', true], ['review[1]', 'completed', false], ['report', 'completed', false],
    ]);
    expect(agentRequests.length - before).toBe(2);
    // The report saw both reviews as data.
    const report = agentRequests[agentRequests.length - 1]!;
    expect(report.prompt).toContain('"file": "a.ts"');
    expect(report.prompt).toContain('"file": "b.ts"');
    // The resumed review[1] reuses the worktree the interrupted attempt created.
    const reviewB = second.agents.find(agent => agent.label === 'review[1]')!;
    expect(reviewB.worktree?.changed).toBe(false);
    expect(second.spent).toBe(45);

    const cleanup = await isolation.cleanupWorktrees({ runId: 'e2e-1' });
    expect(cleanup.removed).toHaveLength(2);
  });
});
