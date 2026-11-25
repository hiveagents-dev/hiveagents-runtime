import type { ApplicationToolCallOptions } from '../../tools/registry.js';
import {
  ApprovalRequiredError,
  ProtocolError,
  UnsupportedCapabilityError,
  type AgentRuntimeError,
} from '../../public/errors.js';
import type { InteractionBinding, InteractionRequest, UserQuestion } from '../../public/types.js';
import type { InteractionBroker, InteractionHandle, BrokerDecision } from '../../control/interaction-broker.js';
import { stringValue } from '../provider.js';
import type { CodexDynamicToolHost } from './dynamic-tools.js';
import type { RpcId } from './rpc-peer.js';
import serverRequestStableSchema from './schemas/ServerRequest.stable.json';

type InteractionKind = InteractionRequest['kind'];

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The native command decision union, extracted from the pinned 0.149.0 schema
 * so the advertised decisions can never drift from what we validated against.
 * String variants come through as-is; object variants (amendments) surface as
 * their discriminating key.
 */
function extractCommandDecisions(): readonly string[] {
  const definitions = asObject(serverRequestStableSchema.definitions);
  const union = asObject(definitions?.CommandExecutionApprovalDecision);
  const variants = Array.isArray(union?.oneOf) ? union.oneOf : [];
  const decisions: string[] = [];
  for (const variant of variants) {
    const entry = asObject(variant);
    if (!entry) continue;
    const enumValue = Array.isArray(entry.enum) ? entry.enum[0] : undefined;
    if (typeof enumValue === 'string') {
      decisions.push(enumValue);
      continue;
    }
    const key = Object.keys(asObject(entry.properties) ?? {})[0];
    if (key !== undefined) decisions.push(key);
  }
  return decisions;
}

const COMMAND_DECISIONS = Object.freeze(extractCommandDecisions());
// Not pinned as a named union in the generated schema; mirrors the string
// subset of CommandExecutionApprovalDecision pending live evidence.
const FILE_CHANGE_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel']);
const PERMISSION_DECISIONS = Object.freeze(['accept', 'decline', 'cancel']);
// Legacy v1 approval methods use the v1 ReviewDecision spelling.
const LEGACY_REVIEW_DECISIONS = Object.freeze(['approved', 'approved_for_session', 'denied', 'abort']);
const USER_INPUT_DECISIONS = Object.freeze(['respond', 'cancel']);
const ELICITATION_DECISIONS = Object.freeze(['accept', 'decline', 'cancel']);
const DYNAMIC_TOOL_DECISIONS = Object.freeze(['fulfill', 'fail']);
const OBJECT_COMMAND_DECISIONS = new Set(['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment']);

interface ParsedServerRequest {
  kind: InteractionKind;
  method: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  decisions: readonly string[];
  declineDecision?: string;
  view: Record<string, unknown>;
}

function normalizeAdvertisedDecisions(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const decisions: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      decisions.push(entry);
    } else {
      const key = Object.keys(asObject(entry) ?? {})[0];
      if (key !== undefined) decisions.push(key);
    }
  }
  return decisions.length > 0 ? decisions : undefined;
}

function parseQuestions(value: unknown): UserQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: UserQuestion[] = [];
  for (const entry of value) {
    const raw = asObject(entry);
    const id = stringValue(raw?.id);
    const question = stringValue(raw?.question);
    if (raw === undefined || id === undefined || question === undefined) continue;
    const header = stringValue(raw.header);
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
        const parsed = asObject(option);
        const label = stringValue(parsed?.label);
        if (label === undefined) return [];
        const description = stringValue(parsed?.description);
        return [{ id: label, label, ...(description === undefined ? {} : { description }) }];
      })
      : undefined;
    questions.push({
      id,
      question,
      ...(header === undefined ? {} : { header }),
      ...(raw.isSecret === true ? { secret: true } : {}),
      ...(raw.isOther === true ? { allowOther: true } : {}),
      ...(options === undefined || options.length === 0 ? {} : { options }),
    });
  }
  return questions;
}

function parseServerRequest(method: string, params: unknown): ParsedServerRequest | undefined {
  const raw = asObject(params) ?? {};
  const threadId = stringValue(raw.threadId ?? raw.thread_id ?? raw.conversationId ?? raw.conversation_id) ?? 'unknown-thread';
  const turnId = stringValue(raw.turnId ?? raw.turn_id);
  const base = {
    method,
    threadId,
    ...(turnId === undefined ? {} : { turnId }),
    view: raw,
  };
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const itemId = stringValue(raw.itemId);
      return {
        ...base,
        kind: 'command-approval',
        ...(itemId === undefined ? {} : { itemId }),
        decisions: normalizeAdvertisedDecisions(raw.availableDecisions) ?? COMMAND_DECISIONS,
        declineDecision: 'decline',
      };
    }
    case 'item/fileChange/requestApproval': {
      const itemId = stringValue(raw.itemId);
      return {
        ...base,
        kind: 'file-change-approval',
        ...(itemId === undefined ? {} : { itemId }),
        decisions: normalizeAdvertisedDecisions(raw.availableDecisions) ?? FILE_CHANGE_DECISIONS,
        declineDecision: 'decline',
      };
    }
    case 'item/permissions/requestApproval': {
      const itemId = stringValue(raw.itemId);
      return {
        ...base,
        kind: 'permission',
        ...(itemId === undefined ? {} : { itemId }),
        decisions: normalizeAdvertisedDecisions(raw.availableDecisions) ?? PERMISSION_DECISIONS,
        declineDecision: 'decline',
      };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const itemId = stringValue(raw.callId ?? raw.call_id);
      return {
        ...base,
        kind: method === 'execCommandApproval' ? 'command-approval' : 'file-change-approval',
        ...(itemId === undefined ? {} : { itemId }),
        decisions: LEGACY_REVIEW_DECISIONS,
        declineDecision: 'denied',
      };
    }
    case 'item/tool/requestUserInput': {
      const itemId = stringValue(raw.itemId);
      return {
        ...base,
        kind: 'user-input',
        ...(itemId === undefined ? {} : { itemId }),
        decisions: USER_INPUT_DECISIONS,
      };
    }
    case 'mcpServer/elicitation/request':
      return { ...base, kind: 'elicitation', decisions: ELICITATION_DECISIONS };
    case 'item/tool/call': {
      const itemId = stringValue(raw.callId ?? raw.call_id);
      return {
        ...base,
        kind: 'dynamic-tool',
        ...(itemId === undefined ? {} : { itemId }),
        decisions: DYNAMIC_TOOL_DECISIONS,
      };
    }
    default:
      return undefined;
  }
}

function buildInteractionRequest(parsed: ParsedServerRequest, handle: InteractionHandle): InteractionRequest {
  const base = {
    binding: handle.binding,
    availableDecisions: handle.availableDecisions,
    signal: handle.signal,
  };
  const view = parsed.view;
  switch (parsed.kind) {
    case 'command-approval':
      return { ...base, kind: 'command-approval', command: view.command, cwd: view.cwd };
    case 'file-change-approval':
      return { ...base, kind: 'file-change-approval', paths: view.grantRoot ?? view.changes ?? view.fileChanges };
    case 'permission':
      return { ...base, kind: 'permission', requested: view.permissions };
    case 'user-input':
      return { ...base, kind: 'user-input', questions: parseQuestions(view.questions) };
    case 'elicitation': {
      const schema = asObject(view.requestedSchema);
      return {
        ...base,
        kind: 'elicitation',
        serverName: stringValue(view.serverName) ?? 'unknown',
        ...(schema === undefined ? {} : { schema }),
      };
    }
    case 'dynamic-tool':
      return { ...base, kind: 'dynamic-tool', toolName: stringValue(view.tool) ?? 'unknown', arguments: view.arguments };
    default:
      return { ...base, kind: 'network-approval', destination: undefined };
  }
}

/**
 * An escalation approval (command or file change) whose acceptance the policy refused is declined
 * on the wire with the method's decline decision (`decline` in the pinned
 * CommandExecutionApprovalDecision union; `denied` for the legacy v1 methods). Other refusals keep
 * failing the request with a JSON-RPC error. Returns the error for respond(), or undefined.
 */
function declineRefusedEscalation(
  parsed: ParsedServerRequest,
  response: BrokerDecision,
  error: unknown,
): AgentRuntimeError | undefined {
  if (parsed.declineDecision === undefined
    || (parsed.kind !== 'command-approval' && parsed.kind !== 'file-change-approval')) return undefined;
  const reason = error instanceof Error ? error.message : 'Approval refused';
  return new UnsupportedCapabilityError(
    {
      provider: 'codex', transport: 'control', retryable: false,
      sanitizedDiagnostics: { requestedDecision: response.decision, wireDecision: parsed.declineDecision },
    },
    `${reason}; ${parsed.method} was declined on the wire with "${parsed.declineDecision}"`,
  );
}

export interface CodexInteractionBridgeOptions {
  toolContext?: (binding: InteractionBinding) => Partial<ApplicationToolCallOptions>;
  validateResponse?: (method: string, response: BrokerDecision) => void;
  broker: InteractionBroker;
  dynamicTools?: CodexDynamicToolHost;
  /** Delivers the interaction to a consumer (critical lane). Absent = missing handler. */
  deliver?: (request: InteractionRequest) => void;
  /** Typed errors surfaced after wire settlement (missing handler, tool failures). */
  onTypedError?: (error: AgentRuntimeError) => void;
}

/**
 * Wires Codex server requests into the InteractionBroker with exactly-once
 * settlement. The returned promise IS the wire settlement: resolving writes a
 * JSON-RPC result, rejecting writes a JSON-RPC error. A missing handler
 * settles decline/failure on the wire FIRST, then expires the broker entry and
 * surfaces a typed error — the App Server is never left hanging.
 */
export class CodexInteractionBridge {
  readonly #validateResponse: CodexInteractionBridgeOptions['validateResponse'];
  readonly #toolContext: CodexInteractionBridgeOptions['toolContext'];
  readonly #broker: InteractionBroker;
  readonly #dynamicTools: CodexDynamicToolHost | undefined;
  readonly #deliver: CodexInteractionBridgeOptions['deliver'];
  readonly #onTypedError: CodexInteractionBridgeOptions['onTypedError'];

  constructor(options: CodexInteractionBridgeOptions) {
    this.#validateResponse = options.validateResponse;
    this.#toolContext = options.toolContext;
    this.#broker = options.broker;
    this.#dynamicTools = options.dynamicTools;
    this.#deliver = options.deliver;
    this.#onTypedError = options.onTypedError;
  }

  handleServerRequest(method: string, params: unknown, id: RpcId): Promise<unknown> {
    const parsed = parseServerRequest(method, params);
    if (!parsed) {
      const error = new UnsupportedCapabilityError(
        { provider: 'codex', transport: 'control', retryable: false },
        `Unsupported Codex server request: ${method}`,
      );
      this.#onTypedError?.(error);
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settleWire = (value: unknown) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const failWire = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const handle = this.#broker.register({
        providerRequestId: id,
        method,
        sessionId: parsed.threadId,
        ...(parsed.turnId === undefined ? {} : { turnId: parsed.turnId }),
        ...(parsed.itemId === undefined ? {} : { itemId: parsed.itemId }),
        payload: params,
        availableDecisions: parsed.decisions,
        settle: async (response) => {
          try { this.#validateResponse?.(method, response); }
          catch (error) {
            const declined = declineRefusedEscalation(parsed, response, error);
            if (declined === undefined) { failWire(error); throw error; }
            // The provider gets the method's own decline, not a JSON-RPC error, so the
            // interaction is resolved; the application's respond() gets the typed refusal.
            settleWire({ decision: parsed.declineDecision });
            return { refusal: declined };
          }
          this.#settle(parsed.kind, response, settleWire, failWire);
          return undefined;
        },
      });
      // The broker aborts the handle's signal on every exit: after a settled
      // response (wire already written, nothing to do) and on expiry — a
      // failed handler, a timeout, an epoch change. An expiry that reaches
      // the wire first is settled as a decline so the App Server never waits
      // on an interaction nobody will answer.
      handle.signal.addEventListener('abort', () => {
        if (settled) return;
        const reason = handle.signal.reason;
        this.#settleExpired(parsed, settleWire, failWire, new ApprovalRequiredError(
          { provider: 'codex', transport: 'control', retryable: false },
          `${reason instanceof Error ? reason.message : 'Interaction expired'} for ${parsed.method}; declined on the wire`,
        ));
      }, { once: true });
      if (parsed.kind === 'dynamic-tool') {
        this.#runDynamicTool(parsed, handle, failWire);
        return;
      }
      if (!this.#deliver) {
        this.#declineMissingHandler(parsed, handle, settleWire, failWire);
        return;
      }
      this.#deliver(buildInteractionRequest(parsed, handle));
    });
  }

  /** Wire settlement for an interaction that expired unanswered, then the typed error. */
  #settleExpired(
    parsed: ParsedServerRequest,
    settleWire: (value: unknown) => void,
    failWire: (error: unknown) => void,
    error: AgentRuntimeError,
  ): void {
    if (parsed.kind === 'elicitation') {
      settleWire({ action: 'decline' });
    } else if (parsed.declineDecision !== undefined) {
      settleWire({ decision: parsed.declineDecision });
    } else {
      failWire(error);
    }
    this.#onTypedError?.(error);
  }

  #settle(
    kind: InteractionKind,
    response: BrokerDecision,
    settleWire: (value: unknown) => void,
    failWire: (error: unknown) => void,
  ): void {
    switch (kind) {
      case 'command-approval':
      case 'file-change-approval':
      case 'network-approval':
      case 'tool-approval':
      case 'permission': {
        const payload = response.payload;
        const decision = OBJECT_COMMAND_DECISIONS.has(response.decision) && payload !== undefined
          ? { [response.decision]: payload }
          : response.decision;
        settleWire({ decision });
        return;
      }
      case 'user-input': {
        if (response.decision === 'cancel') {
          failWire(new ProtocolError(
            { provider: 'codex', transport: 'control', retryable: false },
            'User input request was cancelled',
          ));
          return;
        }
        settleWire({ answers: response.answers ?? {} });
        return;
      }
      case 'elicitation': {
        const content = asObject(response.content);
        settleWire({
          action: response.decision,
          ...(response.decision === 'accept' && content !== undefined ? { content } : {}),
        });
        return;
      }
      case 'dynamic-tool': {
        if (response.decision === 'fulfill') {
          // App Server 0.149.0 decodes DynamicToolCallResponse, not the host's
          // arbitrary JSON value. Keep text literal and render other results as JSON.
          const text = typeof response.result === 'string'
            ? response.result : JSON.stringify(response.result ?? null) ?? 'null';
          settleWire({ success: true, contentItems: [{ type: 'inputText', text }] });
          return;
        }
        failWire(new ProtocolError(
          { provider: 'codex', transport: 'control', retryable: false },
          typeof response.error === 'string' ? response.error : 'Dynamic tool call failed',
        ));
        return;
      }
      default:
        failWire(new ProtocolError(
          { provider: 'codex', transport: 'control', retryable: false },
          `No wire mapping for interaction kind ${kind as string}`,
        ));
    }
  }

  #declineMissingHandler(
    parsed: ParsedServerRequest,
    handle: InteractionHandle,
    settleWire: (value: unknown) => void,
    failWire: (error: unknown) => void,
  ): void {
    const error = new ApprovalRequiredError(
      { provider: 'codex', transport: 'control', retryable: false },
      `No interaction handler registered for ${parsed.method}; declined on the wire`,
    );
    // Wire settlement FIRST, then broker expiry, then the typed error.
    if (parsed.kind === 'elicitation') {
      settleWire({ action: 'decline' });
    } else if (parsed.declineDecision !== undefined) {
      settleWire({ decision: parsed.declineDecision });
    } else {
      failWire(error);
    }
    this.#broker.expire(handle.binding.interactionId, 'No interaction handler registered');
    this.#onTypedError?.(error);
  }

  #runDynamicTool(
    parsed: ParsedServerRequest,
    handle: InteractionHandle,
    failWire: (error: unknown) => void,
  ): void {
    const toolName = stringValue(parsed.view.tool) ?? '';
    const host = this.#dynamicTools;
    if (!host?.has(toolName)) {
      const error = new UnsupportedCapabilityError(
        { provider: 'codex', transport: 'control', retryable: false },
        `Dynamic tool ${toolName || '(unnamed)'} is not registered with this runtime`,
      );
      failWire(error);
      this.#broker.expire(handle.binding.interactionId, 'Dynamic tool not registered');
      this.#onTypedError?.(error);
      return;
    }
    let context: Partial<ApplicationToolCallOptions>;
    try { context = this.#toolContext?.(handle.binding) ?? {}; }
    catch (error) { failWire(error); this.#broker.expire(handle.binding.interactionId, 'Tool scope unavailable'); return; }
    void host.call(toolName, parsed.view.arguments, {
      ...context,
      signal: context.signal ? AbortSignal.any([handle.signal, context.signal]) : handle.signal,
    }).then(
      (result) => this.#broker.respond(handle.binding.interactionId, { decision: 'fulfill', result }),
      (error: unknown) => this.#broker
        .respond(handle.binding.interactionId, {
          decision: 'fail',
          error: error instanceof Error ? error.message : String(error),
        })
        .then(() => {
          if (error instanceof Error && 'code' in error) {
            this.#onTypedError?.(error as AgentRuntimeError);
          }
        }),
    ).catch(() => {
      // The broker entry expired first (epoch change, remote settlement); the
      // wire side was settled by whoever expired it. A late write is zero bytes.
    });
  }
}
