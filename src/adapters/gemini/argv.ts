import type { ExecTurnRequest } from "../../adapters/provider.js";
import { UnsupportedCapabilityError } from "../../public/errors.js";
import { isGeminiSessionId } from "./session-id.js";
import { ANALYZE_MARKER } from "./policy.js";
export function buildGeminiArgs(request: ExecTurnRequest): string[] {
  if (typeof request.prompt !== "string" || request.prompt.includes("\0"))
    throw new TypeError("Invalid Gemini prompt");
  if (request.prompt.trimStart().startsWith("/"))
    throw new UnsupportedCapabilityError(
      { provider: "gemini", retryable: false },
      "Gemini custom slash commands are outside analyze model-tool enforcement",
    );
  if (
    !["open", "one-shot", "resume"].includes(request.mode) ||
    request.instructions !== undefined ||
    request.effort !== undefined ||
    request.outputSchema !== undefined
  )
    throw new UnsupportedCapabilityError(
      { provider: "gemini", retryable: false },
      "Gemini exec does not implement fork, privileged instructions, effort, or native schema",
    );
  if (
    request.contextArgs.length ||
    request.permissionArgs.length !== 1 ||
    request.permissionArgs[0] !== ANALYZE_MARKER
  )
    throw new UnsupportedCapabilityError(
      { provider: "gemini", retryable: false },
      "Gemini requires its restricted analyze policy envelope",
    );
  if (
    !request.modelId ||
    request.modelId.includes("\0") ||
    request.modelId.startsWith("-")
  )
    throw new TypeError("Invalid Gemini model ID");
  const args = [
    `--prompt=${request.prompt}`,
    "--model",
    request.modelId,
    "--output-format",
    "stream-json",
  ];
  if (request.mode === "resume") {
    if (!isGeminiSessionId(request.sessionId))
      throw new TypeError("Resume requires an exact Gemini session ID");
    args.push("--resume", request.sessionId);
  }
  return args;
}
