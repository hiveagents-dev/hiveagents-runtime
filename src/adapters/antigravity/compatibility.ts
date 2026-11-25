import type { CapabilitySupport } from "../../public/types.js";
import type { CliCompatibilityAssessment } from "../../compatibility/manifest.js";
const TESTED_CLI_VERSIONS = new Set(["1.5.3", "1.5.15"]);
export function isTestedAntigravityCliVersion(version: string | undefined): version is string {
  return version !== undefined && TESTED_CLI_VERSIONS.has(version);
}
export const REQUIRED_FLAGS = [
  "--print",
  "--model",
  "--output-format",
  "--conversation",
  "--disable-slash-commands",
  "--settings",
  "--print-timeout",
] as const;
export const EXEC_CAPABILITIES: Readonly<Record<string, CapabilitySupport>> =
  Object.freeze({
    turns: "supported",
    resume: "supported",
    messageDeltas: "supported",
    tokenDeltas: "supported",
    permissions: "partial",
    forkWithPrompt: "unsupported",
    forkWithoutPrompt: "unsupported",
    structuredOutput: "unsupported",
    cleanContext: "unsupported",
    interactiveApprovals: "unsupported",
    userInputDuringTurn: "unsupported",
    steering: "unsupported",
    inProcessTools: "unsupported",
    processPersistence: "unsupported",
    dynamicPermissions: "unsupported",
    sessionInspection: "unsupported",
    checkpointOrRollback: "unsupported",
    subagentLifecycle: "unsupported",
    subagentMessages: "unsupported",
    subagentDeltas: "unsupported",
    // protocol.ts has no refusal signal in the result event; turns never report refused.
    refusalDetection: "unsupported",
    images: "unsupported",
    files: "unsupported",
  });
export function assessAntigravityCompatibility(
  version: string,
  help: string,
): CliCompatibilityAssessment {
  const flags = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    if (!/^\s*-/.test(line)) continue;
    for (const match of (line.trimStart().split(/ {2,}|\t/)[0] ?? "").matchAll(
      /--[\w-]+/g,
    ))
      flags.add(match[0]);
  }
  const missingFlags = REQUIRED_FLAGS.filter((flag) => !flags.has(flag));
  const verified = isTestedAntigravityCliVersion(version) && missingFlags.length === 0;
  return {
    provider: "antigravity",
    cliVersion: version,
    transport: "exec",
    evidence: verified ? "help-probe" : "unverified",
    missingFlags,
    features: Object.fromEntries(
      Object.entries(EXEC_CAPABILITIES).map(([key, value]) => [
        key,
        (value === "supported" || value === "partial") && !verified
          ? "unsupported"
          : value,
      ]),
    ),
    knownIssues: [
      "Only explicit edit intent is supported; request-review is not a read-only sandbox.",
      "Native configuration, grants and startup side effects remain active.",
      "Authentication and model entitlement remain unverified until a turn succeeds.",
    ],
  };
}
