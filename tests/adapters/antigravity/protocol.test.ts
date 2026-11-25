import { describe, expect, it } from "vitest";
import { AntigravityProtocol } from "../../../src/adapters/antigravity/protocol.js";
const id = "b501d899-978f-4497-a0ca-0400db2a25a2";
const other = "c501d899-978f-4497-a0ca-0400db2a25a2";
const init = {
  event: "init",
  conversation_id: id,
  init: {
    permission_mode: "request-review",
    model: "gemini-3.8-flash-low",
    cwd: "/tmp/project",
    tools: [],
  },
};
const step = (text: string, state = "DONE", index = 1) => ({
  event: "step_update",
  step_update: {
    conversation_id: id,
    step_index: index,
    state,
    step_type: "agent_response",
    text_delta: text,
  },
});
const result = (status = "SUCCESS", extra = {}) => ({
  event: "result",
  result: {
    conversation_id: id,
    status,
    response: "¡Hola!\n",
    num_turns: 1,
    usage: { input_tokens: 12, output_tokens: 4, cache_read_tokens: 3 },
    ...extra,
  },
});
function parse(frames: unknown[], expected?: string, exit: number | null = 0) {
  const p = new AntigravityProtocol(expected);
  for (const frame of frames)
    p.line(typeof frame === "string" ? frame : JSON.stringify(frame));
  return p.finish(exit);
}
describe("Antigravity native protocol", () => {
  it("never exposes arbitrary token-shaped provider error text as a raw machine code", () => {
    for (const error of [
      "SECRET_TOKEN_123ABC",
      { type: "SECRET_TOKEN_123ABC", message: "private" },
    ]) {
      const r = parse(
        [
          {
            event: "result",
            result: {
              conversation_id: "",
              status: "ERROR",
              response: "",
              error,
            },
          },
        ],
        undefined,
        1,
      );
      expect(r.failure).toMatchObject({ kind: "provider-unavailable" });
      expect(r.failure?.rawCode).toBeUndefined();
      expect(JSON.stringify(r.failure)).not.toContain("SECRET_TOKEN_123ABC");
    }
  });
  it("classifies pre-init errors carrying a UUID without inventing an initialized session", () => {
    const r = parse(
      [
        {
          event: "result",
          result: {
            conversation_id: id,
            status: "ERROR",
            response: "",
            error: "authentication required",
          },
        },
      ],
      undefined,
      1,
    );
    expect(r).toMatchObject({
      completed: false,
      failure: { kind: "not-authenticated" },
    });
    expect(r.sessionId).toBeUndefined();
  });
  it("joins ACTIVE fragments and DONE final fragment without appending terminal response again", () => {
    const r = parse([
      init,
      step("¡Ho", "ACTIVE"),
      step("la!", "ACTIVE"),
      step("\n"),
      result(),
    ]);
    expect(r).toMatchObject({
      completed: true,
      sessionId: id,
      text: "¡Hola!\n",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 3,
        costMeaning: "unavailable",
      },
    });
    expect(r.events.filter((e) => e.type === "message.delta")).toEqual([
      { type: "message.delta", text: "¡Ho" },
      { type: "message.delta", text: "la!" },
      { type: "message.delta", text: "\n" },
    ]);
    expect(r.events.at(-1)).toEqual({
      type: "message.completed",
      text: "¡Hola!\n",
    });
  });
  it("uses the terminal response if the native stream contains no response step", () =>
    expect(parse([init, result()])).toMatchObject({
      completed: true,
      text: "¡Hola!\n",
    }));
  it("keeps cumulative usage native and omits normalized counters on resume or multiple turns", () => {
    for (const [expected, turns] of [
      [id, 1],
      [undefined, 2],
      [undefined, undefined],
    ] as const) {
      const r = parse(
        [init, result("SUCCESS", { num_turns: turns })],
        expected,
      );
      expect(r.usage).toEqual({ costMeaning: "unavailable" });
      expect(r.nativeEvents.at(-1)).toMatchObject({
        result: { usage: { input_tokens: 12 } },
      });
    }
  });
  it("preserves unknown events and normalizes tool lifecycle by step index", () => {
    const tool = {
      conversation_id: id,
      step_index: 2,
      step_type: "tool",
      tool_name: "view_file",
      tool_info: {
        name: "view_file",
        parameters: { path: "/tmp/a" },
        output: "hello",
      },
    };
    const r = parse([
      init,
      { event: "future", custom: 1 },
      { event: "step_update", step_update: { ...tool, state: "ACTIVE" } },
      { event: "step_update", step_update: { ...tool, state: "DONE" } },
      result(),
    ]);
    expect(r.completed).toBe(true);
    expect(r.events).toContainEqual({
      type: "provider.event",
      provider: "antigravity",
      event: { event: "future", custom: 1 },
    });
    expect(r.events).toContainEqual({
      type: "tool.started",
      id: "2",
      name: "view_file",
      input: { path: "/tmp/a" },
    });
    expect(r.events).toContainEqual({
      type: "tool.completed",
      id: "2",
      output: "hello",
    });
  });
  it.each([
    [[], "EOF"],
    [[init], "missing terminal"],
    [[result()], "missing init"],
    [[init, init, result()], "duplicate init"],
    [[init, result(), result()], "duplicate terminal"],
    [[init, result(), { event: "future" }], "data after terminal"],
    [[init, "{bad", result()], "malformed JSON"],
    [[init, "[]", result()], "non object"],
    [[init, { type: "result", status: "success" }], "wrong provider protocol"],
    [
      [init, step("x"), step("x"), result("SUCCESS", { response: "xx" })],
      "replayed DONE",
    ],
    [[init, step("x"), result()], "contradictory terminal response"],
    [
      [init, result("SUCCESS", { conversation_id: other })],
      "terminal identity drift",
    ],
    [
      [
        init,
        {
          event: "step_update",
          step_update: {
            conversation_id: other,
            step_index: 1,
            state: "DONE",
            step_type: "user_input",
          },
        },
        result(),
      ],
      "step identity drift",
    ],
    [[{ ...init, conversation_id: "latest" }, result()], "invalid UUID"],
    [
      [{ ...init, init: { permission_mode: "always-proceed" } }, result()],
      "effective permission mismatch",
    ],
    [[{ ...init, init: {} }, result()], "unproven permissions"],
    [[init, result("MYSTERY")], "unknown status"],
  ])("fails closed for %s (%s)", (frames, _label) =>
    expect(parse(frames as unknown[])).toMatchObject({
      completed: false,
      failed: true,
      failure: { kind: "protocol" },
    }),
  );
  it("requires exact resume identity and successful exit", () => {
    expect(parse([init, result()], other)).toMatchObject({
      failure: { kind: "protocol" },
    });
    expect(parse([init, result()], undefined, 1)).toMatchObject({
      completed: false,
    });
    expect(parse([init, result()], undefined, null)).toMatchObject({
      completed: false,
    });
  });
  it.each([
    "ERROR",
    "CANCELED",
    "INTERRUPTED",
    "INVALID",
    "WAITING",
    "RUNNING",
  ])("does not complete status %s", (status) =>
    expect(parse([init, result(status)])).toMatchObject({
      completed: false,
      failed: true,
    }),
  );
  it.each([
    ["UNAUTHENTICATED", "not-authenticated"],
    ["RESOURCE_EXHAUSTED", "usage-limit"],
    ["MODEL_NOT_FOUND", "unknown-model"],
    ["MODEL_UNAVAILABLE", "model-unavailable"],
    ["INTERNAL", "provider-unavailable"],
  ])("classifies sanitized pre-init %s", (type, kind) => {
    const r = parse(
      [
        {
          event: "result",
          result: {
            conversation_id: "",
            status: "ERROR",
            response: "",
            error: { type, message: "secret credential and prompt" },
          },
        },
      ],
      undefined,
      1,
    );
    expect(r).toMatchObject({ completed: false, failure: { kind } });
    expect(r.sessionId).toBeUndefined();
    expect(JSON.stringify(r.failure)).not.toContain("secret");
  });
  it("validates explicit model and cwd identity when supplied", () => {
    for (const identity of [{ model: "other" }, { cwd: "/another" }]) {
      const p = new AntigravityProtocol(undefined, identity);
      p.line(JSON.stringify(init));
      p.line(JSON.stringify(result()));
      expect(p.finish(0)).toMatchObject({ failure: { kind: "protocol" } });
    }
  });
});
