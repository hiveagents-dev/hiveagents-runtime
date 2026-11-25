import { freeze } from '../../shared/json.js';
import { abortable, errorLabel } from './curation-support.js';
import { stopLabel } from './curator-decision.js';
import type { PassControl } from './curator-decision.js';
import type { CuratorCandidate, CuratorCandidateOutcome, CuratorScreenReason } from './curator-types.js';

/**
 * The application's safety screen, asked before a new candidate is stored or measured. The
 * usefulness gate cannot tell a malicious lesson from a harmless one with the same effect on the
 * tasks; a screen can refuse it before it is ever measured. Fail-closed: a screen that throws or
 * answers anything but `{ allow: boolean }` leaves the candidate unmeasured (an `error`).
 */

const REASONS = new Set<CuratorScreenReason>(['INSTRUCTION_OVERRIDE', 'EXFILTRATION', 'SECRET', 'PERSONAL_DATA', 'HARMFUL', 'POLICY']);

/** Undefined when there is no screen or it allows the candidate; otherwise the refusal or error outcome. */
export async function screenCandidate(
  candidate: CuratorCandidate, state: PassControl,
): Promise<CuratorCandidateOutcome | undefined> {
  const { options, signal } = state;
  const { screen } = options;
  if (!screen) return undefined;
  const { id } = candidate;
  let verdict: unknown;
  try {
    const subject = freeze({ id, text: candidate.text, sources: [...candidate.sources] });
    const context = Object.freeze({ scope: freeze({ ...options.scope }), signal });
    verdict = await abortable(() => screen(subject, context), signal);
  } catch (error) {
    return { id, status: 'error', stage: 'screen', error: stopLabel(state) ?? errorLabel(error) };
  }
  if (!verdict || typeof verdict !== 'object' || typeof (verdict as { allow?: unknown }).allow !== 'boolean') {
    return { id, status: 'error', stage: 'screen', error: 'INVALID_RESULT' };
  }
  const { allow, reason } = verdict as { allow: boolean; reason?: unknown };
  if (allow) return undefined;
  return {
    id, status: 'refused', reason: 'SCREENED',
    screen: REASONS.has(reason as CuratorScreenReason) ? reason as CuratorScreenReason : 'POLICY',
  };
}
