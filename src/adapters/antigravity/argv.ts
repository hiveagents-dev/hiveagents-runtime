import type { ExecTurnRequest } from "../../adapters/provider.js";
import { UnsupportedCapabilityError } from "../../public/errors.js";
import { isAntigravitySessionId } from "./session-id.js";
import { EDIT_MARKER } from "./policy.js";
export function buildAntigravityArgs(request: ExecTurnRequest): string[] {
  if (typeof request.prompt !== "string" || request.prompt.includes("\0"))
    throw new TypeError("Invalid Antigravity prompt");
  if (
    !["open", "one-shot", "resume"].includes(request.mode) ||
    request.instructions !== undefined ||
    request.effort !== undefined ||
    request.outputSchema !== undefined ||
    request.contextArgs.length ||
    request.permissionArgs.length !== 1 ||
    request.permissionArgs[0] !== EDIT_MARKER ||
    (request.providerOptions && Object.keys(request.providerOptions).length)
  )
    throw new UnsupportedCapabilityError(
      { provider: "antigravity", retryable: false },
      "Antigravity exec requires native context and explicit edit/request-review policy; fork, instructions, effort, schema and custom options are unsupported",
    );
  if (
    !request.modelId ||
    request.modelId.startsWith("-") ||
    request.modelId.includes("\0")
  )
    throw new TypeError("Invalid Antigravity model ID");
  if (
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0
  )
    throw new TypeError("Invalid Antigravity execution bounds");
  const args = [
    `--print=${request.prompt}`,
    "--model",
    request.modelId,
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--print-timeout",
    `${request.timeoutMs}ms`,
    "--settings",
    JSON.stringify({ toolPermission: "request-review", agentMode: "" }),
  ];
  if (request.mode === "resume") {
    if (!isAntigravitySessionId(request.sessionId))
      throw new TypeError(
        "Resume requires an exact Antigravity conversation UUID",
      );
    args.push("--conversation", request.sessionId);
  } else if (request.sessionId !== undefined)
    throw new TypeError("Antigravity session ID requires resume mode");
  return args;
}
