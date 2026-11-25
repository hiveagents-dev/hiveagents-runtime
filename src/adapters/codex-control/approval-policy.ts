import type { BrokerDecision } from '../../control/interaction-broker.js';
import { UnsupportedCapabilityError } from '../../public/errors.js';

/**
 * Escalation approvals: accepting one lets a command or patch leave the session's sandbox. Below a
 * `bypassPermissions` ceiling the application can only decline them; an acceptance is refused and the
 * bridge answers the provider with the method's decline decision instead.
 */
export const CODEX_ESCALATION_APPROVAL_METHODS: readonly string[] = Object.freeze([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'execCommandApproval', 'applyPatchApproval',
]);

/** Approval of an escalation cannot widen the session's immutable authority. */
export function assertCodexApproval(ceiling: string | undefined, method: string, response: BrokerDecision): void {
  const context = { provider: 'codex' as const, transport: 'control' as const, retryable: false };
  if (method === 'item/permissions/requestApproval') {
    throw new UnsupportedCapabilityError(context, 'Codex permission grants have no verified control response mapping');
  }
  if (!CODEX_ESCALATION_APPROVAL_METHODS.includes(method)) return;
  if (['decline', 'cancel', 'denied', 'abort'].includes(response.decision)) return;
  if (ceiling === 'bypassPermissions' && ['accept', 'approved'].includes(response.decision)) return;
  throw new UnsupportedCapabilityError(context,
    'This approval may widen the immutable SafetyEnvelope; open a session with explicit authority instead');
}
