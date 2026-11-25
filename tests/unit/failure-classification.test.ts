import { expect, it } from 'vitest';
import { parseClaudeJsonl } from '../../src/adapters/claude/protocol.js';
import { classifyCodexFailure } from '../../src/adapters/codex/protocol.js';
import { finalizeResult } from '../../src/adapters/claude-control/result.js';
import { projectFailure } from '../../src/session/failure-projection.js';
import { mapFailure } from '../../src/session/exec-turn.js';
import type { SessionConfig } from '../../src/session/config.js';
import { Session } from '../../src/session/session.js';
import { resolveModel } from '../../src/core/models.js';
import type { ExecAdapter, ProtocolFailure } from '../../src/adapters/provider.js';

const cases = [
  ["You've hit your weekly limit · resets Oct 6 at 7pm (America/Buenos_Aires)", 'usage-limit', undefined],
  ['API Error: 529 Overloaded', 'provider-unavailable', 'provider-overloaded'],
  ['connect ECONNREFUSED 127.0.0.1:443', 'provider-unavailable', 'transport'],
  ['Prompt is too long; quota policy rejected it', 'provider-unavailable', 'request-rejected'],
  ['API Error: 400 invalid_request_error', 'provider-unavailable', 'request-rejected'],
  ['Your input exceeds the context window of this model', 'provider-unavailable', 'request-rejected'],
  ['Generic provider failure', 'provider-unavailable', undefined],
] as const;
it.each(['request-rejected', 'execution-limit'] as const)('keeps %s nonretryable at the public failure boundary', reason => {
  const error = mapFailure({ kind: 'provider-unavailable', reason, message: 'PRIVATE_FIXTURE' },
    { adapter: { id: 'claude' }, transport: 'exec' } as SessionConfig);
  expect(error.context.retryable).toBe(false);
  expect(error.context.failure?.reason).toBe(reason);
});
it.each(cases)('classifies native failures before public projection: %s', (message, kind, reason) => {
  const event = { type: 'result', is_error: true, result: message };
  const failures = [parseClaudeJsonl(JSON.stringify(event)).failure,
    classifyCodexFailure([message]), finalizeResult(event, [], [], undefined, undefined).result.failure];
  for (const failure of failures) {
    expect(failure?.kind).toBe(kind);
    expect((failure as ProtocolFailure & { reason?: string })?.reason).toBe(reason);
  }
});
it('keeps native execution caps separate from transport outages', () => {
  for (const subtype of ['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
    const event = { type: 'result', subtype, is_error: true };
    expect(parseClaudeJsonl(JSON.stringify(event)).failure).toMatchObject({ reason: 'execution-limit' });
    expect(finalizeResult(event, [], [], undefined, undefined).result.failure).toMatchObject({ reason: 'execution-limit' });
  }
});
it('only projects closed metadata, never arbitrary reason/extra fields or reset prose', () => {
  for (const reason of ['transport', 'PRIVATE_TOKEN', { secret: 'PRIVATE_TOKEN' }, undefined]) {
    const input = { kind: 'provider-unavailable', message: 'PRIVATE_TOKEN resets tomorrow', rawCode: '429', reason, resetAt: 123, extra: 'PRIVATE_TOKEN' } as unknown as ProtocolFailure;
    const projected = projectFailure(input) as ReturnType<typeof projectFailure> & { failure?: unknown };
    expect(projected.failure).toEqual({ kind: input.kind, ...(reason === 'transport' ? { reason } : {}) });
    expect(projected.rawCode).toBe('429');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_TOKEN');
    expect(JSON.stringify(projected)).not.toContain('resetAt');
  }
});
it('normalizes an invalid adapter kind to protocol instead of exposing native data', () => {
  const projected = projectFailure({ kind: 'PRIVATE_TOKEN', reason: 'transport', message: 'PRIVATE_TOKEN' } as unknown as ProtocolFailure) as ReturnType<typeof projectFailure> & { failure?: unknown };
  expect(projected.message).toBe('Provider protocol error');
  expect(projected.failure).toEqual({ kind: 'protocol' });
  expect(JSON.stringify(projected)).not.toContain('PRIVATE_TOKEN');
});
it('carries typed failure semantics through real Session send and stream while retaining observed usage', async () => {
  const result = { completed: false, failed: true, refused: false, text: '', events: [], nativeEvents: [],
    usage: { inputTokens: 7 }, failure: { kind: 'provider-unavailable', reason: 'transport', message: 'PRIVATE_TOKEN' } } as const;
  const adapter = { id: 'claude', async execute() { return result; }, async *stream() { yield { kind: 'result', result }; } } as unknown as ExecAdapter;
  for (const mode of ['send', 'stream']) {
    const session = new Session({ adapter, model: resolveModel('claude/opus'), cwd: '/', transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
    const operation = async () => { if (mode === 'send') await session.send('fixture'); else for await (const _ of session.stream('fixture')) { /* drain */ } };
    await expect(operation()).rejects.toMatchObject({ message: 'Provider is unavailable', context: { failure: { kind: 'provider-unavailable', reason: 'transport' }, observedUsage: { inputTokens: 7 } } });
    await session.close();
  }
});
