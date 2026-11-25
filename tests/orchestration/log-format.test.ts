import { expect, it } from 'vitest';
import { captureLogCommit, decodeLogCommit, encodeLogCommit } from '../../src/orchestration/log/validation.js';

const hash = 'a'.repeat(64);
function commit() {
  return { requestId: 'request-1', records: [{ identity: { systemId: 'fixture', generation: 1, runId: 'run-1', agentId: 'agent-1', harness: { id: 'sdk', version: 'development', digest: hash } },
    schema: { id: 'agent-event', version: 1 }, type: 'text', causal: [], payload: { inline: { text: 'á\r\n😀' } } }] };
}
it('captures original Unicode and CRLF values immutably and round-trips canonical bytes', () => {
  const input = commit(), captured = captureLogCommit(input); input.records[0]!.payload.inline.text = 'mutated';
  expect(captured.records[0]!.payload).toEqual({ inline: { text: 'á\r\n😀' } }); expect(Object.isFrozen(captured.records[0])).toBe(true);
  expect(decodeLogCommit(encodeLogCommit(captured))).toEqual(captured);
});
it('rejects duplicate JSON keys rather than accepting last-key interpretation', () => {
  const encoded = encodeLogCommit(commit());
  expect(() => decodeLogCommit(encoded.replace('"generation":1', '"generation":2,"generation":1'))).toThrow();
});
it('rejects noncanonical JSON and invalid UTF8', () => {
  expect(() => decodeLogCommit(` ${encodeLogCommit(commit())}`)).toThrow();
  expect(() => decodeLogCommit(Buffer.from([0xff]))).toThrow();
});
it('rejects a UTF8 BOM rather than silently discarding original input bytes', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encodeLogCommit(commit()))]);
  expect(() => decodeLogCommit(bytes)).toThrow('Invalid execution log data');
});
it('rejects a getter without executing it or exposing private input in the error', () => {
  let invoked = false; const input = commit(); Object.defineProperty(input.records[0]!.payload.inline, 'text', { enumerable: true, get() { invoked = true; throw Error('private-secret'); } });
  expect(() => captureLogCommit(input)).toThrow('Invalid execution log data'); expect(invoked).toBe(false);
});
it.each([NaN, Infinity, undefined, () => 1, new Date(), new Proxy({}, {})])('rejects non-JSON private payload input', invalid => {
  const input = commit(); (input.records[0]!.payload as unknown as { inline: unknown }).inline = invalid;
  expect(() => captureLogCommit(input)).toThrow('Invalid execution log data');
});
it('rejects cyclic and excessively nested payloads before serialization', () => {
  const input = commit(), cycle: Record<string, unknown> = {}; cycle.self = cycle;
  (input.records[0]!.payload as unknown as { inline: unknown }).inline = cycle; expect(() => captureLogCommit(input)).toThrow();
  let nested: unknown = null; for (let i = 0; i < 70; i++) nested = { nested };
  (input.records[0]!.payload as unknown as { inline: unknown }).inline = nested; expect(() => captureLogCommit(input)).toThrow();
});
it('bounds inline payloads and record counts and rejects unknown envelope fields', () => {
  const input = commit(); input.records[0]!.payload.inline.text = 'x'.repeat(65537); expect(() => captureLogCommit(input)).toThrow();
  const many = commit(); many.records = Array.from({ length: 257 }, () => commit().records[0]!); expect(() => captureLogCommit(many)).toThrow();
  expect(() => captureLogCommit({ ...commit(), execute: true })).toThrow();
});
it('binds artifact references to source/system/generation without a caller filesystem path', () => {
  const input = commit(), payload = input.records[0]!.payload as unknown as { artifact: unknown };
  delete (payload as unknown as Record<string, unknown>).inline;
  payload.artifact = { sourceId: 'source-1', systemId: 'fixture', generation: 1, digest: hash, bytes: 20 * 1024 * 1024, mediaType: 'application/json' };
  expect(captureLogCommit(input).records[0]!.payload).toEqual(payload);
  (payload.artifact as Record<string, unknown>).systemId = 'foreign'; expect(() => captureLogCommit(input)).toThrow();
  (payload.artifact as Record<string, unknown>).systemId = 'fixture'; (payload.artifact as Record<string, unknown>).path = '/private/path'; expect(() => captureLogCommit(input)).toThrow();
});
it('does not invoke proxy or shadowed length getters while decoding bytes', () => {
  let invoked = false;
  const proxy = new Proxy(new Uint8Array(), { get() { invoked = true; throw Error('private-secret'); } });
  expect(() => decodeLogCommit(proxy)).toThrow('Invalid execution log data'); expect(invoked).toBe(false);
  const bytes = Buffer.from(encodeLogCommit(commit()));
  Object.defineProperty(bytes, 'byteLength', { get() { invoked = true; throw Error('private-secret'); } });
  expect(decodeLogCommit(bytes)).toEqual(captureLogCommit(commit())); expect(invoked).toBe(false);
});
it('rejects unpaired surrogate keys and values instead of replacing their original bytes', () => {
  const input = commit(); input.records[0]!.payload.inline.text = '\ud800'; expect(() => captureLogCommit(input)).toThrow();
  input.records[0]!.payload.inline = { ['\ud800']: 'value' } as unknown as { text: string };
  expect(() => captureLogCommit(input)).toThrow();
});
