import { expect, it } from 'vitest';
import { Session } from '../../src/session/session.js';
import { ExecutionHaltedError } from '../../src/public/execution-halt.js';
import { resolveModel } from '../../src/core/models.js';
import type { ExecAdapter } from '../../src/adapters/provider.js';

it.each(['send', 'stream'] as const)('awaitSettlement %s preserves a genuine late halt before cancellation normalization', async mode => {
  const controller = new AbortController();
  const outer = new AggregateError([new Error('cleanup'), new ExecutionHaltedError()], 'original aggregate');
  const fail = () => { controller.abort(); throw outer; };
  const adapter = { id: 'claude', async execute() { return fail(); }, async *stream() { fail(); } } as unknown as ExecAdapter;
  const session = new Session({ adapter, model: resolveModel('claude/opus'), cwd: '/', transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
  const operation = async () => { const options = { awaitSettlement: true, signal: controller.signal };
    if (mode === 'send') await session.send('fixture', options);
    else for await (const _ of session.stream('fixture', options)) { /* drain */ }
  };
  await expect(operation()).rejects.toBe(outer);
  await session.close();
});
it('awaitSettlement stream preserves a genuine halt produced by actual iterator cleanup after abort', async () => {
  const controller = new AbortController();
  const outer = new AggregateError([new ExecutionHaltedError()], 'actual cleanup halt');
  const adapter = { id: 'claude', stream() { return { [Symbol.asyncIterator]() { return {
    async next() { controller.abort(); return { done: true, value: undefined }; },
    async return() { throw outer; },
  }; } }; } } as unknown as ExecAdapter;
  const session = new Session({ adapter, model: resolveModel('claude/opus'), cwd: '/', transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [], env: {}, warnings: [], features: {} });
  const operation = async () => { for await (const _ of session.stream('fixture', { awaitSettlement: true, signal: controller.signal })) { /* drain */ } };
  await expect(operation()).rejects.toBe(outer);
  await session.close();
});
