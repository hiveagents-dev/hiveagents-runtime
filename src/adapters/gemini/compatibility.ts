import type { CapabilitySupport } from "../../public/types.js";
import type { CliCompatibilityAssessment } from "../../compatibility/manifest.js";
export const GEMINI_VERSION = "0.56.0";
/**
 * Turns, resume, deltas and the analyze policy are implemented and pass against fake processes,
 * but no live Gemini turn has succeeded (docs/validation/2026-11-08-gemini-external-provider.md:
 * Google rejected local OAuth with UNSUPPORTED_CLIENT). They stay "unverified": readiness and
 * requireExecFeature still allow them, while a capability marked `required` is not satisfied by
 * unknown evidence. The adapter has no refusal signal, so refusalDetection is "unsupported".
 */
export const EXEC_CAPABILITIES: Readonly<Record<string, CapabilitySupport>> =
  Object.freeze({
    turns: "unverified",
    resume: "unverified",
    messageDeltas: "unverified",
    tokenDeltas: "unverified",
    permissions: "unverified",
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
    refusalDetection: "unsupported",
    images: "unsupported",
    files: "unsupported",
  });
export function assessGeminiCompatibility(
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
  // Exactly the flags argv.ts and envelope.ts pass. --approval-mode is not one of them: the
  // analyze admin policy denies under every approval mode (installed-policy-contract test), so the
  // adapter never pins one and a CLI without the flag is not incompatible.
  const missingFlags = [
    "--prompt",
    "--model",
    "--output-format",
    "--resume",
    "--admin-policy",
    "--extensions",
  ].filter((f) => !flags.has(f));
  const verified = version === GEMINI_VERSION && missingFlags.length === 0;
  const features = { ...EXEC_CAPABILITIES };
  return {
    provider: "gemini",
    cliVersion: version,
    transport: "exec",
    evidence: verified ? "help-probe" : "unverified",
    features,
    missingFlags,
    knownIssues: [
      "Analyze requires an empty system policy directory and temporary restrictive administrative settings.",
      "Google OAuth does not establish subscription entitlement.",
    ],
  };
}
