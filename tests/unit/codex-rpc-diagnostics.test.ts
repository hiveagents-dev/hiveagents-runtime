import { expect, it } from 'vitest';
import { CodexRpcPeer, type RpcMessage } from '../../src/adapters/codex-control/rpc-peer.js';
import { ExecutionHaltedError } from '../../src/public/execution-halt.js';
import { AgentRuntimeError } from '../../src/public/errors.js';
const secret = 'PRIVATE_NATIVE_RPC_FIXTURE';

it.each([-32603, 73821])('projects RPC failure %s without raw native fields', async code => {
  const written: RpcMessage[] = [], peer = new CodexRpcPeer({ epoch: 'fixture', write: async message => { written.push(message); } });
  const pending = peer.request('model/list', {}), seen = pending.catch(error => error);
  await peer.receive({ id: written[0]!.id!, error: { code, message: secret, data: { authorization: secret } } });
  const error = await seen;
  if (!(error instanceof AgentRuntimeError)) throw error;
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(error).toMatchObject({ code: 'PROTOCOL_ERROR', context: { sanitizedDiagnostics: { kind: 'rpc-error' } } });
  expect(error.context.sanitizedDiagnostics).toEqual({ kind: 'rpc-error', ...(code === -32603 ? { code } : {}) });
  peer.close();
});

it('does not interpolate a prior transport failure into a new public error', async () => {
  const peer = new CodexRpcPeer({ epoch: 'fixture', write: async () => undefined });
  peer.close(new Error(secret));
  const error = await peer.request('model/list', {}).catch(value => value);
  if (!(error instanceof AgentRuntimeError)) throw error;
  expect(error.message).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', context: { sanitizedDiagnostics: { kind: 'rpc-closed' } } });
});

it('preserves a genuine closed-peer infrastructure halt graph before generic projection', async () => {
  const halt = new AggregateError([new ExecutionHaltedError()], 'private outer cause');
  const peer = new CodexRpcPeer({ epoch: 'fixture', write: async () => undefined }); peer.close(halt);
  await expect(peer.request('model/list', {})).rejects.toBe(halt);
});
