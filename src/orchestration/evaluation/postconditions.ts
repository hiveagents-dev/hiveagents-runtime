import type { JsonValue } from '../workflow/types.js';
import { identifier, object, snapshot } from './validation.js';

/** One entry of a system manifest's `postconditions` list. */
export interface PostconditionDeclaration {
  id: string;
  description: string;
}

/** What a verifier may look at. The agent's final message is deliberately not part of it. */
export interface PostconditionContext {
  /** Where the run left its results, as reported by the harness: a path, a row id, a record key. */
  state: JsonValue;
  input: JsonValue;
  expected: JsonValue;
  caseId: string;
  attemptId: string;
  repetition: number;
  signal: AbortSignal;
  /** Epoch milliseconds. */
  deadline: number;
}

/**
 * `verified` needs evidence of what was observed: a non-blank text, or a list or object with at
 * least one text, number or boolean inside. A verdict without it counts as failed.
 */
export type PostconditionVerdict =
  | { status: 'verified'; evidence: JsonValue }
  | { status: 'failed'; evidence: JsonValue; code?: string };

/** Inspects the state a run left behind and says whether the postcondition holds. */
export interface PostconditionVerifier {
  /** The declared postcondition this verifier answers for. */
  id: string;
  /** Change it whenever the check or its meaning changes; recorded baselines are bound to it. */
  version: string;
  /**
   * Should stop when `context.signal` aborts. If it does not, the gate stops waiting for it at that
   * moment and ignores its answer.
   */
  verify(context: PostconditionContext): PostconditionVerdict | Promise<PostconditionVerdict>;
}

/** One verifier's answer for one attempt, as it is recorded in a promotion decision. */
export interface PostconditionResult {
  id: string;
  status: 'verified' | 'failed';
  /** Symbolic reason for a failure: the verifier's own, or one of the gate's. */
  code?: string;
  evidence: JsonValue;
}

/** Longest evidence, as JSON text, that one verdict may carry into a decision. */
export const POSTCONDITION_EVIDENCE_LIMIT = 16_384;
const MAX_POSTCONDITIONS = 100;
const SHORT_CLAIM = 8;

/** The manifest's own rule for a postcondition id or description. */
function manifestText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid postcondition ${label}`);
  }
}

/** Verifiers by postcondition id. A declared postcondition with no entry here cannot be verified. */
export class PostconditionRegistry {
  readonly #verifiers = new Map<string, PostconditionVerifier>();

  /** Throws when the verifier is malformed or its id is already taken. */
  register(verifier: PostconditionVerifier): this {
    const item = object(verifier, ['id', 'version', 'verify'], 'postcondition verifier');
    manifestText(item.id, 'id');
    identifier(item.version);
    if (typeof item.verify !== 'function') throw new Error('Invalid postcondition verifier');
    if (this.#verifiers.has(item.id)) throw new Error(`Postcondition verifier already registered: ${item.id}`);
    this.#verifiers.set(item.id, Object.freeze({ id: item.id, version: item.version, verify: verifier.verify }));
    return this;
  }

  get(id: string): PostconditionVerifier | undefined {
    return this.#verifiers.get(id);
  }
}

/** Validates and copies a manifest's declarations. Ids must be unique. */
export function declaredPostconditions(value: unknown): readonly PostconditionDeclaration[] {
  if (!Array.isArray(value) || value.length > MAX_POSTCONDITIONS) {
    throw new Error(`Postconditions must be a list of at most ${MAX_POSTCONDITIONS} entries`);
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const item = object(raw, ['id', 'description'], 'postcondition');
    manifestText(item.id, 'id');
    manifestText(item.description, 'description');
    if (seen.has(item.id)) throw new Error(`Duplicate postcondition: ${item.id}`);
    seen.add(item.id);
    return Object.freeze({ id: item.id, description: item.description });
  });
}

function failed(id: string, code: string): PostconditionResult {
  return { id, status: 'failed', code, evidence: null };
}

/**
 * Evidence has to say something that was observed: a non-blank text, or a list or object holding at
 * least one text, number or boolean somewhere inside. A bare `true` or a bare number does not.
 */
function withoutEvidence(evidence: JsonValue): boolean {
  if (typeof evidence === 'string') return evidence.trim() === '';
  if (evidence === null || typeof evidence !== 'object') return true;
  const says = (value: JsonValue): boolean => {
    if (value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value !== 'object') return true;
    return Object.values(value).some(says);
  };
  return !says(evidence);
}

/**
 * The verifier's answer, or a rejection as soon as the attempt is stopped. A verifier that ignores
 * the signal is left behind: whatever it answers later is discarded.
 */
function answerUnlessStopped(verifier: PostconditionVerifier, context: PostconditionContext): Promise<unknown> {
  const signal = context.signal;
  return new Promise<unknown>((resolve, reject) => {
    const stop = () => reject(new Error('Postcondition check stopped'));
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    const answered = () => signal.removeEventListener('abort', stop);
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(verifier.verify(context));
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      (verdict) => { answered(); resolve(verdict); },
      (error) => { answered(); reject(error); },
    );
  });
}

/** True when some text in the evidence is the agent's own message. */
function quotesClaim(evidence: JsonValue, claim: string): boolean {
  const said = claim.trim();
  if (said.length === 0) return false;
  const visit = (value: JsonValue): boolean => {
    if (typeof value === 'string') return value.trim() === said || (said.length >= SHORT_CLAIM && value.includes(said));
    if (value === null || typeof value !== 'object') return false;
    return Object.values(value).some(visit);
  };
  return visit(evidence);
}

/**
 * Runs one verifier and turns whatever it returns into a recordable result. Anything other than a
 * well-formed verdict with real evidence counts as failed. Only a stopped attempt is rethrown, so
 * the evaluation runner can tell it from a failed postcondition. The wait ends when the attempt's
 * signal aborts (deadline or cancellation), even if the verifier never answers: a verifier launches
 * no provider process, so the attempt's admission slot can be given back without it.
 */
export async function checkPostcondition(
  verifier: PostconditionVerifier,
  context: PostconditionContext,
  claim: string | undefined,
): Promise<PostconditionResult> {
  const id = verifier.id;
  let raw: unknown;
  try {
    raw = await answerUnlessStopped(verifier, context);
  } catch (error) {
    if (context.signal.aborted) throw error;
    return failed(id, 'VERIFIER_ERROR');
  }

  let status: unknown;
  let code: unknown;
  let evidence: JsonValue;
  try {
    const verdict = object(raw, ['status', 'evidence', 'code'], 'postcondition verdict');
    status = verdict.status;
    code = verdict.code;
    evidence = snapshot(verdict.evidence === undefined ? null : verdict.evidence) as JsonValue;
  } catch {
    return failed(id, 'INVALID_VERDICT');
  }
  if ((status !== 'verified' && status !== 'failed') || (code !== undefined && typeof code !== 'string')) {
    return failed(id, 'INVALID_VERDICT');
  }
  if (JSON.stringify(evidence).length > POSTCONDITION_EVIDENCE_LIMIT) return failed(id, 'EVIDENCE_TOO_LARGE');
  if (claim !== undefined && quotesClaim(evidence, claim)) return failed(id, 'CLAIM_AS_EVIDENCE');

  if (status === 'verified') {
    return withoutEvidence(evidence) ? failed(id, 'VERDICT_WITHOUT_EVIDENCE') : { id, status, evidence };
  }
  if (code === undefined) return { id, status, evidence };
  // A symbolic code only: free text from a verifier does not travel into the decision.
  return { id, status, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'VERIFIER_CODE_REDACTED', evidence };
}
