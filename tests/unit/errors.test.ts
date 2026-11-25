import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeError,
  CliNotInstalledError,
  SessionBusyError,
} from '../../src/index.js';

describe('runtime errors', () => {
  it('carry a stable code and immutable sanitized context', () => {
    const error = new CliNotInstalledError('claude', {
      retryable: false,
      sanitizedDiagnostics: { command: 'claude' },
    });

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error.code).toBe('CLI_NOT_INSTALLED');
    expect(error.context).toMatchObject({ provider: 'claude', retryable: false });
    expect(Object.isFrozen(error.context)).toBe(true);
  });

  it('does not encode session contention as a generic provider failure', () => {
    const error = new SessionBusyError({
      retryable: true,
      provider: 'codex',
    });

    expect(error.code).toBe('SESSION_BUSY');
    expect(error.context.retryable).toBe(true);
  });
});
