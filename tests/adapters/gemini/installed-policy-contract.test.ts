import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveInstalledRuntime } from "./fixtures/installed-runtime.js";
import { ANALYZE_POLICY } from "../../../src/adapters/gemini/policy.js";
// Explicit, opt-in installed-source contract. Imports policy engine only; never authenticates or invokes CLI/model.
const bundle = process.env.OAR_GEMINI_BUNDLE;
describe.skipIf(!bundle)(
  "Gemini 0.56 installed policy engine, zero inference",
  () => {
    it("binds source hashes to executable main, policy and settings imports", async () => {
      const runtime = await resolveInstalledRuntime(bundle!);
      expect(Object.keys(runtime.hashes)).toHaveLength(4);
      console.log("Gemini runtime provenance", JSON.stringify(runtime.hashes));
    });
    it("admin restriction wins user allow, all approval modes, trusted and untrusted workspaces", async () => {
      const core = await import(
        pathToFileURL((await resolveInstalledRuntime(bundle!)).core).href
      );
      const directory = await mkdtemp(join(tmpdir(), "gemini-policy-"));
      try {
        const admin = join(directory, "admin"),
          user = join(directory, "user"),
          workspace = join(directory, "workspace");
        for (const dir of [admin, user, workspace]) await mkdir(dir);
        await writeFile(join(admin, "analyze.toml"), ANALYZE_POLICY);
        await writeFile(
          join(user, "allow.toml"),
          '[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 999\n',
        );
        await writeFile(
          join(workspace, "allow.toml"),
          '[[rule]]\ntoolName = "*"\ndecision = "allow"\npriority = 999\n',
        );
        for (const mode of ["default", "autoEdit", "yolo", "plan"]) {
          const config = await core.createPolicyEngineConfig(
            {
              adminPolicyPaths: [admin],
              policyPaths: [user],
              workspacePoliciesDir: workspace,
            },
            mode,
            undefined,
            false,
          );
          const engine = new core.PolicyEngine(config);
          for (const tool of [
            "write_file",
            "replace",
            "run_shell_command",
            "save_memory",
            "mcp__evil__write",
            "enter_plan_mode",
            "exit_plan_mode",
            "future_write_tool",
          ]) {
            const decision = await engine.check({ name: tool, args: {} });
            expect(decision.decision ?? decision).toBe("deny");
          }
          const read = await engine.check({
            name: "read_file",
            args: { file_path: "/tmp/doc" },
          });
          expect(read.decision ?? read).toBe("allow");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("system hook and core-tool restrictions survive trusted workspace settings", async () => {
      const before = { ...process.env };
      const directory = await mkdtemp(
        join(tmpdir(), "gemini-settings-contract-"),
      );
      try {
        const home = join(directory, "home"),
          workspace = join(directory, "workspace");
        await mkdir(join(home, ".gemini"), { recursive: true });
        await mkdir(join(workspace, ".gemini"), { recursive: true });
        const enabling = {
          hooksConfig: { enabled: true },
          tools: { core: ["write_file", "read_file"] },
        };
        await writeFile(
          join(home, ".gemini", "settings.json"),
          JSON.stringify(enabling),
        );
        await writeFile(
          join(workspace, ".gemini", "settings.json"),
          JSON.stringify(enabling),
        );
        const system = join(directory, "system.json");
        await writeFile(
          system,
          JSON.stringify({
            hooksConfig: { enabled: false },
            tools: { core: ["read_file"] },
          }),
        );
        process.env.GEMINI_CLI_HOME = home;
        process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = system;
        process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = join(
          directory,
          "absent.json",
        );
        const cli = await import(
          pathToFileURL((await resolveInstalledRuntime(bundle!)).settings).href
        );
        const settings = cli.loadSettings(workspace);
        for (const trusted of [false, true]) {
          settings.setTrusted(trusted);
          expect(settings.merged.hooksConfig.enabled).toBe(false);
          expect(settings.merged.tools.core).toEqual(["read_file"]);
        }
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
