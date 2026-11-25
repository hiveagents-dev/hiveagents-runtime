import { describe, expect, it } from 'vitest';
import { assertCodexApproval } from '../../src/adapters/codex-control/approval-policy.js';

describe('Codex immutable permission ceiling', () => {
  it.each(['plan', 'acceptEdits'])('rejects sandbox escalation from %s', (ceiling) => {
    expect(() => assertCodexApproval(ceiling, 'item/commandExecution/requestApproval', { decision: 'accept' }))
      .toThrow(/SafetyEnvelope/);
    expect(() => assertCodexApproval(ceiling, 'item/fileChange/requestApproval', { decision: 'accept' }))
      .toThrow(/SafetyEnvelope/);
  });
  it('allows denial and an already authorized unrestricted single-use approval', () => {
    expect(() => assertCodexApproval('plan', 'item/commandExecution/requestApproval', { decision: 'decline' })).not.toThrow();
    expect(() => assertCodexApproval('bypassPermissions', 'item/commandExecution/requestApproval', { decision: 'accept' })).not.toThrow();
  });
  it.each(['acceptForSession', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'])('rejects persistent %s authority', (decision) => {
    expect(() => assertCodexApproval('bypassPermissions', 'item/commandExecution/requestApproval', { decision }))
      .toThrow(/SafetyEnvelope/);
  });
  it('rejects unimplemented permission grants instead of sending a decision-shaped response', () => {
    expect(() => assertCodexApproval('bypassPermissions', 'item/permissions/requestApproval', { decision: 'accept' }))
      .toThrow(/permission grants/);
  });
});
