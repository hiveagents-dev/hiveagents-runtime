import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { inspectGeminiAuth } from "../../../src/adapters/gemini/auth.js";
describe("passive auth evidence", () => {
  it.each([
    [{}, "unknown"],
    [{ GEMINI_API_KEY: "do-not-echo" }, "api-key"],
    [{ GOOGLE_GENAI_USE_VERTEXAI: "true" }, "cloud-provider"],
    [{ GOOGLE_API_KEY: "not-a-gemini-method" }, "unknown"],
    [
      {
        GOOGLE_GENAI_USE_GCA: "true",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GEMINI_API_KEY: "hidden",
      },
      "oauth",
    ],
    [
      {
        GOOGLE_GEMINI_BASE_URL: "https://gateway.invalid",
        GEMINI_API_KEY: "hidden",
      },
      "unknown",
    ],
    [{ CLOUD_SHELL: "true" }, "cloud-provider"],
  ])("classifies environment without claiming usability", async (env, source) =>
    expect(await inspectGeminiAuth({ ...env, HOME: "/no-such-home" })).toEqual({
      authenticated: false,
      state: "unknown",
      source,
      evidence: "local-configuration",
    }),
  );
  it("Google OAuth cache and selected method never imply subscription or valid credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "gemini-auth-"));
    try {
      await mkdir(join(home, ".gemini"));
      await writeFile(
        join(home, ".gemini", "settings.json"),
        JSON.stringify({
          security: { auth: { selectedType: "oauth-personal" } },
        }),
      );
      const auth = await inspectGeminiAuth({
        GEMINI_CLI_HOME: home,
        GEMINI_API_KEY: "must-not-override-selected-oauth",
      });
      expect(auth.source).toBe("oauth");
      expect(auth.authenticated).toBe(false);
      expect(JSON.stringify(auth)).not.toContain(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("reports unknown when higher administrative auth evidence cannot be inspected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gemini-auth-admin-"));
    try {
      const system = join(directory, "system.json");
      await writeFile(system, "{/* unverifiable JSONC */}");
      expect(
        (
          await inspectGeminiAuth({
            GEMINI_API_KEY: "hidden",
            HOME: directory,
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
          })
        ).source,
      ).toBe("unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
