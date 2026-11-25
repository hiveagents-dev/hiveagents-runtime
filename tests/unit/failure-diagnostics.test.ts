import { expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { ExecAdapter, ProtocolFailure } from '../../src/adapters/provider.js';
import type { ProcessRequest } from '../../src/process/run-process.js';
import { resolveModel } from '../../src/core/models.js';
import { projectAgentEvent } from '../../src/orchestration/tracing/projector.js';
import { AgentRuntimeError } from '../../src/public/errors.js';
import { Session } from '../../src/session/session.js';
import { projectFailure } from '../../src/session/failure-projection.js';

const secret = 'PRIVATE_FIXTURE_TOKEN_do_not_project';
const cases: [ProtocolFailure['kind'], string, boolean][] = [
  ['not-authenticated', 'NOT_AUTHENTICATED', false], ['model-unavailable', 'MODEL_UNAVAILABLE_FOR_AUTH', false],
  ['usage-limit', 'USAGE_LIMIT', false], ['protocol', 'PROTOCOL_ERROR', false],
  ['unknown-model', 'UNKNOWN_MODEL', false], ['untrusted-workspace', 'UNTRUSTED_WORKSPACE', false],
  ['session-not-found', 'SESSION_NOT_FOUND', false], ['provider-unavailable', 'PROVIDER_UNAVAILABLE', true],
];
it('preserves finite known codes while refusing code-shaped arbitrary native data', () => {
  for (const rawCode of ['error_max_structured_output_retries', '429', 'EXIT_55']) {
    expect(projectFailure({ kind: 'provider-unavailable', message: secret, rawCode }).rawCode).toBe(rawCode);
  }
  for (const rawCode of ['PRIVATE_FIXTURE_TOKEN_DO_NOT_PROJECT', 'EXIT_256', 'NEW_PROVIDER_MESSAGE']) {
    expect(projectFailure({ kind: 'provider-unavailable', message: secret, rawCode }).rawCode).toBeUndefined();
  }
});
function session(adapter: ExecAdapter) {
  return new Session({ adapter, model: resolveModel(adapter.id === 'codex' ? 'codex/gpt-6.1-sol' : 'claude-opus-5'),
    cwd: '/', transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
}
async function failure(subject: Session, mode: 'send' | 'stream') {
  try {
    if (mode === 'send') await subject.send('synthetic');
    else for await (const _ of subject.stream('synthetic')) { /* drain requested transcript */ }
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    if (!(error instanceof AgentRuntimeError)) throw error;
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.stack).not.toContain(secret);
    expect(error.context.sanitizedDiagnostics).toHaveProperty('kind');
    return error;
  } finally { await subject.close(); }
  throw new Error('Expected synthetic provider failure');
}

it.each(cases)('projects %s from fixed fields through send and stream', async (kind, code, retryable) => {
  const result = { completed: false, failed: true, refused: false, sessionId: 'confirmed', text: '', events: [], nativeEvents: [],
    usage: { inputTokens: 13, costMeaning: 'unavailable' as const }, failure: { kind, message: secret, rawCode: secret } };
  const adapter: ExecAdapter = { id: 'claude', detect: async () => ({ installed: true }),
    auth: async () => ({ authenticated: true, source: 'subscription' }), models: async () => [], execute: async () => result,
    async *stream() { yield { kind: 'result', result }; } };
  for (const mode of ['send', 'stream'] as const) {
    const error = await failure(session(adapter), mode);
    expect(error).toMatchObject({ code, context: { retryable, observedUsage: result.usage, session: { id: 'confirmed' } } });
    expect(error.context.rawCode).toBeUndefined();
    expect(error.context.sanitizedDiagnostics).toEqual({ kind });
  }
});

it.each(['claude', 'codex'] as const)('%s stderr and native failure prose stay outside public errors and safe traces', async provider => {
  for (const mode of ['send', 'stream'] as const) for (const terminal of [false, true]) {
    const stdout = !terminal ? '' : JSON.stringify(provider === 'claude'
      ? { type: 'result', session_id: 'confirmed', subtype: secret, is_error: true, result: `Usage limit ${secret}` }
      : { type: 'turn.failed', message: `Usage limit ${secret}` }) + '\n';
    const options = { target: { command: '/synthetic/never-executed', argsPrefix: [] }, runner: async (request: ProcessRequest) => {
      if (stdout) request.onStdout?.(Buffer.from(stdout));
      return { code: 1, signal: null, stdout, stderr: secret, durationMs: 1 };
    } };
    const adapter = provider === 'claude' ? new ClaudeExecAdapter(options) : new CodexExecAdapter(options);
    const error = await failure(session(adapter), mode);
    expect(error.code).toBe(terminal ? 'USAGE_LIMIT' : 'PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(projectAgentEvent({ type: 'provider.event', provider, event: { message: secret } }))).not.toContain(secret);
  }
});
