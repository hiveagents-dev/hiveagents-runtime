import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseClaudeJsonl } from '../../src/adapters/claude/protocol.js';

it('preserves a terminal format subtype so callers distinguish schema exhaustion from connectivity', () => {
  const failed = parseClaudeJsonl(JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true }));
  expect(failed.failure).toMatchObject({ kind: 'provider-unavailable', rawCode: 'error_max_structured_output_retries' });
  const network = parseClaudeJsonl(JSON.stringify({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'api_error', is_error: true }));
  expect(network.failure?.rawCode).toBe('api_error');
});

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/claude/${name}`, import.meta.url)), 'utf8');
}

describe('Claude exec protocol', () => {
  it('parses a terminal result and aggregates modelUsage including subagents', () => {
    const result = parseClaudeJsonl(fixture('success-2.1.251.jsonl'));

    expect(result).toMatchObject({
      completed: true,
      failed: false,
      sessionId: 'claude-session-1',
      text: 'Hola',
      output: { ok: true },
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 4,
        cacheCreationTokens: 2,
        reportedCostUsd: 0.02,
        costMeaning: 'api-equivalent',
      },
    });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message.delta', text: 'Hola' }),
      expect.objectContaining({ type: 'tool.started', name: 'Read' }),
    ]));
  });

  it('detects a false exit-code success as authentication failure', () => {
    const result = parseClaudeJsonl(fixture('not-authenticated-2.1.251.jsonl'));

    expect(result.failed).toBe(true);
    expect(result.failure).toMatchObject({ kind: 'not-authenticated' });
  });

  it('preserves unknown native events', () => {
    const result = parseClaudeJsonl(fixture('unknown-event-2.1.251.jsonl'));
    expect(result.events).toContainEqual({
      type: 'provider.event',
      provider: 'claude',
      event: { type: 'future_event', payload: { kept: true } },
    });
  });

  it('fails a stream with no terminal result', () => {
    expect(parseClaudeJsonl('{"type":"system","subtype":"init"}\n').failure)
      .toMatchObject({ kind: 'protocol' });
  });

  it.each([
    ['model-unavailable-2.1.251.jsonl', 'model-unavailable'],
    ['usage-limit-2.1.251.jsonl', 'usage-limit'],
  ])('classifies %s as %s', (name, kind) => {
    expect(parseClaudeJsonl(fixture(name)).failure).toMatchObject({ kind });
  });

  it('aggregates subagent model usage and preserves context compaction metadata', () => {
    const result = parseClaudeJsonl(fixture('context-subagent-2.1.251.jsonl'));
    expect(result.usage?.perModel).toEqual(expect.objectContaining({
      'claude-opus-5': expect.objectContaining({ inputTokens: 8 }),
      'claude-sonnet-5': expect.objectContaining({ inputTokens: 20 }),
    }));
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', name: 'Task' }),
      expect.objectContaining({ type: 'provider.event', provider: 'claude' }),
    ]));
  });
});
