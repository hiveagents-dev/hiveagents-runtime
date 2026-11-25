import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GeminiExecAdapter } from "../../../src/adapters/gemini/exec-adapter.js";
import { assessGeminiCompatibility } from "../../../src/adapters/gemini/compatibility.js";
import {
  assertNoSystemPolicies,
  prepareAnalyzeEnvelope,
  restrictSystemSettings,
} from "../../../src/adapters/gemini/envelope.js";
describe("passive discovery and policy prerequisites", () => {
  it("falls through broken PATH executable and honors missing explicit target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gemini-discovery-"));
    try {
      for (const [name, body] of [
        ["broken", "exit 1"],
        ["healthy", "echo 0.56.0"],
      ] as const) {
        const dir = join(directory, name);
        await mkdir(dir);
        await writeFile(join(dir, "gemini"), "#!/bin/sh\n" + body + "\n");
        await chmod(join(dir, "gemini"), 0o755);
      }
      const env = {
        PATH: [join(directory, "broken"), join(directory, "healthy")].join(
          delimiter,
        ),
      };
      expect(await new GeminiExecAdapter().detect(env)).toMatchObject({
        installed: true,
        version: "0.56.0",
        path: await realpath(join(directory, "healthy", "gemini")),
      });
      expect(
        await new GeminiExecAdapter({
          target: { command: join(directory, "missing"), argsPrefix: [] },
        }).detect(env),
      ).toMatchObject({ installed: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not treat flags mentioned in prose as support", () =>
    expect(
      assessGeminiCompatibility(
        "0.56.0",
        "Please use --prompt --model --output-format --resume --admin-policy --extensions",
      ).missingFlags,
    ).toHaveLength(6));
  it("probes exactly the flags the adapter passes; --approval-mode is never passed", () => {
    const help = [
      "--prompt",
      "--model",
      "--output-format",
      "--resume",
      "--admin-policy",
      "--extensions",
    ]
      .map((flag) => `  ${flag}  fixture`)
      .join("\n");
    expect(assessGeminiCompatibility("0.56.0", help)).toMatchObject({
      evidence: "help-probe",
      missingFlags: [],
    });
  });
  it("never claims live-verified support: no live Gemini turn has succeeded", () => {
    const help = [
      "--prompt",
      "--model",
      "--output-format",
      "--resume",
      "--admin-policy",
      "--extensions",
    ]
      .map((flag) => `  ${flag}  fixture`)
      .join("\n");
    const { features } = assessGeminiCompatibility("0.56.0", help);
    expect(Object.values(features)).not.toContain("supported");
    expect(features).toMatchObject({
      turns: "unverified",
      resume: "unverified",
      messageDeltas: "unverified",
      tokenDeltas: "unverified",
      permissions: "unverified",
      refusalDetection: "unsupported",
    });
  });
  it("requires extensions flag before claiming compatible analyze execution", () => {
    const help = [
      "--prompt",
      "--model",
      "--output-format",
      "--resume",
      "--admin-policy",
    ]
      .map((flag) => `  ${flag}  fixture`)
      .join("\n");
    expect(assessGeminiCompatibility("0.56.0", help)).toMatchObject({
      missingFlags: ["--extensions"],
      features: { turns: "unverified", permissions: "unverified" },
    });
  });
  it("preserves narrower tool restriction and administrative data", () =>
    expect(
      restrictSystemSettings({
        admin: { secureModeEnabled: true },
        tools: { core: ["read_file"], exclude: ["read_file"] },
        hooksConfig: { enabled: true },
      }),
    ).toMatchObject({
      admin: { secureModeEnabled: true },
      tools: { core: ["read_file"], exclude: ["read_file"] },
      hooksConfig: { enabled: false },
    }));
  it("rejects system policy even when empty content or unknown effective rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gemini-admin-"));
    try {
      await writeFile(join(directory, "existing.toml"), "");
      await expect(assertNoSystemPolicies(directory)).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("preserves system defaults path and rejects unsafe original custom policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gemini-settings-"));
    const path = join(directory, "settings.json");
    try {
      await writeFile(path, JSON.stringify({ tools: { core: ["read_file"] } }));
      const envelope = await prepareAnalyzeEnvelope(
        { HOME: directory, GEMINI_CLI_SYSTEM_SETTINGS_PATH: path },
        directory,
      );
      expect(envelope.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe(
        join(directory, "system-defaults.json"),
      );
      const temp = envelope.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
      expect(JSON.parse(await readFile(temp, "utf8")).tools.core).toEqual([
        "read_file",
      ]);
      await envelope.cleanup();
      await writeFile(
        path,
        JSON.stringify({ adminPolicyPaths: ["/existing"] }),
      );
      await expect(
        prepareAnalyzeEnvelope(
          { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path },
          directory,
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects decoded custom administrative keys and unverifiable JSONC in every settings scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gemini-decoded-settings-"));
    const system = join(directory, "system.json");
    const home = join(directory, "home"),
      cwd = join(directory, "cwd");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await mkdir(join(cwd, ".gemini"), { recursive: true });
    const defaults = join(directory, "defaults.json");
    const env = {
      HOME: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults,
    };
    try {
      for (const path of [
        defaults,
        join(home, ".gemini", "settings.json"),
        join(cwd, ".gemini", "settings.json"),
      ]) {
        for (const content of [
          '{"adminPolicy\\u0050aths":["/existing"]}',
          '{/* comment */"tools":{}}',
        ]) {
          await writeFile(path, content);
          await expect(prepareAnalyzeEnvelope(env, cwd)).rejects.toMatchObject({
            code: "UNSUPPORTED_CAPABILITY",
          });
        }
        await rm(path);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
