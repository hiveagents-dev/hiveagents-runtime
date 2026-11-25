import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { AdapterStreamItem, ExecTurnRequest, ProcessRunner } from '../../src/adapters/provider.js';

const fixture = fileURLToPath(new URL('../fixtures/process/exec-output.mjs', import.meta.url));
const providers = [{ provider: 'claude', Adapter: ClaudeExecAdapter }, { provider: 'codex', Adapter: CodexExecAdapter }] as const;
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('fixture boundary timed out')), 1500);
  })]); } finally { clearTimeout(timer); }
}
const request = (): ExecTurnRequest => ({ mode: 'open', modelId: 'fixture-model', cwd: process.cwd(),
  prompt: 'fixture', env: {}, contextArgs: [], permissionArgs: [], timeoutMs: 4_000, maxOutputBytes: 64 * 1024 * 1024 });
const outcome = () => ({ code: 0, signal: null, stdout: '', stderr: '', durationMs: 1 });
function raw(provider: 'claude' | 'codex', count = 1800) {
  return Buffer.from([
    JSON.stringify(provider === 'claude' ? { type: 'system', subtype: 'init', session_id: 'native-fixture' }
      : { type: 'thread.started', thread_id: 'native-fixture' }),
    ...Array.from({ length: count }, (_, index) => JSON.stringify({ type: 'fixture-progress', index })),
  ].join('\n') + '\n');
}
async function collect(stream: AsyncIterable<AdapterStreamItem>) {
  const items: AdapterStreamItem[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe.each(providers)('$provider exec backpressure', ({ provider, Adapter }) => {
  it('preserves every event after a slow native consumer resumes beyond 1024 events', async () => {
    const abort = new AbortController();
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [fixture, provider, 'slow'] } });
    const iterator = adapter.stream({ ...request(), signal: abort.signal, awaitSettlement: true })[Symbol.asyncIterator]();
    try {
      expect((await bounded(iterator.next())).value).toMatchObject({ kind: 'session', sessionId: 'native-fixture' });
      await delay(30);
      const indices: number[] = []; let terminal: AdapterStreamItem | undefined;
      for (;;) {
        const item = await iterator.next(); if (item.done) break;
        if (item.value.kind === 'result') terminal = item.value;
        if (item.value.kind === 'event' && item.value.event.type === 'provider.event') {
          indices.push((item.value.event.event as { index: number }).index);
        }
      }
      expect(indices).toEqual(Array.from({ length: 1800 }, (_, i) => i));
      expect(terminal).toMatchObject({ kind: 'result', result: { completed: true, text: 'done',
        sessionId: 'native-fixture', usage: { inputTokens: 10, outputTokens: 2 } } });
    } finally { abort.abort(); await iterator.return?.(); }
  });

  it('delivers a valid terminal transcript larger than the progress queue byte cap', async () => {
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [fixture, provider, 'large-terminal'] } });
    const items = await collect(adapter.stream(request()));
    const terminal = items.find(item => item.kind === 'result');
    expect(terminal?.kind).toBe('result');
    if (terminal?.kind !== 'result') throw new Error('missing fixture terminal');
    expect(Buffer.byteLength(JSON.stringify(terminal))).toBeGreaterThan(16 * 1024 * 1024);
    expect(terminal.result).toMatchObject({ completed: true, text: 'done', sessionId: 'native-fixture' });
    expect(items.filter(item => item.kind === 'event' && item.event.type === 'provider.event')).toHaveLength(3200);
  });

  it.each([false, true])('unblocks a full producer before early return (awaitSettlement=%s)', async awaitSettlement => {
    const cleanup = deferred(), finished = deferred(); const abort = new AbortController();
    let active = false, asyncUsed = false, signal: AbortSignal | undefined;
    const runner: ProcessRunner = async value => {
      active = true; signal = value.signal;
      try {
        if (value.onStdoutAsync) { asyncUsed = true; await value.onStdoutAsync(raw(provider), value.signal!); }
        else value.onStdout?.(raw(provider));
      } finally { await cleanup.promise; active = false; finished.resolve(); }
      return outcome();
    };
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner });
    const iterator = adapter.stream({ ...request(), signal: abort.signal, awaitSettlement })[Symbol.asyncIterator]();
    let returning: Promise<IteratorResult<AdapterStreamItem>> | undefined;
    try {
      expect((await bounded(iterator.next())).value).toMatchObject({ kind: 'session' });
      await immediate(); expect(active).toBe(true); expect(asyncUsed).toBe(true);
      let returned = false;
      returning = iterator.return!(); void returning.then(() => { returned = true; }, () => { returned = true; });
      await immediate();
      expect(signal?.aborted).toBe(true); expect(returned).toBe(!awaitSettlement); expect(active).toBe(true);
      cleanup.resolve(); await bounded(returning); await bounded(finished.promise); expect(active).toBe(false);
    } finally {
      cleanup.resolve(); abort.abort(); await returning?.catch(() => undefined); await iterator.return?.();
    }
  });

  it('keeps legacy synchronous custom runners bounded with their existing typed overflow', async () => {
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async value => {
      value.onStdout?.(raw(provider)); return outcome();
    } });
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  it('rejects a custom async runner that ignores delivery acknowledgments without unhandled promises', async () => {
    let asyncUsed = false;
    const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [] }, runner: async value => {
      if (value.onStdoutAsync) {
        asyncUsed = true;
        for (let i = 0; i < 50; i++) void value.onStdoutAsync(raw(provider, 30), value.signal!);
      } else value.onStdout?.(raw(provider));
      return outcome();
    } });
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(asyncUsed).toBe(true);
  });
});

it('backpressures a single valid Claude frame that fans out beyond the item cap', async () => {
  const adapter = new ClaudeExecAdapter({ target: { command: process.execPath, argsPrefix: [fixture, 'claude', 'fanout'] } });
  const items = await collect(adapter.stream(request()));
  expect(items.filter(item => item.kind === 'event' && item.event.type === 'tool.started').map(item =>
    item.kind === 'event' && item.event.type === 'tool.started' ? item.event.id : undefined))
    .toEqual(Array.from({ length: 1800 }, (_, i) => `tool-${i}`));
  expect(items.at(-1)).toMatchObject({ kind: 'result', result: { completed: true } });
});
