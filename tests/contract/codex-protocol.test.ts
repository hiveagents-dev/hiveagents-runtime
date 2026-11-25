import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCodexJsonl } from '../../src/adapters/codex/protocol.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/codex/${name}`, import.meta.url)), 'utf8');
}

describe('Codex exec protocol', () => {
  it('parses the thread, final message, tools, and token usage', () => {
    const result = parseCodexJsonl(fixture('success-0.149.0.jsonl'));

    expect(result).toMatchObject({
      completed: true,
      failed: false,
      sessionId: 'codex-thread-1',
      turnId: 'turn-1',
      text: 'Tests en verde.',
      usage: {
        inputTokens: 4200,
        cachedInputTokens: 3000,
        outputTokens: 180,
        costMeaning: 'unavailable',
      },
    });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', name: 'shell' }),
      expect.objectContaining({ type: 'tool.completed', id: 'cmd-1' }),
    ]));
  });

  it('detects an explicit not-logged-in item even when the process exits zero', () => {
    const result = parseCodexJsonl(fixture('not-authenticated-0.149.0.jsonl'));

    expect(result.completed).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.failure).toMatchObject({ kind: 'not-authenticated' });
  });

  it('does not misclassify a transport 403 as an authentication failure', () => {
    const result = parseCodexJsonl([
      '{"type":"thread.started","thread_id":"thread-transport"}',
      '{"type":"error","message":"unexpected status 403 Forbidden"}',
    ].join('\n'));

    expect(result.failure).toMatchObject({ kind: 'provider-unavailable' });
  });

  it('preserves recoverable error items without overriding a completed terminal turn', () => {
    const result = parseCodexJsonl(fixture('recoverable-errors-0.149.0.jsonl'));

    expect(result.completed).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.failure).toBeUndefined();
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'provider.event', provider: 'codex' }),
    ]));
  });

  it('preserves unknown event types instead of throwing', () => {
    const result = parseCodexJsonl(fixture('unknown-event-0.149.0.jsonl'));
    expect(result.events).toContainEqual({
      type: 'provider.event',
      provider: 'codex',
      event: { type: 'future.event', payload: { kept: true } },
    });
  });

  it('requires a terminal event', () => {
    expect(parseCodexJsonl('{"type":"thread.started","thread_id":"t"}\n').failure)
      .toMatchObject({ kind: 'protocol' });
  });

  it.each([
    ['model-unavailable-0.149.0.jsonl', 'model-unavailable'],
    ['usage-limit-0.149.0.jsonl', 'usage-limit'],
    ['untrusted-workspace-0.149.0.jsonl', 'untrusted-workspace'],
  ])('classifies %s as %s', (name, kind) => {
    expect(parseCodexJsonl(fixture(name)).failure).toMatchObject({ kind });
  });

  it('preserves resume model and provider memory/context metadata', () => {
    const result = parseCodexJsonl(fixture('resume-model-context-0.149.0.jsonl'));
    expect(result.completed).toBe(true);
    expect(result.sessionId).toBe('codex-resumed');
    expect(result.nativeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thread.started', model: 'gpt-5.6-sol' }),
      expect.objectContaining({ type: 'context.compacted' }),
    ]));
  });
});
