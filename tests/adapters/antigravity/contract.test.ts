import { describe, expect, it } from "vitest";
import { createAntigravityCliProvider } from "../../../src/adapters/antigravity/index.js";
import { buildAntigravityArgs } from "../../../src/adapters/antigravity/argv.js";
import { EDIT_MARKER } from "../../../src/adapters/antigravity/policy.js";
import type { AgentOptions, ExecTurnRequest } from "../../../src/index.js";
const request = (extra: Partial<ExecTurnRequest> = {}): ExecTurnRequest => ({
  mode: "open",
  modelId: "Gemini-3.8-Custom",
  cwd: "/tmp",
  prompt: "/read $(touch /tmp/no) --dangerously-skip-permissions",
  env: {},
  contextArgs: [],
  permissionArgs: [EDIT_MARKER],
  timeoutMs: 1250,
  maxOutputBytes: 10000,
  ...extra,
});
describe("external registration and literal argv", () => {
  it("pins runner and target options across later caller mutation", async () => {
    const calls: string[] = [];
    const options = {
      executable: { command: "/original", argsPrefix: [] },
      runner: async (request: { command: string }) => {
        calls.push(request.command);
        return {
          code: 0,
          signal: null,
          stdout: "1.5.3",
          stderr: "",
          durationMs: 0,
        };
      },
    };
    const provider = createAntigravityCliProvider(options);
    options.executable.command = "/mutated";
    options.runner = async () => {
      throw new Error("mutated runner");
    };
    await provider.exec.adapter.detect({});
    await provider.exec
      .withTarget({ command: "/pinned", argsPrefix: [] })
      .detect({});
    expect(calls).toEqual(["/original", "/pinned"]);
  });
  it("resolves aliases but retains exact casing for explicit IDs without claiming availability", () => {
    const p = createAntigravityCliProvider();
    expect(p.id).toBe("antigravity");
    expect(p.exec?.token).toBe("antigravityExecV1");
    expect(p.resolveModel("flash-low")).toMatchObject({
      provider: "antigravity",
      id: "gemini-3.8-flash-low",
      availability: "unverified",
    });
    expect(p.resolveModel("Gemini-3.8-Custom")).toMatchObject({
      id: "Gemini-3.8-Custom",
      source: "explicit",
      availability: "unverified",
    });
    for (const id of ["", "-x", "bad\0value"])
      expect(() => p.resolveModel(id)).toThrow();
  });
  it("defensively copies catalog and rejects foreign models", () => {
    const model = {
      provider: "antigravity",
      id: "native",
      aliases: ["alias"],
      source: "explicit",
      availability: "unverified",
    } as const;
    const catalog = [{ ...model, aliases: [...model.aliases] as string[] }];
    const p = createAntigravityCliProvider({ modelCatalog: catalog });
    catalog[0]!.aliases.push("mutated");
    expect(p.resolveModel("alias").aliases).toEqual(["alias"]);
    const resolved = p.resolveModel("alias");
    resolved.aliases.push("other");
    expect(p.resolveModel("alias").aliases).toEqual(["alias"]);
    expect(() =>
      createAntigravityCliProvider({
        modelCatalog: [{ ...model, provider: "gemini", aliases: [] }],
      }),
    ).toThrow();
  });
  it("passes literal prompts, bounded native timeout and request-review settings without plan mode", () => {
    const args = buildAntigravityArgs(request());
    expect(args).toContain(
      "--print=/read $(touch /tmp/no) --dangerously-skip-permissions",
    );
    expect(args).toContain("--disable-slash-commands");
    expect(args).not.toContain("--mode");
    expect(
      args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
    ).toEqual(["--model", "Gemini-3.8-Custom"]);
    expect(
      args.slice(
        args.indexOf("--output-format"),
        args.indexOf("--output-format") + 2,
      ),
    ).toEqual(["--output-format", "stream-json"]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings).toEqual({
      toolPermission: "request-review",
      agentMode: "",
    });
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("1250ms");
  });
  it("resumes only a stable exact UUID", () => {
    const id = "b501d899-978f-4497-a0ca-0400db2a25a2";
    const args = buildAntigravityArgs(
      request({ mode: "resume", sessionId: id }),
    );
    expect(
      args.slice(
        args.indexOf("--conversation"),
        args.indexOf("--conversation") + 2,
      ),
    ).toEqual(["--conversation", id]);
    for (const sessionId of [
      "latest",
      "0",
      "-1",
      "--yolo",
      "b501d899-978f-4497-a0ca-0400db2a25a",
    ])
      expect(() =>
        buildAntigravityArgs(request({ mode: "resume", sessionId })),
      ).toThrow();
  });
  it.each([
    { mode: "fork" },
    { instructions: "system" },
    { effort: "high" },
    { outputSchema: {} },
    { permissionArgs: ["--yolo"] },
    { contextArgs: ["--settings", "{}"] },
    { providerOptions: { custom: 1 } },
  ])("rejects unsupported direct request before any process: %j", (extra) =>
    expect(() =>
      buildAntigravityArgs(request(extra as Partial<ExecTurnRequest>)),
    ).toThrow(),
  );
  it("reports native context and permissions without asserting OS sandbox or harness enforcement", () => {
    const p = createAntigravityCliProvider();
    const permissions = p.translatePermissions({ mode: "edit" }, "exec");
    expect(permissions.args).toEqual([EDIT_MARKER]);
    expect(permissions.report.unsupported).toEqual([]);
    expect(permissions.report.effective.enforcedBy).toEqual([]);
    expect(permissions.report.effective.network).toBe("provider-default");
    expect(p.translateContext({}).unsupported).toEqual([]);
    expect(
      p.translateContext({ profile: "clean", memory: "off" }).unsupported,
    ).toEqual(["context.clean", "memory.off"]);
  });
  it.each([
    { permissions: { mode: "analyze" } },
    { permissions: { mode: "respond" } },
    { permissions: { mode: "unrestricted" } },
    { permissions: { mode: "edit", network: "deny" } },
    { permissions: { mode: "edit", minimumEnforcement: "harness" } },
    { permissions: { mode: "edit", minimumEnforcement: "sandbox" } },
    { permissions: { mode: "edit", minimumEnforcement: "external" } },
    { permissions: { mode: "edit", additionalDirectories: ["/extra"] } },
    { context: { profile: "clean" } },
    { context: { memory: "off" } },
    { instructions: "privileged" },
    { effort: "high" },
    { providerOptions: { external: { antigravity: { unsafe: true } } } },
  ])("rejects unsupported agent intent: %j", (extra) => {
    const p = createAntigravityCliProvider();
    expect(() =>
      p.validateOptions?.(
        {
          model: "antigravity/flash-low",
          permissions: { mode: "edit" },
          ...extra,
        } as AgentOptions,
        "exec",
      ),
    ).toThrow();
  });
});
