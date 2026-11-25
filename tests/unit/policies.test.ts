import { describe, expect, it } from 'vitest';

import { translatePermissions } from '../../src/index.js';

describe('permission intent translation', () => {
  it('responds without planning or bypassing approvals', () => {
    const translated = translatePermissions('claude', { mode: 'respond' });
    expect(translated.args).toEqual(['--permission-mode', 'dontAsk', '--strict-mcp-config']);
    expect(translated.report.effective.approvals).toBe('deny-unapproved');
    expect(translated.report.effective.filesystem).toContain('no filesystem tools');
    expect(() => translatePermissions('codex', { mode: 'respond' })).toThrow();
    expect(() => translatePermissions('claude', { mode: 'respond' }, 'control')).toThrow();
  });
  it('maps Codex analyze to its read-only sandbox', () => {
    const translated = translatePermissions('codex', { mode: 'analyze' });

    expect(translated.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(translated.report.effective.enforcedBy).toContain('sandbox');
  });

  it('never lets Codex exec ask for approval: no reviewer model can take a command out of the sandbox', () => {
    expect(translatePermissions('codex', { mode: 'analyze' }).args).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(translatePermissions('codex', { mode: 'edit' }).args).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
    expect(translatePermissions('codex', { mode: 'analyze' }).report.effective.approvals).toMatch(/^never/);
    // Bypass already implies no approvals; control answers approvals itself and does not take these flags.
    expect(translatePermissions('codex', { mode: 'unrestricted' }).args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(translatePermissions('codex', { mode: 'analyze' }, 'control').args).toEqual(['--sandbox', 'read-only']);
    expect(translatePermissions('codex', { mode: 'analyze' }, 'control').report.effective.approvals)
      .toBe('interactive; decline-only for command and file-change escalations below unrestricted');
  });

  it('reports what each control transport can actually answer', () => {
    // Codex control can only decline an escalation below unrestricted; Claude control answers canUseTool.
    for (const mode of ['analyze', 'edit'] as const) {
      expect(translatePermissions('codex', { mode }, 'control').report.effective.approvals).toMatch(/^interactive; decline-only/);
      expect(translatePermissions('claude', { mode }, 'control').report.effective.approvals).toBe('interactive');
    }
    expect(translatePermissions('codex', { mode: 'unrestricted' }, 'control').report.effective.approvals).toBe('bypassed');
    expect(translatePermissions('claude', { mode: 'unrestricted' }, 'control').report.effective.approvals).toBe('bypassed');
  });

  it('does not claim Claude plan mode denies network', () => {
    const translated = translatePermissions('claude', {
      mode: 'analyze',
      network: 'deny',
    });

    expect(translated.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    expect(translated.report.unsupported).toContain('network.deny');
  });

  it('requires explicit unrestricted intent for bypass flags', () => {
    expect(translatePermissions('claude', { mode: 'edit' }).args)
      .not.toContain('--dangerously-skip-permissions');
    expect(translatePermissions('codex', { mode: 'unrestricted' }).args)
      .toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('preserves additional directories as separate argv entries', () => {
    expect(translatePermissions('codex', {
      mode: 'edit',
      additionalDirectories: ['/tmp/a path'],
    }).args).toEqual(expect.arrayContaining(['--add-dir', '/tmp/a path']));
  });
});
