import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileWorkflowStore } from '../../src/orchestration/workflow/index.js';
import { WorkflowRoutingReceiptStore, readRoutingReceipt, validateRoutingReceipt, type RoutingReceipt } from '../../src/routing/index.js';
import { digest } from '../../src/routing/json.js';
function receipt(): RoutingReceipt {
  const value = { format: 1, purpose: 'selection-proposal', id: 'receipt', createdAt: 0, configDigest: 'a'.repeat(64), taskDigest: 'b'.repeat(64),
    policy: { mode: 'auto', version: 'priority-v1' }, decision: 'selected', reason: 'PRIORITY',
    candidates: [{ model: 'custom/model', provider: 'custom', modelId: 'model', status: 'eligible', code: 'READY', transport: 'exec', fingerprintDigest: 'c'.repeat(64) }],
    selected: { model: 'custom/model', provider: 'custom', modelId: 'model', transport: 'exec', fingerprintDigest: 'c'.repeat(64) }, nativeDispatches: 0 };
  return validateRoutingReceipt({ ...value, digest: digest(value) });
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('atomically creates once, rejects identical replay and reads after store restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-store-')); directories.push(dir);
  const store = new WorkflowRoutingReceiptStore(new FileWorkflowStore(dir)); const value = receipt();
  await store.save(value); await expect(store.save(value)).rejects.toThrow(/exists/);
  const restarted = new WorkflowRoutingReceiptStore(new FileWorkflowStore(dir)); expect(await readRoutingReceipt(restarted, value.id)).toEqual(value);
  expect(await readRoutingReceipt(restarted, 'missing')).toBeUndefined();
});
it('allows at most one concurrent same-ID create across distinct store clients', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-store-')); directories.push(dir); const value = receipt();
  const first = new WorkflowRoutingReceiptStore(new FileWorkflowStore(dir)); const second = new WorkflowRoutingReceiptStore(new FileWorkflowStore(dir));
  const results = await Promise.allSettled([first.save(value), second.save(value)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await readRoutingReceipt(first, value.id)).toEqual(value);
});
it('rejects corrupt checkpoint output after durable restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-store-')); directories.push(dir); const underlying = new FileWorkflowStore(dir);
  await new WorkflowRoutingReceiptStore(underlying).save(receipt()); const lease = await underlying.acquire('routing:receipt');
  const checkpoint = await lease.load() as { steps: { record: { output: RoutingReceipt } } };
  const modified = JSON.parse(JSON.stringify(checkpoint)); modified.steps.record.output.selected.model = 'custom/other';
  await lease.save(modified); await lease.release();
  await expect(readRoutingReceipt(new WorkflowRoutingReceiptStore(new FileWorkflowStore(dir)), 'receipt')).rejects.toThrow();
});
it('rejects selected inconsistencies and unknown fields even with a recomputed digest', () => {
  for (const change of [
    (r: any) => { r.selected.modelId = 'other'; }, (r: any) => { r.selected.fingerprintDigest = 'd'.repeat(64); },
    (r: any) => { r.candidates[0].status = 'excluded'; }, (r: any) => { r.candidates[0].secret = 'canary'; },
    (r: any) => { r.secret = 'canary'; }, (r: any) => { r.policy.secret = 'canary'; }, (r: any) => { r.nativeDispatches = 1; },
    (r: any) => { r.decision = 'abstained'; }, (r: any) => { r.reason = 'NO_CANDIDATES'; },
  ]) {
    const value = JSON.parse(JSON.stringify(receipt())); change(value); const { digest: _, ...body } = value; value.digest = digest(body);
    expect(() => validateRoutingReceipt(value)).toThrow();
  }
});
it('public reader validates custom stores and rejects ID substitution', async () => {
  const value = receipt();
  await expect(readRoutingReceipt({ async save() {}, async load() { return { ...value, digest: '0'.repeat(64) }; } }, 'receipt')).rejects.toThrow(/digest/);
  await expect(readRoutingReceipt({ async save() {}, async load() { return value; } }, 'different')).rejects.toThrow(/ID/);
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.candidates[0])).toBe(true);
});
it('rejects invalid JSON receipt shapes without invoking accessors', () => {
  const getter = () => { throw Error('getter must never run'); };
  expect(() => validateRoutingReceipt(Object.defineProperty({}, 'format', { enumerable: true, get: getter }))).toThrow(/descriptor/);
  for (const value of [Object.create({}), { value: undefined }, { value: NaN }, { value: [,'x'] }, { [Symbol('x')]: 1 }, { toJSON: getter }]) expect(() => validateRoutingReceipt(value)).toThrow();
});
