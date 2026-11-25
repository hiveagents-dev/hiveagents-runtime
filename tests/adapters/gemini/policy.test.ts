import { describe, expect, it } from "vitest";
import {
  translateGeminiContext,
  translateGeminiPermissions,
  ANALYZE_MARKER,
} from "../../../src/adapters/gemini/policy.js";
describe("Gemini policy fail closed", () => {
  it("requests a verified restricted exec envelope, never bare plan mode", () => {
    const p = translateGeminiPermissions(
      { mode: "analyze", strict: true },
      "exec",
    );
    expect(p.args).toEqual([ANALYZE_MARKER]);
    expect(p.report.unsupported).toEqual([]);
    expect(p.report.effective.enforcedBy).toEqual(["harness"]);
  });
  it.each([
    { mode: "edit" },
    { mode: "respond" },
    { mode: "unrestricted" },
    { mode: "analyze", network: "deny" },
    { mode: "analyze", minimumEnforcement: "sandbox" },
    { mode: "analyze", additionalDirectories: ["/tmp"] },
  ])("declares impossible intent %j", (p) =>
    expect(
      translateGeminiPermissions(p as never, "exec").report.unsupported.length,
    ).toBeGreaterThan(0),
  );
  it("rejects unsupported control guarantees", () =>
    expect(
      translateGeminiPermissions({ mode: "analyze" }, "control").report
        .unsupported,
    ).toContain("transport.control"));
  it("supports only native inherited context", () => {
    expect(translateGeminiContext().unsupported).toEqual([]);
    expect(
      translateGeminiContext({ profile: "clean", memory: "off" }).unsupported,
    ).toEqual(["context.clean", "memory.off"]);
  });
});
