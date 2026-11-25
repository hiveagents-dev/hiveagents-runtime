import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecTurnRequest, ProcessRunner } from "../../../src/index.js";
import { AntigravityExecAdapter } from "../../../src/adapters/antigravity/exec-adapter.js";
import { EDIT_MARKER } from "../../../src/adapters/antigravity/policy.js";
const fixture = fileURLToPath(
  new URL("./fixtures/antigravity-cli.mjs", import.meta.url),
);
const directories: string[] = [];
const adapter = (runner?: ProcessRunner) =>
  new AntigravityExecAdapter({
    target: { command: process.execPath, argsPrefix: [fixture] },
    ...(runner ? { runner } : {}),
  });
async function request(
  extra: Partial<ExecTurnRequest> = {},
): Promise<ExecTurnRequest> {
  const cwd = await mkdtemp(join(tmpdir(), "antigravity-test-"));
  directories.push(cwd);
  return {
    mode: "open",
    modelId: "gemini-3.8-flash-low",
    cwd,
    prompt: "hello",
    env: { PATH: process.env.PATH, HOME: cwd },
    contextArgs: [],
    permissionArgs: [EDIT_MARKER],
    timeoutMs: 3000,
    maxOutputBytes: 100000,
    ...extra,
  };
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
describe("Antigravity subprocess contract", () => {
  it("classifies documented stderr-only authentication failure without exposing diagnostics", async () => {
    const req = await request();
    req.env.FAKE_SCENARIO = "stderr-auth";
    const result = await adapter().execute(req);
    expect(result).toMatchObject({
      completed: false,
      failure: { kind: "not-authenticated" },
    });
    expect(result.sessionId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET_TOKEN");
  });
  it("streams split UTF8 and resumes exact native identity in a second process", async () => {
    const a = adapter(),
      req = await request();
    const memory = join(req.cwd, "memory");
    req.env.FAKE_MEMORY = memory;
    req.prompt = "nonce-known-only-in-first-process";
    const first = await a.execute(req);
    expect(first).toMatchObject({
      completed: true,
      text: "nonce-known-only-in-first-process",
      sessionId: "b501d899-978f-4497-a0ca-0400db2a25a2",
      usage: { inputTokens: 100 },
    });
    const resumed = adapter();
    const items = [];
    for await (const item of resumed.stream({
      ...req,
      prompt: "what did I say?",
      mode: "resume",
      sessionId: first.sessionId!,
    }))
      items.push(item);
    expect(items[0]).toMatchObject({
      kind: "session",
      sessionId: first.sessionId,
    });
    expect(items.at(-1)).toMatchObject({
      kind: "result",
      result: {
        completed: true,
        text: "nonce-known-only-in-first-process",
        usage: { costMeaning: "unavailable" },
      },
    });
    const terminal = items.at(-1);
    if (terminal?.kind === "result")
      expect(terminal.result.usage?.inputTokens).toBeUndefined();
    expect(await adapter().execute(await request())).toMatchObject({
      completed: true,
      text: "¡Hola!\n",
    });
  });
  it("accepts the verified 1.5.15 text and resume contract", async () => {
    const first = await request();
    first.env.FAKE_VERSION = "1.5.15";
    const engine = adapter();
    expect(await engine.compatibility(first.env, "1.5.15")).toMatchObject({
      cliVersion: "1.5.15",
      evidence: "help-probe",
      features: { turns: "supported", resume: "supported", structuredOutput: "unsupported" },
    });
    const initial = await engine.execute(first);
    expect(initial.completed).toBe(true);
    assert.ok(initial.sessionId);
    expect(await engine.execute({ ...first, mode: "resume", sessionId: initial.sessionId })).toMatchObject({
      completed: true,
      sessionId: initial.sessionId,
      text: initial.text,
    });
  });
  it("passes slash/flag/metacharacter prompt as a single literal argument", async () => {
    const req = await request({
      prompt: "/custom $(touch nope) --dangerously-skip-permissions",
    });
    req.env.FAKE_ARGS = join(req.cwd, "args");
    expect((await adapter().execute(req)).completed).toBe(true);
    const args = JSON.parse(
      await readFile(req.env.FAKE_ARGS, "utf8"),
    ) as string[];
    expect(args).toContain(
      "--print=/custom $(touch nope) --dangerously-skip-permissions",
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
  it("fails incomplete output after native EOF", async () => {
    const req = await request();
    req.env.FAKE_SCENARIO = "incomplete";
    expect(await adapter().execute(req)).toMatchObject({
      completed: false,
      failure: { kind: "protocol" },
    });
  });
  it("terminates immediately for unsafe effective permissions", async () => {
    const req = await request();
    req.env.FAKE_SCENARIO = "unsafe";
    await expect(adapter().execute(req)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      context: { retryable: false },
    });
  });
  it("does not launch for incompatible options or invalid resume selectors", async () => {
    let calls = 0;
    const a = adapter(async () => {
      calls++;
      throw new Error("unexpected process");
    });
    for (const extra of [
      { mode: "fork" },
      { instructions: "system" },
      { effort: "high" },
      { outputSchema: {} },
      { permissionArgs: ["--yolo"] },
      { contextArgs: ["--settings"] },
      { mode: "resume", sessionId: "latest" },
      { providerOptions: { unsafe: true } },
    ]) {
      await expect(
        a.execute(await request(extra as Partial<ExecTurnRequest>)),
      ).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it("aborts before probes, times out and cancels a live child", async () => {
    let calls = 0;
    await expect(
      adapter(async () => {
        calls++;
        throw new Error("unexpected");
      }).execute(await request({ signal: AbortSignal.abort() })),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls).toBe(0);
    const req = await request({ timeoutMs: 300 });
    req.env.FAKE_SCENARIO = "hang";
    await expect(adapter().execute(req)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    const controller = new AbortController(),
      stream = adapter()
        .stream({ ...req, timeoutMs: 3000, signal: controller.signal })
        [Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: "session" });
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: "ABORTED" });
  });
  it("awaits child cleanup when a consumer abandons streaming", async () => {
    const req = await request();
    req.env.FAKE_SCENARIO = "hang";
    const stream = adapter().stream(req)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: "session" });
    await stream.return?.();
  });
  it("enforces total output, frame, UTF8 and bounded stream handoff", async () => {
    const req = await request();
    req.env.FAKE_SCENARIO = "large";
    await expect(
      adapter().execute({ ...req, maxOutputBytes: 1024 }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    req.env.FAKE_SCENARIO = "invalid-utf8";
    await expect(adapter().execute(req)).rejects.toThrow();
    req.env.FAKE_SCENARIO = "oversized-frame";
    await expect(
      adapter().execute({ ...req, maxOutputBytes: 2000000 }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    req.env.FAKE_SCENARIO = "frames";
    const stream = adapter()
      .stream({ ...req, maxOutputBytes: 500000 })
      [Symbol.asyncIterator]();
    await stream.next();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(
      (async () => {
        for (;;) {
          const next = await stream.next();
          if (next.done) break;
        }
      })(),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });
  it.skipIf(process.platform === "win32")(
    "kills descendants while the original leader remains live through timeout escalation",
    async () => {
      const req = await request({ timeoutMs: 600 });
      req.env.FAKE_SCENARIO = "descendant";
      req.env.FAKE_PID = join(req.cwd, "descendant.pid");
      await expect(adapter().execute(req)).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      const pid = Number(await readFile(req.env.FAKE_PID, "utf8"));
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 1500, interval: 20 },
        )
        .toBe(false);
    },
  );
  it("does only version/help on doctor readiness, leaving auth unverified", async () => {
    const calls: string[][] = [];
    const { runProcess } = await import("../../../src/public/adapter-kit.js");
    const a = adapter(async (req) => {
      calls.push(req.args);
      return runProcess(req);
    });
    const env = { PATH: process.env.PATH };
    expect(await a.detect(env)).toMatchObject({
      installed: true,
      version: "1.5.3",
    });
    expect(await a.compatibility(env, "1.5.3")).toMatchObject({
      evidence: "help-probe",
      missingFlags: [],
    });
    expect(await a.auth(env)).toMatchObject({
      authenticated: false,
      state: "unknown",
      source: "unknown",
    });
    expect(await a.auth(env)).not.toHaveProperty("evidence");
    expect(calls.map((args) => args.at(-1))).toEqual(["--version", "--help"]);
  });
});
