import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GeminiExecAdapter } from "../../../src/adapters/gemini/exec-adapter.js";
import { ANALYZE_MARKER } from "../../../src/adapters/gemini/policy.js";
import type { ExecTurnRequest } from "../../../src/index.js";
const fixture = fileURLToPath(
  new URL("./fixtures/gemini-cli.mjs", import.meta.url),
);
const directories: string[] = [];
const adapter = () =>
  new GeminiExecAdapter({
    target: { command: process.execPath, argsPrefix: [fixture] },
  });
async function request(
  extra: Partial<ExecTurnRequest> = {},
): Promise<ExecTurnRequest> {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-test-"));
  directories.push(cwd);
  return {
    mode: "open",
    modelId: "gemini-test",
    cwd,
    prompt: "hello",
    env: { PATH: process.env.PATH, HOME: cwd },
    contextArgs: [],
    permissionArgs: [ANALYZE_MARKER],
    timeoutMs: 3000,
    maxOutputBytes: 100_000,
    ...extra,
  };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("external Gemini exec fixture", () => {
  it("executes, streams and resumes an exact native ID", async () => {
    const a = adapter(),
      req = await request();
    const first = await a.execute(req);
    expect(first.completed).toBe(true);
    const items = [];
    for await (const item of a.stream({
      ...req,
      mode: "resume",
      sessionId: first.sessionId!,
    }))
      items.push(item);
    expect(items.find((i) => i.kind === "session")).toMatchObject({
      sessionId: first.sessionId,
    });
    expect(items.at(-1)).toMatchObject({
      kind: "result",
      result: { completed: true, text: "¡Hola!" },
    });
  });
  it("fails incomplete output", async () =>
    expect(
      await adapter().execute(
        await request({ env: { ...process.env, FAKE_SCENARIO: "incomplete" } }),
      ),
    ).toMatchObject({ failure: { kind: "protocol" } }));
  it("does not launch with schema, fork, privileged channel or foreign args", async () => {
    for (const extra of [
      { outputSchema: {} },
      { mode: "fork" },
      { instructions: "system" },
      { effort: "high" },
      { permissionArgs: ["--yolo"] },
    ])
      await expect(
        adapter().execute(await request(extra as Partial<ExecTurnRequest>)),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
  it("aborts before spawn and times out a live fake process", async () => {
    await expect(
      adapter().execute(await request({ signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await expect(
      adapter().execute(
        await request({
          env: { ...process.env, FAKE_SCENARIO: "hang" },
          timeoutMs: 500,
        }),
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("cancels and cleans temporary settings when stream iterator is abandoned", async () => {
    const a = adapter(),
      req = await request({ env: { ...process.env, FAKE_SCENARIO: "hang" } });
    const stream = a.stream(req)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: "session" });
    await stream.return?.();
  });
  it("passes restrictive ephemeral settings and cleans them after process settlement", async () => {
    let settingsPath = "";
    const { runProcess } = await import("../../../src/public/adapter-kit.js");
    const a = new GeminiExecAdapter({
      target: { command: process.execPath, argsPrefix: [fixture] },
      runner: async (req) => {
        if (req.args.some((arg) => arg.startsWith("--prompt="))) {
          settingsPath = req.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
          const settings = JSON.parse(await readFile(settingsPath, "utf8"));
          expect(settings).toMatchObject({
            hooksConfig: { enabled: false },
            tools: {
              core: ["glob", "grep_search", "list_directory", "read_file"],
            },
          });
          expect(req.args).toContain("--admin-policy");
        }
        return runProcess(req);
      },
    });
    expect((await a.execute(await request())).completed).toBe(true);
    await expect(readFile(settingsPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("enforces output limit and abort during a running fake", async () => {
    await expect(
      adapter().execute(
        await request({
          env: { ...process.env, FAKE_SCENARIO: "large" },
          maxOutputBytes: 1024,
        }),
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    const abort = new AbortController();
    const req = await request({
      env: { ...process.env, FAKE_SCENARIO: "hang" },
      signal: abort.signal,
    });
    const stream = adapter().stream(req)[Symbol.asyncIterator]();
    await stream.next();
    abort.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: "ABORTED" });
  });
  it.skipIf(process.platform === "win32")(
    "cleans an ignoring descendant while its original leader retains group ownership",
    async () => {
      const req = await request();
      const pidPath = join(req.cwd, "descendant.pid");
      await expect(
        adapter().execute({
          ...req,
          timeoutMs: 800,
          env: { ...req.env, FAKE_SCENARIO: "descendant", FAKE_PID: pidPath },
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      const pid = Number(await readFile(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
  it.each([
    "latest",
    "1",
    "-1",
    "session-A",
    "11111111-1111-4111-8111-11111111111",
  ])("rejects resume selector %s before any process", async (sessionId) => {
    let calls = 0;
    const a = new GeminiExecAdapter({
      runner: async () => {
        calls++;
        throw new Error("must not launch");
      },
    });
    await expect(
      a.execute(await request({ mode: "resume", sessionId })),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("reports sanitized startup exit metadata without dropping stderr evidence or exposing contents", async () => {
    const a = new GeminiExecAdapter({
      target: { command: process.execPath, argsPrefix: [fixture] },
      runner: async (req) => {
        if (req.args.includes("--version"))
          return {
            code: 0,
            signal: null,
            stdout: "0.56.0",
            stderr: "",
            durationMs: 0,
          };
        if (req.args.includes("--help"))
          return {
            code: 0,
            signal: null,
            stdout: [
              "--prompt",
              "--model",
              "--output-format",
              "--resume",
              "--admin-policy",
              "--approval-mode",
              "--extensions",
            ]
              .map((flag) => `  ${flag}  fixture`)
              .join("\n"),
            stderr: "",
            durationMs: 0,
          };
        return {
          code: 1,
          signal: null,
          stdout: "",
          stderr: "secret-token-and-private-path",
          durationMs: 5,
        };
      },
    });
    const result = await a.execute(await request());
    expect(result).toMatchObject({
      failure: { kind: "provider-unavailable", rawCode: "EXIT_1" },
    });
    expect(result.failure?.message).toContain("stderrBytes=29");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
  it.each([
    [
      55,
      "IneligibleTierError: unavailable\n  reasonCode: 'UNSUPPORTED_CLIENT'\nThis folder is not trusted.",
      "",
      "UNSUPPORTED_CLI_VERSION",
      "UNSUPPORTED_CLIENT",
    ],
    [55, "This folder is not trusted.", "", "untrusted-workspace", "EXIT_55"],
    [41, "Authentication required", "", "not-authenticated", "41"],
    [55, "reasonCode: 'UNSUPPORTED_CLIENT'", "{bad", "protocol", undefined],
  ])(
    "classifies versioned startup failure exit%s without overriding protocol evidence",
    async (code, stderr, stdout, expected, rawCode) => {
      const { runProcess } = await import("../../../src/public/adapter-kit.js");
      const a = new GeminiExecAdapter({
        target: { command: process.execPath, argsPrefix: [fixture] },
        runner: async (req) =>
          req.args.some((arg) => arg.startsWith("--prompt="))
            ? { code, signal: null, stdout, stderr, durationMs: 0 }
            : runProcess(req),
      });
      const turn = a.execute(await request());
      if (expected === "UNSUPPORTED_CLI_VERSION")
        await expect(turn).rejects.toMatchObject({
          code: expected,
          context: { rawCode, retryable: false },
        });
      else
        expect((await turn).failure).toMatchObject({
          kind: expected,
          ...(rawCode ? { rawCode } : {}),
        });
    },
  );
});
