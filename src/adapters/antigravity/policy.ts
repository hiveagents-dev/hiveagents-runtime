import type { ContextPolicy, PermissionIntent, TransportKind } from "../../public/types.js";
import type { ContextTranslation } from "../../core/context.js";
import type { PermissionTranslation } from "../../core/permissions.js";
export const EDIT_MARKER = "oar-antigravity-edit-request-review-v1";
export function translateAntigravityContext(
  requested: ContextPolicy = {},
): ContextTranslation {
  const profile = requested.profile ?? "native",
    memory = requested.memory ?? "inherit";
  return {
    args: [],
    unsupported: [
      ...(profile === "native" ? [] : [`context.${profile}`]),
      ...(memory === "inherit" ? [] : [`memory.${memory}`]),
    ],
    warnings: [],
    report: {
      profile,
      memory,
      active: [
        "user-settings",
        "workspace-settings",
        "native-instructions",
        "provider-memory",
        "native-mcp-configuration",
      ],
      inactive: [],
      unavoidable: ["provider-session-storage"],
      unknown: [
        "startup-side-effects",
        "native-config-trust",
        "native-tool-grants",
      ],
    },
  };
}
export function translateAntigravityPermissions(
  requested: PermissionIntent,
  transport: TransportKind,
): PermissionTranslation {
  const unsupported = [
    ...(transport === "exec" ? [] : ["transport.control"]),
    ...(requested.mode === "edit" ? [] : [`permissions.${requested.mode}`]),
    ...(requested.network === "deny" ? ["network.deny"] : []),
    ...(requested.additionalDirectories?.length
      ? ["additionalDirectories"]
      : []),
    ...(requested.minimumEnforcement
      ? [`minimumEnforcement.${requested.minimumEnforcement}`]
      : []),
  ];
  return {
    args: [EDIT_MARKER],
    report: {
      requested: { ...requested },
      unsupported,
      effective: {
        filesystem:
          "native tool permissions; edits may be allowed by existing native grants; no OS sandbox",
        network: "provider-default",
        approvals:
          "native request-review; headless cannot answer permission requests",
        enforcedBy: [],
      },
      warnings: [
        "Native startup, MCP configuration, persisted grants and provider storage remain active.",
        "Request-review is provider behavior; existing native tool grants may still permit edits or commands.",
      ],
    },
  };
}
