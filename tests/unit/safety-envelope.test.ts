import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import {
  assertModelAllowed,
  assertPathWithinRoots,
  assertPermissionModeWithinCeiling,
  isModelAllowed,
  isPathWithinRoot,
  isPermissionModeWithinCeiling,
} from '../../src/security/safety-envelope.js';
import { UnsupportedCapabilityError } from '../../src/public/errors.js';

describe('SafetyEnvelope path containment', () => {
  it.each(['..cache', '...', '..workspace'])('accepts the legitimate child directory %s', (name) => {
    const root = resolve('authorized-root');
    const candidate = join(root, name, 'file.ts');
    expect(isPathWithinRoot(candidate, root)).toBe(true);
    expect(() => assertPathWithinRoots(candidate, [root])).not.toThrow();
  });

  it('still rejects parent traversal and sibling roots after normalizing dot segments', () => {
    const root = resolve('authorized-root');
    for (const candidate of [join(root, '..'), join(root, '..', 'secret'), join(root, '..cache', '..', '..', 'secret'), `${root}-sibling/file.ts`]) {
      expect(isPathWithinRoot(candidate, root)).toBe(false);
      expect(() => assertPathWithinRoots(candidate, [root])).toThrow(UnsupportedCapabilityError);
    }
    expect(isPathWithinRoot(root, root)).toBe(true);
  });

  it('uses separator-aware containment rather than a vulnerable string prefix', () => {
    expect(isPathWithinRoot('/tmp/work/file.ts', '/tmp/work')).toBe(true);
    expect(isPathWithinRoot('/tmp/work-evil/file.ts', '/tmp/work')).toBe(false);
  });

  it('rejects a path outside every authorized root', () => {
    expect(() => assertPathWithinRoots('/private/secret', ['/tmp/work']))
      .toThrow(UnsupportedCapabilityError);
  });
});

describe('SafetyEnvelope permission-mode ceiling', () => {
  it('allows modes at or below the ceiling and rejects escalation', () => {
    expect(isPermissionModeWithinCeiling('plan', 'acceptEdits')).toBe(true);
    expect(isPermissionModeWithinCeiling('acceptEdits', 'acceptEdits')).toBe(true);
    expect(isPermissionModeWithinCeiling('bypassPermissions', 'acceptEdits')).toBe(false);
    expect(() => assertPermissionModeWithinCeiling('bypassPermissions', 'default'))
      .toThrow(UnsupportedCapabilityError);
  });

  it('treats an absent ceiling as unrestricted', () => {
    expect(isPermissionModeWithinCeiling('bypassPermissions', undefined)).toBe(true);
    expect(() => assertPermissionModeWithinCeiling('bypassPermissions', undefined)).not.toThrow();
  });

  it('fails closed for an unrecognized mode whose authority cannot be compared', () => {
    expect(isPermissionModeWithinCeiling('superuser', 'bypassPermissions')).toBe(false);
    expect(() => assertPermissionModeWithinCeiling('superuser', 'plan'))
      .toThrow(UnsupportedCapabilityError);
  });
});

describe('SafetyEnvelope model allowlist', () => {
  it('treats an absent allowlist as unrestricted and an empty one as deny-all', () => {
    expect(isModelAllowed('claude-opus-5', undefined)).toBe(true);
    expect(isModelAllowed('claude-opus-5', [])).toBe(false);
  });

  it('permits listed models and rejects the rest', () => {
    expect(isModelAllowed('claude-opus-5', ['claude-opus-5'])).toBe(true);
    expect(() => assertModelAllowed('claude-sonnet-5', ['claude-opus-5']))
      .toThrow(UnsupportedCapabilityError);
    expect(() => assertModelAllowed('claude-opus-5', ['claude-opus-5'])).not.toThrow();
  });
});
