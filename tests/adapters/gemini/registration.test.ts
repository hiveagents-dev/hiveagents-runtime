import { describe, expect, it } from "vitest";
import { createGeminiCliProvider } from "../../../src/adapters/gemini/registration.js";
import { buildGeminiArgs } from "../../../src/adapters/gemini/argv.js";
import { ANALYZE_MARKER } from "../../../src/adapters/gemini/policy.js";
import type {
  ExecTurnRequest,
  ModelInfo,
  ProcessRunner,
} from "../../../src/index.js";
describe("external factory boundary", () => {
  it("snapshots catalog, runner and executable instead of observing later caller mutation", async () => {
    const targets: string[] = [];
    const runner: ProcessRunner = async (request) => {
      targets.push(request.command);
      return {
        code: 0,
        signal: null,
        stdout: "0.56.0",
        stderr: "",
        durationMs: 0,
      };
    };
    const model: ModelInfo = {
      id: "CaseSensitiveModel",
      provider: "gemini",
      aliases: ["alias"],
      supportedEffort: ["low"],
      source: "explicit",
      availability: "unverified",
    };
    const options = {
      runner,
      executable: { command: "/original", argsPrefix: ["/script"] },
      modelCatalog: [model],
    };
    const provider = createGeminiCliProvider(options);
    options.runner = async () => {
      throw new Error("mutated");
    };
    options.executable.command = "/mutated";
    model.aliases[0] = "changed";
    model.supportedEffort![0] = "high";
    expect(provider.resolveModel("alias")).toMatchObject({
      id: "CaseSensitiveModel",
      aliases: ["alias"],
      supportedEffort: ["low"],
    });
    await provider.exec.adapter.detect({});
    await provider.exec
      .withTarget({ command: "/pinned", argsPrefix: [] })
      .detect({});
    expect(targets).toEqual(["/original", "/pinned"]);
  });
  it("rejects slash commands and invalid operations before CLI startup", () => {
    const request: ExecTurnRequest = {
      mode: "open",
      modelId: "gemini-test",
      cwd: "/",
      prompt: "  /custom-command",
      env: {},
      contextArgs: [],
      permissionArgs: [ANALYZE_MARKER],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    };
    expect(() => buildGeminiArgs(request)).toThrow();
    expect(() =>
      buildGeminiArgs({
        ...request,
        prompt: "ordinary",
        mode: "unexpected" as never,
      }),
    ).toThrow();
  });
  it("encodes leading option text as a literal prompt argument", () => {
    const args = buildGeminiArgs({
      mode: "open",
      modelId: "gemini-test",
      cwd: "/",
      prompt: "--help",
      env: {},
      contextArgs: [],
      permissionArgs: [ANALYZE_MARKER],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    expect(args).toContain("--prompt=--help");
    expect(args).not.toContain("--help");
    expect(args).not.toContain("--prompt");
  });
});
