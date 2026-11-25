import type { ProtocolResult } from '../provider.js';
import type { CodexTurnTerminal } from './projector.js';
import { StructuredOutputError } from '../../public/errors.js';
import type { Usage } from '../../public/types.js';

/** Codex returns schema-constrained JSON as the final assistant message text. */
export function parseCodexStructuredOutput(text: string, usage?: Usage): unknown {
  try { return JSON.parse(text) as unknown; }
  catch {
    throw new StructuredOutputError(
      { provider: 'codex', transport: 'control', retryable: false,
        ...(usage === undefined ? {} : { observedUsage: structuredClone(usage) }) },
      'Codex structured output was not valid JSON',
    );
  }
}

export function toProtocolResult(
  terminal: CodexTurnTerminal,
  threadId: string,
  text: string,
  outputSchema?: Record<string, unknown>,
): ProtocolResult {
  const failed = terminal.status === 'failed';
  return {
    completed: !failed,
    failed,
    refused: false,
    sessionId: threadId,
    ...(terminal.turnId === undefined ? {} : { turnId: terminal.turnId }),
    text,
    ...(!failed && outputSchema !== undefined ? { output: parseCodexStructuredOutput(text, terminal.usage) } : {}),
    ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
    events: [],
    ...(failed
      ? {
          failure: {
            kind: 'provider-unavailable' as const,
            message: terminal.failureMessage ?? 'Codex turn failed',
          },
        }
      : {}),
    terminalEvent: terminal.raw,
    nativeEvents: [],
  };
}
