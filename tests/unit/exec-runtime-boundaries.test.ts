import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncrementalLineDecoder } from '../../src/process/json-lines.js';
import { runProcess } from '../../src/process/run-process.js';
import { OutputLimitError } from '../../src/public/errors.js';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import type { ExecTurnRequest, ProcessRunner, ProtocolResult } from '../../src/adapters/provider.js';

const fixture = fileURLToPath(new URL('../fixtures/process/fixture-cli.mjs', import.meta.url));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('exec boundary composition', () => {
  it.each([false, true])('enforces the complete JSONL frame byte limit (split: %s)', split => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 8 });
    if (split) decoder.push(Buffer.from('12345678'));
    expect(() => decoder.push(Buffer.from(split ? '9\n' : '123456789\n'))).toThrow(OutputLimitError);
    expect(decoder.finish()).toEqual([]);
  });

  it('accepts multiple bounded UTF-8 frames with a split CRLF delimiter', () => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 8 });
    expect(decoder.push(Buffer.from('😃😃\r'))).toEqual([]);
    expect(decoder.push(Buffer.from('\n12345678\n'))).toEqual(['😃😃', '12345678']);
    expect(decoder.finish()).toEqual([]);
  });

  it('checks the decoded EOF flush without letting an incomplete UTF-8 sequence extend the bound', () => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 8 });
    decoder.push(Buffer.concat([Buffer.from('1234567'), Buffer.from([0xf0])]));
    expect(() => decoder.finish()).toThrow(OutputLimitError);
    expect(decoder.finish()).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('does not claim an ignoring descendant was reaped after its leader exits', async () => {
    const controller = new AbortController();
    let descendant: number | undefined;
    let ready!: () => void;
    const announced = new Promise<void>(resolve => { ready = resolve; });
    const outcome = runProcess({
      command: process.execPath, args: [fixture, 'spawn-tree-parent-exits'], cwd: process.cwd(), env: process.env,
      stdin: '', timeoutMs: 2_000, maxOutputBytes: 1_024, killGraceMs: 40, signal: controller.signal,
      onStdout: chunk => { descendant = Number(Buffer.from(chunk).toString().trim()); ready(); },
    });
    try {
      await announced;
      controller.abort();
      await expect(outcome).rejects.toMatchObject({ code: 'ABORTED' });
      // This legacy runner has no pinned guardian authority after leader exit.
      // Do not signal a saved numeric PGID or claim tree termination.
      expect(alive(descendant!)).toBe(true);
    } finally {
      if (descendant !== undefined && alive(descendant)) process.kill(descendant, 'SIGKILL');
    }
  });

  it.runIf(process.platform === 'darwin')('preserves descendant cleanup grace after the parent has closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oar-grace-')), marker = join(dir, 'flushed');
    const controller = new AbortController();
    let descendant: number | undefined, ready!: () => void;
    const announced = new Promise<void>(resolve => { ready = resolve; });
    const outcome = runProcess({
      command: process.execPath, args: [fixture, 'spawn-tree-parent-exits', marker], cwd: process.cwd(), env: process.env,
      stdin: '', timeoutMs: 2_000, maxOutputBytes: 1_024, killGraceMs: 200, signal: controller.signal,
      onStdout: chunk => { descendant = Number(Buffer.from(chunk).toString().trim()); ready(); },
    });
    try {
      await announced; controller.abort();
      await expect(outcome).rejects.toMatchObject({ code: 'ABORTED' });
      expect(existsSync(marker)).toBe(true);
      await expect.poll(() => alive(descendant!), { timeout: 300 }).toBe(false);
    } finally {
      if (descendant !== undefined && alive(descendant)) process.kill(descendant, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const request: ExecTurnRequest = { mode: 'open', modelId: 'm', cwd: process.cwd(), prompt: 'fixture', env: {}, contextArgs: [], permissionArgs: [], timeoutMs: 1_000, maxOutputBytes: 1_000_000 };
const runner = (stdout: string): ProcessRunner => async request => {
  for (const line of stdout.split('\n')) { request.onStdout?.(Buffer.from(line + '\n')); await new Promise<void>(resolve => setImmediate(resolve)); }
  return { code: 0, signal: null, stdout, stderr: '', durationMs: 1 };
};
for (const provider of ['claude', 'codex'] as const) {
  it(`${provider} streaming retains distinct fallback tool IDs from the execute contract`, async () => {
    const lines = provider === 'claude' ? [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-tool', name: 'Read', input: { path: 'native' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'b' } }] } },
      { type: 'result', session_id: 's', result: 'done' },
    ] : [
      { type: 'thread.started', thread_id: 's' },
      { type: 'item.started', item: { id: 'native-tool', type: 'command_execution', command: 'native' } },
      { type: 'item.started', item: { type: 'command_execution', command: 'a' } },
      { type: 'item.started', item: { type: 'command_execution', command: 'b' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const stdout = lines.map(line => JSON.stringify(line)).join('\n');
    const options = { target: { command: 'never-launched', argsPrefix: [] }, runner: runner(stdout) };
    const adapter = provider === 'claude' ? new ClaudeExecAdapter(options) : new CodexExecAdapter(options);
    const expected = await adapter.execute(request);
    for (let turn = 0; turn < 2; turn++) {
      let result: ProtocolResult | undefined;
      const streamed: ProtocolResult['events'] = [];
      for await (const item of adapter.stream(request)) {
        if (item.kind === 'result') result = item.result;
        else if (item.kind === 'event') streamed.push(item.event);
      }
      expect(result?.events).toEqual(expected.events);
      expect(streamed).toEqual(expected.events);
    }
  });
}
