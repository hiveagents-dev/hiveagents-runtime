import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { AntigravityExecAdapter } from "../../../src/adapters/antigravity/exec-adapter.js";
import { EDIT_MARKER } from "../../../src/adapters/antigravity/policy.js";
const fixture = fileURLToPath(
  new URL("./fixtures/antigravity-cli.mjs", import.meta.url),
);
const directories: string[] = [];
afterEach(async () => {
  for (const cwd of directories.splice(0))
    await rm(cwd, { recursive: true, force: true });
});
it
  .skipIf(process.platform === "win32")
  .each(["permissions", "model", "cwd", "session"])(
  "stops immediately on invalid %s init before delayed parent or descendant writes",
  async (mismatch) => {
    const cwd = await mkdtemp(join(tmpdir(), "antigravity-fail-fast-"));
    directories.push(cwd);
    const effect = join(cwd, "unexpected-write"),
      pidFile = join(cwd, "descendant.pid");
    const adapter = new AntigravityExecAdapter({
      target: { command: process.execPath, argsPrefix: [fixture] },
    });
    const started = Date.now();
    const error = await adapter
      .execute({
        mode: "resume",
        sessionId: "b501d899-978f-4497-a0ca-0400db2a25a2",
        modelId: "gemini-3.8-flash-low",
        cwd,
        prompt: "ignored",
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          FAKE_SCENARIO: `late-mutation-${mismatch}`,
          FAKE_EFFECT: effect,
          FAKE_PID: pidFile,
        },
        contextArgs: [],
        permissionArgs: [EDIT_MARKER],
        timeoutMs: 1500,
        maxOutputBytes: 100000,
      })
      .then(
        () => undefined,
        (error) => error,
      );
    // The process deliberately tries to mutate after exposing the invalid init.
    await expect(readFile(effect, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(error).toMatchObject({
      code: "PROTOCOL_ERROR",
      context: { provider: "antigravity", retryable: false },
    });
    expect(error.message).not.toContain("private-native-value");
    expect(Date.now() - started).toBeLessThan(1000);
    const pid = Number(await readFile(pidFile, "utf8"));
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
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(readFile(effect, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
