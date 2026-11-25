import { describe, expect, it } from "vitest";
import { GeminiProtocol } from "../../../src/adapters/gemini/protocol.js";
const init = {
  type: "init",
  session_id: "11111111-1111-4111-8111-111111111111",
  model: "gemini-test",
};
const success = {
  type: "result",
  status: "success",
  stats: { input_tokens: 8, output_tokens: 2 },
};
const parse = (events: unknown[], code = 0) => {
  const p = new GeminiProtocol();
  for (const e of events) p.line(typeof e === "string" ? e : JSON.stringify(e));
  return p.finish(code);
};
describe("Gemini 0.56 synthetic protocol", () => {
  it("collects deltas, final text, identity and reported tokens", () => {
    const r = parse([
      init,
      { type: "message", role: "user", content: "private" },
      { type: "message", role: "assistant", content: "¡Ho", delta: true },
      { type: "message", role: "assistant", content: "la!", delta: true },
      success,
    ]);
    expect(r).toMatchObject({
      completed: true,
      failed: false,
      sessionId: "11111111-1111-4111-8111-111111111111",
      text: "¡Hola!",
      usage: { inputTokens: 8, outputTokens: 2, costMeaning: "unavailable" },
    });
    expect(r.events.filter((e) => e.type === "message.delta")).toHaveLength(2);
  });
  it.each([
    [init],
    [init, success, success],
    [
      init,
      { ...init, session_id: "22222222-2222-4222-8222-222222222222" },
      success,
    ],
    [init, "broken", success],
    [init, { type: "result", status: "unknown" }],
  ])("fails closed for malformed or incomplete transcript %j", (...events) =>
    expect(parse(events).failure?.kind).toBe("protocol"),
  );
  it("rejects successful envelope with failed process", () =>
    expect(parse([init, success], 2)).toMatchObject({
      completed: false,
      failed: true,
      failure: { kind: "provider-unavailable" },
    }));
  it("preserves unknown and warning frames without turning warning into failure", () => {
    const r = parse([
      init,
      { type: "future", value: 3 },
      { type: "error", severity: "warning", message: "temporary" },
      success,
    ]);
    expect(r.completed).toBe(true);
    expect(r.events.some((e) => e.type === "provider.event")).toBe(true);
  });
  it.each([
    ["401", "not-authenticated"],
    ["429", "usage-limit"],
    ["MODEL_NOT_FOUND", "unknown-model"],
    ["MODEL_UNAVAILABLE", "model-unavailable"],
  ])("classifies %s", (code, kind) =>
    expect(
      parse(
        [
          init,
          {
            type: "result",
            status: "error",
            error: { code, message: "sensitive" },
          },
        ],
        1,
      ).failure?.kind,
    ).toBe(kind),
  );
  it("requires initial native session identity and matches requested resume", () => {
    expect(parse([success]).failure?.kind).toBe("protocol");
    const p = new GeminiProtocol("old");
    p.line(JSON.stringify(init));
    p.line(JSON.stringify(success));
    expect(p.finish(0).failure?.kind).toBe("protocol");
  });
  it.each([
    ["ModelNotFoundError", "unknown-model"],
    ["ModelUnavailableError", "model-unavailable"],
    ["FatalAuthenticationError", "not-authenticated"],
    ["TerminalQuotaError", "usage-limit"],
    ["RetryableQuotaError", "usage-limit"],
  ])("classifies versioned CLI error class %s", (type, kind) => {
    expect(
      parse(
        [
          init,
          {
            type: "result",
            status: "error",
            error: { type, message: "redacted" },
          },
        ],
        1,
      ).failure?.kind,
    ).toBe(kind);
  });
  it("maps pre-JSONL fatal auth exit41 without overriding structured or malformed evidence", () => {
    expect(parse([], 41).failure?.kind).toBe("not-authenticated");
    expect(parse([init], 41).failure?.kind).toBe("not-authenticated");
    expect(parse([init, success], 41).failure?.kind).toBe("protocol");
    expect(parse([init, "{bad", success], 41).failure?.kind).toBe("protocol");
    expect(
      parse(
        [
          init,
          {
            type: "result",
            status: "error",
            error: { type: "ModelNotFoundError" },
          },
        ],
        41,
      ).failure?.kind,
    ).toBe("unknown-model");
  });
  it("maps structured unsupported-client code to existing version error without overriding malformed protocol", () => {
    const terminal = {
      type: "result",
      status: "error",
      error: {
        code: "UNSUPPORTED_CLIENT",
        message: "private provider details",
      },
    };
    expect(() => parse([init, terminal], 55)).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_CLI_VERSION",
        context: expect.objectContaining({
          rawCode: "UNSUPPORTED_CLIENT",
          retryable: false,
        }),
      }),
    );
    expect(parse([init, "{bad", terminal], 55).failure?.kind).toBe("protocol");
  });
});
