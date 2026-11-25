import { expect, it } from 'vitest';
import { createAntigravityCliProvider } from '../../../src/adapters/antigravity/index.js';
import type { ExecProbeContext, ProcessRequest } from "../../../src/index.js";

it('forwards the compound deadline and cancellation signal into native probes', async () => {
  const calls: ProcessRequest[] = [];
  const controller = new AbortController();
  const context: ExecProbeContext = { signal: controller.signal, deadline: Date.now() + 1000, remainingMs: () => 800 };
  const provider = createAntigravityCliProvider({ executable: { command: process.execPath, argsPrefix: [] }, runner: async request => {
    calls.push(request);
    return { code: 0, signal: null, stdout: '1.5.3', stderr: '', durationMs: 0 };
  } });
  await provider.exec.adapter.detect({}, context);
  await provider.exec.adapter.compatibility?.({}, '1.5.3', context);
  expect(calls).toHaveLength(2);
  expect(calls.every(call => call.signal === controller.signal && call.timeoutMs <= 800)).toBe(true);
  controller.abort(new Error('cancelled'));
  await expect(provider.exec.adapter.detect({}, context)).rejects.toThrow('cancelled');
  expect(calls).toHaveLength(2);
});
