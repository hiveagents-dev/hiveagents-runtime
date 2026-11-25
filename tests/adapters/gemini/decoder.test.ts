import { describe, expect, it } from "vitest";
import { IncrementalLineDecoder } from "../../../src/public/adapter-kit.js";
import { GeminiProtocol } from "../../../src/adapters/gemini/protocol.js";
describe("bounded incremental UTF-8 JSONL integration", () => {
  it("handles every UTF8 split, batched lines, and EOF without newline", () => {
    const raw = [
      { type: "init", session_id: "11111111-1111-4111-8111-111111111111" },
      {
        type: "message",
        role: "assistant",
        delta: true,
        content: "¡España! 👋",
      },
      { type: "result", status: "success" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const bytes = Buffer.from(raw);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new IncrementalLineDecoder(),
        parser = new GeminiProtocol();
      for (const chunk of [bytes.subarray(0, split), bytes.subarray(split)])
        for (const line of decoder.push(chunk)) parser.line(line);
      for (const line of decoder.finish()) parser.line(line);
      expect(parser.finish(0)).toMatchObject({
        completed: true,
        text: "¡España! 👋",
      });
    }
  });
  it("rejects oversized frame before it reaches parser", () => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 16 });
    expect(() => decoder.push(Buffer.from("x".repeat(17)))).toThrow();
    expect(decoder.finish()).toEqual([]);
  });
});
