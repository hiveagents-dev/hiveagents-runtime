import { describe, expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { resolveModel } from '../../src/core/models.js';
import { AgentRuntimeError, ProtocolError, ProviderUnavailableError, UsageLimitError } from '../../src/public/errors.js';
import type { AgentEvent, Usage } from '../../src/public/types.js';
import { Session } from '../../src/session/session.js';

describe('EXEC provider failure accounting', () => {
  it.each(['send', 'stream'] as const)('retains known usage when %s completes without confirming session identity', async mode => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1234, output_tokens: 66 } }) + '\n';
    const adapter = new ClaudeExecAdapter({ target: { command: '/synthetic/never-executed/claude', argsPrefix: [] }, runner: async request => {
      request.onStdout?.(Buffer.from(stdout)); return { code: 0, signal: null, stdout, stderr: '', durationMs: 1 };
    } });
    const session = new Session({ adapter, model: resolveModel('claude-opus-5'), cwd: '/', transport: 'exec', persistence: 'provider',
      contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
    try {
      if (mode === 'send') await session.send('Synthetic completion without identity.');
      else for await (const _event of session.stream('Synthetic completion without identity.')) { /* drain */ }
      expect.fail('missing provider identity must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      if (!(error instanceof ProtocolError)) throw error;
      expect(error.context.observedUsage).toEqual({ inputTokens: 1234, outputTokens: 66, costMeaning: 'unavailable' });
    }
    expect(session.state).toBe('failed');
  });

  it.each(['send', 'stream'] as const)('preserves known usage in %s failures without inventing unknown usage or a completion', async mode => {
    for (const quota of [false, true]) {
      for (const counters of [undefined, { input_tokens: 0, output_tokens: 0 }, { input_tokens: 1234, output_tokens: 66 }]) {
        let requests = 0;
        const stdout = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true,
          session_id: 'test-failed-session', result: quota ? 'Usage limit reached after tools' : 'Provider unavailable after tools',
          ...(counters ? { usage: counters } : {}) }) + '\n';
        const adapter = new ClaudeExecAdapter({ target: { command: '/synthetic/never-executed/claude', argsPrefix: [] },
          runner: async request => {
            requests++; request.onStdout?.(Buffer.from(stdout));
            return { code: 1, signal: null, stdout, stderr: '', durationMs: 1 };
          } });
        const session = new Session({ adapter, model: resolveModel('claude-opus-5'), cwd: '/', transport: 'exec', persistence: 'provider',
          cliVersion: '2.1.228', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
        const events: AgentEvent[] = [];
        const expected: Usage | undefined = counters ? { inputTokens: counters.input_tokens, outputTokens: counters.output_tokens, costMeaning: 'unavailable' } : undefined;
        try {
          if (mode === 'send') await session.send('Synthetic failure; no process is executed.');
          else for await (const event of session.stream('Synthetic failure; no process is executed.')) events.push(event);
          expect.fail('provider failure must reject');
        } catch (error) {
          expect(error).toBeInstanceOf(quota ? UsageLimitError : ProviderUnavailableError);
          if (!(error instanceof AgentRuntimeError)) throw error;
          expect(error.context.observedUsage).toEqual(expected);
          expect(Object.hasOwn(error.context, 'observedUsage')).toBe(counters !== undefined);
          expect(error.context.retryable).toBe(!quota);
        }
        expect(requests).toBe(1);
        expect(events.filter(event => event.type === 'turn.completed')).toHaveLength(0);
        expect(session.state).toBe('failed');
      }
    }
  });
});
