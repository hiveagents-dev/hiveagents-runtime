import { describe, expect, it } from 'vitest';

import {
  RequiredTransportUnavailableError,
  UnsupportedCapabilityError,
  selectTransport,
} from '../../src/index.js';

describe('transport capability negotiation', () => {
  it('selects exec for ordinary provider-persisted turns', () => {
    expect(selectTransport({
      provider: 'claude',
      preference: 'auto',
      requirements: {},
      persistence: 'provider',
      controlAvailable: false,
    })).toBe('exec');
  });

  it('keeps Claude message deltas on exec', () => {
    expect(selectTransport({
      provider: 'claude',
      preference: 'auto',
      requirements: { messageDeltas: 'required' },
      persistence: 'provider',
      controlAvailable: false,
    })).toBe('exec');
  });

  it('requires control for Codex message deltas and fails when unavailable', () => {
    expect(() => selectTransport({
      provider: 'codex',
      preference: 'auto',
      requirements: { messageDeltas: 'required' },
      persistence: 'provider',
      controlAvailable: false,
    })).toThrow(RequiredTransportUnavailableError);
  });

  it('does not fail readiness for a preferred control capability', () => {
    expect(selectTransport({
      provider: 'claude',
      preference: 'auto',
      requirements: { interactiveApprovals: 'preferred' },
      persistence: 'provider',
      controlAvailable: false,
    })).toBe('exec');
  });

  it.each([
    'interactiveApprovals',
    'userInputDuringTurn',
    'steering',
    'inProcessTools',
    'dynamicPermissions',
    'sessionInspection',
    'checkpointOrRollback',
  ] as const)('does not simulate control-only capability %s on exec', (capability) => {
    expect(() => selectTransport({
      provider: 'claude',
      preference: 'exec',
      requirements: { [capability]: true },
      persistence: 'provider',
      controlAvailable: true,
    })).toThrow(UnsupportedCapabilityError);
  });

  it('requires control transport for process-only persistence', () => {
    expect(() => selectTransport({
      provider: 'codex',
      preference: 'auto',
      requirements: {},
      persistence: 'process',
      controlAvailable: false,
    })).toThrow(RequiredTransportUnavailableError);
  });

  it('names the versioned token and package when no control adapter is registered', () => {
    expect(() => selectTransport({
      provider: 'codex',
      preference: 'control',
      requirements: {},
      persistence: 'provider',
      controlAvailable: false,
    })).toThrow(/codexAppServerV1.*createCodexControlRegistration/);
  });

  it('demands the experimentalControl opt-in when the adapter is registered but ungated', () => {
    const attempt = () => selectTransport({
      provider: 'claude',
      preference: 'auto',
      requirements: { interactiveApprovals: 'required' },
      persistence: 'provider',
      controlAvailable: false,
      controlRegistered: true,
    });
    expect(attempt).toThrow(UnsupportedCapabilityError);
    expect(attempt).toThrow(/experimentalControl/);
  });

  it('selects control when it is registered and explicitly gated on', () => {
    expect(selectTransport({
      provider: 'claude',
      preference: 'auto',
      requirements: { interactiveApprovals: 'required' },
      persistence: 'provider',
      controlAvailable: true,
      controlRegistered: true,
    })).toBe('control');
  });

  it('routes a promptless-fork requirement to control instead of failing on exec', () => {
    const transport = selectTransport({
      provider: 'codex',
      preference: 'auto',
      requirements: { forkWithoutPrompt: 'required' },
      persistence: 'provider',
      controlAvailable: true,
      controlRegistered: true,
    });

    expect(transport).toBe('control');
  });
});
