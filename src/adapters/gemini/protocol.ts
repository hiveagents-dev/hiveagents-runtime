import type { AgentEvent, Usage } from "../../public/types.js";
import type { ProtocolFailure, ProtocolResult } from "../../adapters/provider.js";

import { UnsupportedCliVersionError } from "../../public/errors.js";
import { GEMINI_VERSION } from "./compatibility.js";
import { isGeminiSessionId } from "./session-id.js";

type Frame = Record<string, unknown>;
const object = (x: unknown): Frame | undefined =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Frame)
    : undefined;
const count = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;

function rejectUnsupportedClient(error: Frame): void {
  if (
    error.reasonCode === "UNSUPPORTED_CLIENT" ||
    error.code === "UNSUPPORTED_CLIENT"
  )
    throw new UnsupportedCliVersionError("gemini", GEMINI_VERSION, {
      provider: "gemini",
      transport: "exec",
      rawCode: "UNSUPPORTED_CLIENT",
      retryable: false,
    });
}

function classify(error: Frame): ProtocolFailure {
  const code = String(error.code ?? error.type ?? "").toUpperCase();
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
  // Provider messages can contain credentials and prompt excerpts. Keep only a bounded code.
  return {
    kind,
    message: `Gemini ${kind}`,
    ...(/^[A-Z0-9_-]{1,80}$/.test(code) ? { rawCode: code } : {}),
  };
}

/** Versioned, stateful JSONL parser; a success frame alone is insufficient evidence. */
export class GeminiProtocol {
  readonly #native: unknown[] = [];
  readonly #events: AgentEvent[] = [];
  #sessionId: string | undefined;
  #text = "";
  #terminal: Frame | undefined;
  #failure: ProtocolFailure | undefined;
  #usage: Usage | undefined;
  constructor(readonly expectedSession?: string) {}

  #invalid(message: string): void {
    this.#failure = { kind: "protocol", message };
  }

  line(line: string): AgentEvent[] {
    if (line.trim() === "") return [];
    const start = this.#events.length;
    let frame: Frame | undefined;
    try {
      frame = object(JSON.parse(line));
    } catch {
      /* fail below */
    }
    if (!frame || typeof frame.type !== "string") {
      this.#invalid("Invalid Gemini JSONL frame");
      return [];
    }
    this.#native.push(frame);
    if (this.#terminal)
      this.#invalid("Gemini emitted data after its terminal result");
    if (frame.type === "init") {
      const id = frame.session_id;
      if (
        !isGeminiSessionId(id) ||
        (this.#sessionId !== undefined && this.#sessionId !== id) ||
        (this.expectedSession !== undefined && this.expectedSession !== id)
      )
        this.#invalid("Gemini native session identity changed or is invalid");
      else this.#sessionId = id;
    } else if (frame.type === "message" && frame.role === "assistant") {
      if (typeof frame.content !== "string")
        this.#invalid("Invalid Gemini assistant message");
      else {
        this.#text += frame.content;
        this.#events.push({ type: "message.delta", text: frame.content });
      }
    } else if (frame.type === "tool_use") {
      if (
        typeof frame.tool_id !== "string" ||
        typeof frame.tool_name !== "string"
      )
        this.#invalid("Invalid Gemini tool use");
      else
        this.#events.push({
          type: "tool.started",
          id: frame.tool_id,
          name: frame.tool_name,
          input: frame.parameters,
        });
    } else if (frame.type === "tool_result") {
      if (typeof frame.tool_id !== "string")
        this.#invalid("Invalid Gemini tool result");
      else
        this.#events.push({
          type: "tool.completed",
          id: frame.tool_id,
          output: frame.output,
          ...(frame.status === "error" ? { error: frame.error ?? true } : {}),
        });
    } else if (frame.type === "error") {
      this.#events.push({
        type: "provider.event",
        provider: "gemini",
        event: frame,
      });
      if (frame.severity !== "warning" && this.#failure?.kind !== "protocol") {
        rejectUnsupportedClient(frame);
        this.#failure = classify(frame);
      }
    } else if (frame.type === "result") {
      this.#terminal = frame;
      if (frame.status !== "success" && frame.status !== "error")
        this.#invalid("Invalid Gemini terminal status");
      if (frame.status === "error" && this.#failure?.kind !== "protocol") {
        const error = object(frame.error) ?? {};
        rejectUnsupportedClient(error);
        this.#failure = classify(error);
      }
      const stats = object(frame.stats);
      if (stats) {
        const input = count(stats.input_tokens),
          output = count(stats.output_tokens),
          cached = count(stats.cached);
        this.#usage = {
          costMeaning: "unavailable",
          ...(input === undefined ? {} : { inputTokens: input }),
          ...(output === undefined ? {} : { outputTokens: output }),
          ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        };
      }
    } else
      this.#events.push({
        type: "provider.event",
        provider: "gemini",
        event: frame,
      });
    return this.#events.slice(start);
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  finish(exitCode: number | null): ProtocolResult {
    // Gemini 0.56 FatalAuthenticationError exits 41, including before JSONL init.
    // Structured error classification wins; malformed or contradictory frames remain protocol failures.
    if (exitCode === 41 && !this.#failure) {
      this.#failure =
        this.#terminal?.status === "success"
          ? {
              kind: "protocol",
              message: "Gemini auth failure exit contradicts terminal success",
            }
          : {
              kind: "not-authenticated",
              message: "Gemini authentication failed before terminal result",
              rawCode: "41",
            };
    }
    if (!this.#terminal || !this.#sessionId)
      this.#failure ??= {
        kind: "protocol",
        message:
          "Gemini stream ended without terminal result or session identity",
      };
    if (exitCode !== 0 && !this.#failure)
      this.#failure = {
        kind: "provider-unavailable",
        message: "Gemini process failed despite terminal success",
      };
    const completed =
      !this.#failure && this.#terminal?.status === "success" && exitCode === 0;
    if (completed)
      this.#events.push({ type: "message.completed", text: this.#text });
    return {
      completed,
      failed: !completed,
      refused: false,
      text: this.#text,
      events: [...this.#events],
      nativeEvents: [...this.#native],
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#terminal === undefined
        ? {}
        : { terminalEvent: this.#terminal }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    };
  }
}
