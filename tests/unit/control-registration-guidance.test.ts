import { describe, expect, it } from 'vitest';
import { controlUnavailableMessage, controlSessionUnavailableMessage } from '../../src/core/registry.js';

describe('actionable control registration guidance', () => {
  it.each(['claude', 'codex'] as const)('points %s users to the shipped core factory', provider => {
    const message = controlUnavailableMessage(provider);
    expect(message).toContain(provider === 'claude' ? 'createClaudeControlRegistration' : 'createCodexControlRegistration');
    expect(message).toContain('hiveagents-runtime');
    expect(message).toContain('controlAdapters');
    expect(message).toContain('experimentalControl');
    expect(message).not.toMatch(/@open-agent-runtime\/.*-control|to be installed/);
  });

  it('keeps missing custom session factories distinct from missing registrations', () => {
    expect(controlSessionUnavailableMessage('custom')).toContain('no session factory');
    expect(controlUnavailableMessage('custom')).toMatch(/custom.*not registered|not registered.*custom/);
  });
});
