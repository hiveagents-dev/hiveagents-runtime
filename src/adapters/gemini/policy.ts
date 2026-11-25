import type { ContextPolicy, PermissionIntent, TransportKind } from "../../public/types.js";
import type { ContextTranslation } from "../../core/context.js";
import type { PermissionTranslation } from "../../core/permissions.js";

export const ANALYZE_MARKER = "oar-gemini-analyze-v1";
export const READ_TOOLS = Object.freeze([
  "glob",
  "grep_search",
  "list_directory",
  "read_file",
] as const);
export const ANALYZE_POLICY = `[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n\n[[rule]]\ntoolName = [${READ_TOOLS.map((t) => JSON.stringify(t)).join(", ")}]\ndecision = "allow"\npriority = 999\n`;

export function translateGeminiContext(
  requested: ContextPolicy = {},
): ContextTranslation {
  const profile = requested.profile ?? "native",
    memory = requested.memory ?? "inherit";
  const unsupported = [
    ...(profile === "native" ? [] : [`context.${profile}`]),
    ...(memory === "inherit" ? [] : [`memory.${memory}`]),
  ];
  return {
    args: [],
    unsupported,
    warnings: [],
    report: {
      profile,
      memory,
      active: [
        "user-settings",
        "workspace-settings",
        "GEMINI.md",
        "provider-memory",
        "native-mcp-configuration",
      ],
      inactive: ["hooks", "extensions"],
      unavoidable: ["admin-managed-policy", "provider-session-storage"],
      unknown: ["mcp-startup-side-effects"],
    },
  };
}

export function translateGeminiPermissions(
  requested: PermissionIntent,
  transport: TransportKind,
): PermissionTranslation {
  const unsupported: string[] = [];
  if (transport !== "exec") unsupported.push("transport.control");
  if (requested.mode !== "analyze")
    unsupported.push(`permissions.${requested.mode}`);
  if (requested.network === "deny") unsupported.push("network.deny");
  if (requested.additionalDirectories?.length)
    unsupported.push("additionalDirectories");
  if (
    requested.minimumEnforcement &&
    requested.minimumEnforcement !== "harness"
  )
    unsupported.push(`minimumEnforcement.${requested.minimumEnforcement}`);
  return {
    args: [ANALYZE_MARKER],
    report: {
      requested: { ...requested },
      effective: {
        filesystem:
          "read tool allowlist; provider session storage remains writable; no OS sandbox",
        network: "provider-default",
        approvals: "deny-unapproved",
        enforcedBy: ["harness"],
      },
      unsupported,
      warnings: [
        "Analyze restricts model tools; Gemini still writes its own session and telemetry state.",
      ],
    },
  };
}
