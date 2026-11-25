import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { captureRecordJson, decodeRecordJson, encodeRecordJson } from '../../src/orchestration/log/record-json.js';
import { isExecutionHalted } from '../../src/public/execution-halt.js';
import { RecordCodec } from '../../src/orchestration/log/record-codec.js';
const limits = { maxBytes: 8 * 1024 * 1024 };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
it('incremental private codec preserves original JSON bytes/order without stringifying the large object', async () => {
  const input = { z: { text: '😀\r\ná'.repeat(300000) }, a: [1, true, null] }, expected = JSON.stringify(input); let checks = 0;
  const captured = await captureRecordJson(input, limits, () => { checks++; }), original = JSON.stringify;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown) => { if (value === captured || typeof value === 'string' && value.length > 8192) throw Error('whole large value stringify forbidden'); return original(value); }) as typeof JSON.stringify);
  try {
    const encoded = await encodeRecordJson(captured, limits, () => { checks++; }); expect(encoded.bytes.length).toBe(Buffer.byteLength(expected)); expect(encoded.digest).toBe(hash(expected));
    expect(await decodeRecordJson(encoded.bytes, encoded.digest, limits, () => { checks++; })).toEqual(input); expect(checks).toBeGreaterThan(20);
  } finally { spy.mockRestore(); }
});
it.each(['{"z":1,"z":2}', ' {"z":1}', '{"z": 1}', '{"z":1} '])('rejects alternate or duplicate-key body representation: %s', async text => {
  await expect(decodeRecordJson(Buffer.from(text), hash(text), limits, () => {})).rejects.toThrow();
});
it('fuses invalid UTF8, depth, nodes, cycles, getters and proxies before unsafe JSON materialization', async () => {
  let invoked = false; const getter = { get secret() { invoked = true; return 'private'; } };
  await expect(captureRecordJson(getter, limits, () => {})).rejects.toThrow();
  await expect(captureRecordJson(new Proxy({}, { get() { invoked = true; return null; } }), limits, () => {})).rejects.toThrow(); expect(invoked).toBe(false);
  const cycle: any = {}; cycle.self = cycle; await expect(captureRecordJson(cycle, limits, () => {})).rejects.toThrow();
  const deep = '['.repeat(70) + 'null' + ']'.repeat(70); await expect(decodeRecordJson(Buffer.from(deep), hash(deep), limits, () => {})).rejects.toThrow();
  const invalid = Buffer.from([0xff]); await expect(decodeRecordJson(invalid, hash(invalid), limits, () => {})).rejects.toThrow();
  await expect(captureRecordJson(Array.from({ length: 65537 }, () => null), limits, () => {})).rejects.toThrow();
  await expect(captureRecordJson({ text: '\ud800' }, limits, () => {})).rejects.toThrow();
  await expect(captureRecordJson({ ['\ud800']: 1 }, limits, () => {})).rejects.toThrow();
});
it('bounds pending codec operations before another data capture begins', async () => {
  const codec = new RecordCodec(undefined); let release!: () => void, captures = 0; const held = new Promise<void>(resolve => { release = resolve; });
  const first = codec.operation(async () => { captures++; await held; }), second = codec.operation(async () => { captures++; await held; });
  let failure: unknown; try { await codec.operation(async () => { captures++; }); } catch (error) { failure = error; }
  expect(isExecutionHalted(failure)).toBe(true); expect(captures).toBe(2); release(); await Promise.all([first, second]);
});
