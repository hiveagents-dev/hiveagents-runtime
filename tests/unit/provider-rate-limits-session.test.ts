import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import { translateClaudeOutput, type PumpItem } from '../../src/adapters/claude-control/output-spool.js';
import { finalizeResult } from '../../src/adapters/claude-control/result.js';
import { CodexControlProjector, type CodexDelivery } from '../../src/adapters/codex-control/projector.js';
import { CodexThreadRegistry } from '../../src/adapters/codex-control/identity.js';
import { TwoLaneDelivery } from '../../src/control/bounded-lanes.js';
import { UsageLimitError } from '../../src/public/errors.js';
import type { AgentEvent } from '../../src/public/types.js';
import { Session } from '../../src/session/session.js';

const NOW = Date.parse('2026-11-10T13:59:05.530Z');
const rawClaude = JSON.parse(readFileSync(new URL('../fixtures/claude/rate-window-2.1.228.sanitized.jsonl', import.meta.url), 'utf8'));
const rawCodex = JSON.parse(readFileSync(new URL('../fixtures/codex/rate-window-0.153.4.sanitized.jsonl', import.meta.url), 'utf8'));
afterEach(() => vi.useRealTimers());

describe('actual SDK Session with shipped parsers and synthetic runner (no installed CLI)', () => {
  it.each(['send', 'stream'] as const)('retains confirmed reset only in nested failure metadata on %s', async mode => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const provider of ['claude', 'codex'] as const) {
      const rows = provider === 'claude' ? [
        { ...rawClaude, rate_limit_info: { ...rawClaude.rate_limit_info, status: 'rejected' } },
        { type: 'result', session_id: 'fixture', is_error: true, result: 'Usage limit reached' },
      ] : [{ type: 'thread.started', thread_id: 'fixture' }, rawCodex,
        { type: 'error', error: { type: 'usage_limit_reached', resets_at: 1794379738 } },
        { type: 'turn.failed', message: 'Usage limit reached' }];
      const stdout = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
      let calls = 0;
      const runner = async (request: import('../../src/adapters/provider.js').ProcessRunner extends (request: infer R) => unknown ? R : never) => {
        calls++;
        for (const row of rows) {
          const chunk = Buffer.from(JSON.stringify(row) + '\n');
          if (request.onStdoutAsync) await request.onStdoutAsync(chunk, request.signal ?? new AbortController().signal);
          else request.onStdout?.(chunk);
        }
        return { code: 1, signal: null, stdout, stderr: '', durationMs: 1 };
      };
      const options = { target: { command: '/synthetic/never-executed', argsPrefix: [] }, runner };
      const adapter = provider === 'claude' ? new ClaudeExecAdapter(options) : new CodexExecAdapter(options);
      const session = new Session({ adapter, model: { id: 'fixture-model', provider, aliases: [],
        source: 'explicit', availability: 'available' }, cwd: '/', transport: 'exec', persistence: 'provider',
        cliVersion: provider === 'claude' ? '2.1.228' : '0.153.4', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
      const observed: AgentEvent[] = [];
      let caught: unknown;
      try { if (mode === 'send') await session.send('Synthetic fixture only.');
        else for await (const event of session.stream('Synthetic fixture only.')) observed.push(event);
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(UsageLimitError);
      const error = caught as InstanceType<typeof UsageLimitError>;
      expect(error.context.failure).toMatchObject({ kind: 'usage-limit', retryAt:
        provider === 'claude' ? 1794351600000 : 1794379738000 });
      expect(Object.hasOwn(error.context, 'retryAt')).toBe(false);
      expect(calls).toBe(1);
      expect(observed.filter(e => e.type === 'turn.completed')).toHaveLength(0);
    }
  });

  it('Claude control projects warning/rejection as closed DATA and only terminal quota carries retry', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const status of ['allowed_warning', 'rejected']) {
      const output: PumpItem[] = [];
      translateClaudeOutput({ ...rawClaude, rate_limit_info: { ...rawClaude.rate_limit_info, status }, account: 'CANARY' },
        undefined, () => 'unused', item => output.push(item));
      const events = output.flatMap(item => item.kind === 'event' ? [item.event] : []);
      expect(JSON.stringify(events)).not.toContain('CANARY');
      const result = finalizeResult({ type: 'result', is_error: true, result: 'Usage limit reached' }, events, [], undefined, 'fixture').result;
      expect(result.failure?.retryAt).toBe(status === 'rejected' ? 1794351600000 : undefined);
    }
  });

  it('Codex global account notification reaches active observers without a terminal or private fields', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const registry = new CodexThreadRegistry({ epoch: 'fixture' });
    registry.register({ threadId: 'fixture', persistence: 'provider', cwd: '/tmp' });
    const projector = new CodexControlProjector({ registry }), delivery: CodexDelivery = new TwoLaneDelivery();
    projector.subscribe('fixture', delivery); projector.noteTurnStarted('fixture');
    projector.handleNotification('account/rateLimits/updated', { account: 'CANARY', rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1794351600 },
      secondary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: 1794379738 } } });
    delivery.close(); const events: AgentEvent[] = [];
    for await (const event of delivery.publicLane) events.push(event);
    expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain('CANARY');
    expect(events[0]).toMatchObject({ type: 'provider.event', event: { windows: [{ name: 'primary' }, { name: 'secondary' }] } });
  });
});
