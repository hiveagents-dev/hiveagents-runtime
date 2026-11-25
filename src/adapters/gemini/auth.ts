import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { AuthStatus } from "../../public/types.js";
import { systemConfigDirectory } from "./envelope.js";

type AuthConfiguration = {
  selectedType?: unknown;
  enforcedType?: unknown;
  useExternal?: unknown;
};
function authConfiguration(settings: unknown): AuthConfiguration {
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  )
    throw new TypeError("Unknown settings shape");
  return (
    (settings as { security?: { auth?: AuthConfiguration } }).security?.auth ??
    {}
  );
}
function environmentMethod(env: NodeJS.ProcessEnv): string | undefined {
  // Same precedence as Gemini 0.56 getAuthTypeFromEnv; GOOGLE_API_KEY alone selects no method.
  if (env.GOOGLE_GENAI_USE_GCA === "true") return "oauth-personal";
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") return "vertex-ai";
  if (env.GOOGLE_GEMINI_BASE_URL) return "gateway";
  if (env.GEMINI_API_KEY) return "gemini-api-key";
  if (env.CLOUD_SHELL === "true" || env.GEMINI_CLI_USE_COMPUTE_ADC === "true")
    return "compute-default-credentials";
  return undefined;
}
function classifyMethod(method: unknown): AuthStatus["source"] {
  switch (method) {
    case "oauth-personal":
      return "oauth";
    case "gemini-api-key":
      return "api-key";
    case "vertex-ai":
    case "cloud-shell":
    case "compute-default-credentials":
      return "cloud-provider";
    default:
      return "unknown";
  }
}

/** Passive local-method evidence only; no login, refresh, model or subscription entitlement probe. */
export async function inspectGeminiAuth(
  env: NodeJS.ProcessEnv,
): Promise<AuthStatus> {
  let source: AuthStatus["source"] = "unknown";
  const home = env.GEMINI_CLI_HOME ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const systemPath =
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ??
    join(systemConfigDirectory(), "settings.json");
  try {
    if (!isAbsolute(systemPath))
      throw new TypeError("Unknown administrative settings path");
    let configured: AuthConfiguration = {};
    for (const path of [
      env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ??
        join(dirname(systemPath), "system-defaults.json"),
      join(home, ".gemini", "settings.json"),
      systemPath,
    ]) {
      try {
        configured = {
          ...configured,
          ...authConfiguration(JSON.parse(await readFile(path, "utf8"))),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const method = configured.selectedType || environmentMethod(env);
    if (
      !configured.useExternal &&
      (!configured.enforcedType || configured.enforcedType === method)
    )
      source = classifyMethod(method);
    // auth(env) has no requested cwd/trust parameter. An auth override in the observed workspace is ambiguous.
    try {
      const workspace = authConfiguration(
        JSON.parse(
          await readFile(
            join(process.cwd(), ".gemini", "settings.json"),
            "utf8",
          ),
        ),
      );
      if (Object.keys(workspace).length) source = "unknown";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        source = "unknown";
    }
  } catch {
    /* Unreadable/malformed higher settings cannot support a confident method classification. */
  }
  return {
    authenticated: false,
    state: "unknown",
    source,
    evidence: "local-configuration",
  };
}
