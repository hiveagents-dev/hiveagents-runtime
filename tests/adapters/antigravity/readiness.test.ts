import { fileURLToPath } from "node:url";
import { Agent, Runtime } from "../../../src/index.js";
import type { ProcessRunner } from "../../../src/index.js";
import { expect, it } from "vitest";
import { createAntigravityCliProvider } from "../../../src/adapters/antigravity/index.js";
const fixture = fileURLToPath(
  new URL("./fixtures/antigravity-cli.mjs", import.meta.url),
);
const help = [
  "--print",
  "--model",
  "--output-format",
  "--conversation",
  "--disable-slash-commands",
  "--settings",
  "--print-timeout",
]
  .map((flag) => `  ${flag}  native option`)
  .join("\n");
it.each(["version", "unobserved-patch", "flags"])(
  "rejects Agent.ready for incompatible CLI %s without a prompt",
  async (mismatch) => {
    const cliVersion = mismatch === "version" ? "1.5.4" : mismatch === "unobserved-patch" ? "1.5.16" : "1.5.15";
    const calls: string[][] = [];
    const runner: ProcessRunner = async (request) => {
      calls.push(request.args);
      const version = request.args.includes("--version");
      if (!version && !request.args.includes("--help"))
        throw new Error("unexpected prompt launch");
      return {
        code: 0,
        signal: null,
        stdout: version ? cliVersion : "",
        stderr: version
          ? ""
          : mismatch === "flags"
            ? "  --print  native option"
            : help,
        durationMs: 0,
      };
    };
    const provider = createAntigravityCliProvider({
      executable: { command: process.execPath, argsPrefix: [fixture] },
      runner,
    });
    const agent = new Agent(
      {
        model: "antigravity/flash-low",
        cwd: process.cwd(),
        permissions: { mode: "edit" },
        requireAuth: "any",
      },
      new Runtime({ providers: [provider] }),
    );
    await expect(agent.ready()).rejects.toMatchObject({
      code: "UNSUPPORTED_CLI_VERSION",
    });
    const capabilities = await provider.exec.adapter.compatibility?.(
      {},
      cliVersion,
    );
    expect(capabilities?.features).toMatchObject({
      turns: "unsupported",
      resume: "unsupported",
      messageDeltas: "unsupported",
      permissions: "unsupported",
    });
    expect(
      calls.every(
        (args) => args.at(-1) === "--help" || args.at(-1) === "--version",
      ),
    ).toBe(true);
  },
);
