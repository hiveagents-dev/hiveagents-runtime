import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { UnsupportedCapabilityError } from "../../public/errors.js";
import { ANALYZE_POLICY, READ_TOOLS } from "./policy.js";

const unsupported = (message: string): never => {
  throw new UnsupportedCapabilityError(
    { provider: "gemini", transport: "exec", retryable: false },
    message,
  );
};
const object = (x: unknown): Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
export function systemConfigDirectory(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "darwin"
    ? "/Library/Application Support/GeminiCli"
    : platform === "win32"
      ? "C:\\ProgramData\\gemini-cli"
      : "/etc/gemini-cli";
}

/** Never replace existing system policy authority: 0.56 ignores --admin-policy there. */
export async function assertNoSystemPolicies(
  directory = join(systemConfigDirectory(), "policies"),
): Promise<void> {
  try {
    if ((await readdir(directory)).some((name) => name.endsWith(".toml")))
      unsupported(
        "Gemini analyze overlay is ineffective when system policies exist",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function restrictSystemSettings(
  original: unknown,
): Record<string, unknown> {
  const value = object(original);
  const tools = object(value.tools);
  // An existing smaller core allowlist or exclusion list remains authoritative.
  const core = Array.isArray(tools.core)
    ? READ_TOOLS.filter((tool) => (tools.core as unknown[]).includes(tool))
    : [...READ_TOOLS];
  return {
    ...value,
    hooksConfig: { ...object(value.hooksConfig), enabled: false },
    tools: { ...tools, core },
  };
}

export async function prepareAnalyzeEnvelope(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}> {
  await assertNoSystemPolicies();
  const systemPath =
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ??
    join(systemConfigDirectory(), "settings.json");
  if (!isAbsolute(systemPath))
    unsupported("Gemini system settings path must be absolute");
  let original: unknown = {};
  try {
    original = JSON.parse(await readFile(systemPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      unsupported("Cannot safely preserve Gemini administrative settings");
  }
  if (
    typeof original !== "object" ||
    original === null ||
    Array.isArray(original)
  )
    unsupported("Gemini administrative settings must be a JSON object");
  if (object(original).adminPolicyPaths !== undefined)
    unsupported(
      "Existing custom administrative policies cannot be safely composed with Gemini analyze",
    );
  const home = env.GEMINI_CLI_HOME ?? env.HOME ?? env.USERPROFILE ?? homedir();
  for (const path of [
    env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ??
      join(dirname(systemPath), "system-defaults.json"),
    join(home, ".gemini", "settings.json"),
    join(cwd, ".gemini", "settings.json"),
  ]) {
    let settings: unknown;
    try {
      settings = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      unsupported(
        "Cannot safely inspect Gemini administrative policy settings",
      );
    }
    if (
      typeof settings !== "object" ||
      settings === null ||
      Array.isArray(settings)
    )
      unsupported(
        "Gemini settings must be a JSON object to preserve policy authority",
      );
    if (Object.hasOwn(settings as object, "adminPolicyPaths"))
      unsupported(
        "Existing custom administrative policies cannot be safely composed with Gemini analyze",
      );
  }
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "oar-gemini-")),
  );
  try {
    const settingsPath = join(directory, "settings.json"),
      policyPath = join(directory, "analyze.toml");
    await writeFile(
      settingsPath,
      JSON.stringify(restrictSystemSettings(original)),
      { mode: 0o600 },
    );
    await writeFile(policyPath, ANALYZE_POLICY, { mode: 0o600 });
    return {
      args: ["--admin-policy", policyPath, "--extensions", "none"],
      env: {
        ...env,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH:
          env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ??
          join(dirname(systemPath), "system-defaults.json"),
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
