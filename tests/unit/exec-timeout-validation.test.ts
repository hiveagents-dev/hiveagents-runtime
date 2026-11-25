import { describe, expect, it } from 'vitest';

import type { ExecAdapter } from '../../src/adapters/provider.js';
import { resolveModel } from '../../src/core/models.js';
import { runProcess } from '../../src/process/run-process.js';
import { buildExecRequest } from '../../src/session/exec-turn.js';
import type { SessionConfig } from '../../src/session/config.js';

// R10: timeoutMs reached setTimeout unvalidated; 0, Infinity and >= 2^31 all
// collapse to a 1 ms timer in Node, so the turn failed with TIMEOUT at once.

function config(adapter: ExecAdapter): SessionConfig {
  return {
    adapter,
    model: resolveModel('sonnet'),
    cwd: process.cwd(),
    transport: 'exec',
    persistence: 'provider',
    contextArgs: [],
    permissionArgs: [],
    env: {},
    warnings: [],
    features: {},
  };
}

function adapterThatMustNotRun(): ExecAdapter & { executions: number } {
  return {
    id: 'claude',
    executions: 0,
    async detect() { return { installed: true }; },
    async auth() { return { authenticated: true, source: 'unknown' }; },
    async models() { return []; },
    async execute() {
      this.executions += 1;
      return { completed: true, failed: false, refused: false, sessionId: 'sid', text: 'ok', events: [], nativeEvents: [] };
    },
  };
}

describe('exec timeoutMs validation', () => {
  it.each([0, Number.POSITIVE_INFINITY, 2 ** 31])('rejects %s before any process starts', (timeoutMs) => {
    expect(() => buildExecRequest(config(adapterThatMustNotRun()), 'hi', { timeoutMs }, 'open'))
      .toThrow(RangeError);
  });

  it.each([1, 86_400_000, 2 ** 31 - 1])('accepts %s', (timeoutMs) => {
    expect(buildExecRequest(config(adapterThatMustNotRun()), 'hi', { timeoutMs }, 'open').timeoutMs).toBe(timeoutMs);
  });

  it('defaults to ten minutes when omitted', () => {
    expect(buildExecRequest(config(adapterThatMustNotRun()), 'hi', {}, 'open').timeoutMs).toBe(600_000);
  });

  it.each([0, Number.POSITIVE_INFINITY, 2 ** 31])('runProcess rejects %s at the process boundary without spawning', async (timeoutMs) => {
    await expect(runProcess({
      command: '/nonexistent/provider-that-must-not-run',
      args: [],
      cwd: process.cwd(),
      env: process.env,
      stdin: '',
      timeoutMs,
      maxOutputBytes: 1_024,
    })).rejects.toBeInstanceOf(RangeError);
  });
});
