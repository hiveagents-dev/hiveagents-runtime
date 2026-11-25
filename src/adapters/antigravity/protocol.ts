import type { AgentEvent, Usage } from "../../public/types.js";
import type { ProtocolFailure, ProtocolResult } from "../../adapters/provider.js";
import { isAntigravitySessionId } from "./session-id.js";
type Frame = Record<string, unknown>;
const object = (v: unknown): Frame | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Frame)
    : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const SAFE_MACHINE_CODES = new Set([
  "401",
  "429",
  "UNAUTHENTICATED",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_ERROR",
  "AUTH_ERROR",
  "LOGIN_REQUIRED",
  "RESOURCE_EXHAUSTED",
  "QUOTA_EXCEEDED",
  "RATE_LIMIT",
  "RATE_LIMITED",
  "MODEL_NOT_FOUND",
  "UNKNOWN_MODEL",
  "MODEL_UNAVAILABLE",
  "MODEL_CAPACITY",
  "INTERNAL",
]);

export function classifyAntigravityError(error: unknown): ProtocolFailure {
  const value = object(error);
  const code = String(value?.type ?? value?.code ?? error ?? "").toUpperCase();
  const kind =
    /401|UNAUTHENTICATED|AUTHENTICATION|AUTH_ERROR|LOGIN_REQUIRED/.test(code)
      ? "not-authenticated"
      : /429|RESOURCE_EXHAUSTED|QUOTA|RATE_LIMIT/.test(code)
        ? "usage-limit"
        : /MODEL_?NOT_?FOUND|UNKNOWN_?MODEL/.test(code)
          ? "unknown-model"
          : /MODEL_?UNAVAILABLE|MODEL_?CAPACITY/.test(code)
            ? "model-unavailable"
            : "provider-unavailable";
  return {
    kind,
    message: `Antigravity ${kind}`,
    ...(SAFE_MACHINE_CODES.has(code) ? { rawCode: code } : {}),
  };
}

/** Antigravity headless NDJSON, independently parsed from its native contract. */
export class AntigravityProtocol {
  readonly #native: unknown[] = [];
  readonly #events: AgentEvent[] = [];
  readonly #steps = new Map<number, { type: string; done: boolean }>();
  #session: string | undefined;
  #text = "";
  #hasText = false;
  #terminal: Frame | undefined;
  #failure: ProtocolFailure | undefined;
  #usage: Usage | undefined;
  #finished: ProtocolResult | undefined;
  constructor(
    readonly expectedSession?: string,
    readonly identity: { model?: string; cwd?: string } = {},
  ) {}
  #invalid(message: string): void {
    this.#failure = { kind: "protocol", message };
  }
  #provider(frame: Frame): void {
    this.#events.push({
      type: "provider.event",
      provider: "antigravity",
      event: frame,
    });
  }
  #sameSession(id: unknown): boolean {
    return isAntigravitySessionId(id) && this.#session === id;
  }

  line(line: string): AgentEvent[] {
    if (line.trim() === "") return [];
    const start = this.#events.length;
    let frame: Frame | undefined;
    try {
      frame = object(JSON.parse(line));
    } catch {
      /* invalid below */
    }
    if (!frame || typeof frame.event !== "string") {
      this.#invalid("Invalid Antigravity NDJSON frame");
      return [];
    }
    this.#native.push(frame);
    if (this.#terminal || this.#finished) {
      this.#invalid("Antigravity emitted data after its terminal result");
      return [];
    }
    if (frame.event === "init") {
      const init = object(frame.init);
      if (
        this.#session !== undefined ||
        !isAntigravitySessionId(frame.conversation_id) ||
        (this.expectedSession !== undefined &&
          this.expectedSession !== frame.conversation_id) ||
        init?.permission_mode !== "request-review" ||
        (this.identity.model !== undefined &&
          init.model !== this.identity.model) ||
        (this.identity.cwd !== undefined && init.cwd !== this.identity.cwd)
      ) {
        this.#invalid(
          "Antigravity init identity or request-review permissions are invalid",
        );
      } else this.#session = frame.conversation_id;
    } else if (frame.event === "step_update") {
      const step = object(frame.step_update);
      if (
        !step ||
        !this.#sameSession(step.conversation_id) ||
        count(step.step_index) === undefined ||
        typeof step.step_type !== "string" ||
        (step.state !== "ACTIVE" && step.state !== "DONE")
      ) {
        this.#invalid("Invalid Antigravity step identity or state");
        return [];
      }
      const index = step.step_index as number,
        previous = this.#steps.get(index);
      if (previous?.done || (previous && previous.type !== step.step_type)) {
        this.#invalid(
          "Antigravity replayed a completed step or changed its type",
        );
        return [];
      }
      this.#steps.set(index, {
        type: step.step_type,
        done: step.state === "DONE",
      });
      if (step.step_type === "agent_response") {
        if (
          step.text_delta !== undefined &&
          typeof step.text_delta !== "string"
        )
          this.#invalid("Invalid Antigravity text delta");
        else if (typeof step.text_delta === "string") {
          this.#hasText = true;
          this.#text += step.text_delta;
          this.#events.push({ type: "message.delta", text: step.text_delta });
        }
      } else if (step.step_type === "tool") {
        const tool = object(step.tool_info),
          name = step.tool_name ?? tool?.name;
        if (
          typeof name !== "string" ||
          !name ||
          (tool?.name !== undefined && tool.name !== name)
        )
          this.#invalid("Invalid Antigravity tool name");
        else {
          if (!previous)
            this.#events.push({
              type: "tool.started",
              id: String(index),
              name,
              ...(tool?.parameters === undefined
                ? {}
                : { input: tool.parameters }),
            });
          if (step.state === "DONE")
            this.#events.push({
              type: "tool.completed",
              id: String(index),
              ...(tool?.output === undefined ? {} : { output: tool.output }),
              ...(tool?.error === undefined ? {} : { error: tool.error }),
            });
          else if (previous)
            this.#events.push({
              type: "tool.updated",
              id: String(index),
              update: tool ?? step,
            });
        }
      } else this.#provider(frame);
    } else if (frame.event === "result") {
      this.#terminal = frame;
      const result = object(frame.result);
      const statuses = [
        "SUCCESS",
        "ERROR",
        "CANCELED",
        "INTERRUPTED",
        "INVALID",
        "WAITING",
        "RUNNING",
      ];
      if (
        !result ||
        !statuses.includes(String(result.status)) ||
        typeof result.response !== "string"
      )
        this.#invalid("Invalid Antigravity terminal result");
      else {
        if (
          this.#session
            ? !this.#sameSession(result.conversation_id)
            : result.status === "SUCCESS" ||
              (result.conversation_id !== "" &&
                result.conversation_id !== undefined &&
                !isAntigravitySessionId(result.conversation_id))
        )
          this.#invalid(
            "Antigravity terminal identity changed or init is absent",
          );
        if (result.status === "SUCCESS") {
          if (this.#hasText && this.#text !== result.response)
            this.#invalid("Antigravity response contradicts streamed deltas");
          if (!this.#hasText) this.#text = result.response;
          if (
            result.error !== undefined &&
            result.error !== null &&
            result.error !== ""
          )
            this.#invalid("Antigravity success includes an error");
        } else if (this.#failure?.kind !== "protocol")
          this.#failure = classifyAntigravityError(result.error);
        const usage = object(result.usage);
        if (usage) {
          this.#usage = { costMeaning: "unavailable" };
          if (this.expectedSession === undefined && result.num_turns === 1) {
            const input = count(usage.input_tokens),
              output = count(usage.output_tokens),
              cached = count(usage.cache_read_tokens);
            if (input !== undefined) this.#usage.inputTokens = input;
            if (output !== undefined) this.#usage.outputTokens = output;
            if (cached !== undefined) this.#usage.cachedInputTokens = cached;
          }
        }
      }
    } else this.#provider(frame);
    return this.#events.slice(start);
  }
  get sessionId(): string | undefined {
    return this.#session;
  }
  /** A protocol violation is terminal while the native process is still alive. */
  get fatalProtocolFailure(): Readonly<ProtocolFailure> | undefined {
    return this.#failure?.kind === "protocol"
      ? { ...this.#failure }
      : undefined;
  }
  finish(code: number | null): ProtocolResult {
    if (this.#finished) return this.#finished;
    if (!this.#terminal || !this.#session)
      this.#failure ??= {
        kind: "protocol",
        message: "Antigravity ended without terminal result or init identity",
      };
    if (code !== 0)
      this.#failure ??= {
        kind: "provider-unavailable",
        message: "Antigravity process did not exit successfully",
      };
    if (!this.#failure && [...this.#steps.values()].some((step) => !step.done))
      this.#invalid("Antigravity ended with an unfinished step");
    const completed =
      !this.#failure &&
      code === 0 &&
      object(this.#terminal?.result)?.status === "SUCCESS";
    if (completed)
      this.#events.push({ type: "message.completed", text: this.#text });
    return (this.#finished = {
      completed,
      failed: !completed,
      refused: false,
      text: this.#text,
      events: [...this.#events],
      nativeEvents: [...this.#native],
      ...(this.#session === undefined ? {} : { sessionId: this.#session }),
      ...(this.#terminal === undefined
        ? {}
        : { terminalEvent: this.#terminal }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    });
  }
}
