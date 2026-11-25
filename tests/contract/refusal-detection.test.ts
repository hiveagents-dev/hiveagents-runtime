import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CONTROL_CAPABILITY_VERDICTS,
  CODEX_CONTROL_CAPABILITY_VERDICTS,
  ClaudeExecAdapter,
  CodexExecAdapter,
} from '../../src/index.js';
import { parseClaudeJsonl } from '../../src/adapters/claude/protocol.js';
import { parseCodexJsonl } from '../../src/adapters/codex/protocol.js';
import { finalizeResult } from '../../src/adapters/claude-control/result.js';
import { toProtocolResult } from '../../src/adapters/codex-control/output.js';
import type { ProcessRunner } from '../../src/index.js';

const directory = (provider: string) => fileURLToPath(new URL(`../fixtures/${provider}/`, import.meta.url));
const fixtures = (provider: string) => readdirSync(directory(provider)).filter((name) => name.endsWith('.jsonl'))
  .map((name) => [name, readFileSync(`${directory(provider)}${name}`, 'utf8')] as const);

// `refused` is reported only from a native refusal signal, never from prose. None of the captured
// exec streams or pinned Codex schemas carries one, so every transport says refusal detection is absent.
describe('refusal detection follows the evidence', () => {
  it.each([
    ['claude', parseClaudeJsonl],
    ['codex', parseCodexJsonl],
  ] as const)('no captured %s exec stream carries a refusal signal, and none is reported', (provider, parse) => {
    const captured = fixtures(provider);
    expect(captured.length).toBeGreaterThan(0);
    for (const [name, text] of captured) {
      expect(text, name).not.toMatch(/refus/i);
      expect(parse(text).refused, name).toBe(false);
    }
  });

  it('control results never report refused', () => {
    const claude = finalizeResult({ type: 'result', subtype: 'success', result: 'ok' }, [], [], undefined, 's');
    expect(claude.result.refused).toBe(false);
    expect(toProtocolResult({ status: 'completed' }, 'thread-1', 'ok').refused).toBe(false);
  });

  it('every built-in transport declares refusal detection absent', async () => {
    expect(CLAUDE_CONTROL_CAPABILITY_VERDICTS.refusalDetection).toBe('none');
    expect(CODEX_CONTROL_CAPABILITY_VERDICTS.refusalDetection).toBe('none');
    const probeRunner: ProcessRunner = async () => ({ code: 0, signal: null, stdout: '', stderr: '', durationMs: 0 });
    const target = { command: '/fixture/cli', argsPrefix: [] };
    for (const adapter of [new ClaudeExecAdapter({ probeRunner, target }), new CodexExecAdapter({ probeRunner, target })]) {
      expect((await adapter.compatibility({}, '0.0.0'))?.features.refusalDetection).toBe('unsupported');
    }
  });
});
