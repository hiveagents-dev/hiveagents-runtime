import type { AgentOptions, ModelInfo, TransportKind } from "../../public/types.js";
import type { LaunchTarget } from "../../process/resolve-binary.js";
import type { ProcessRunner } from "../provider.js";
import type { ProviderRegistration } from "../../core/provider-registration.js";
import { RUNTIME_ADAPTER_VERSION } from "../../core/registry.js";
import { UnsupportedCapabilityError } from "../../public/errors.js";
import { EXEC_CAPABILITIES } from "./compatibility.js";
import { GeminiExecAdapter } from "./exec-adapter.js";
import {
  translateGeminiContext,
  translateGeminiPermissions,
} from "./policy.js";
export interface GeminiCliProviderOptions {
  executable?: LaunchTarget;
  modelCatalog?: readonly ModelInfo[];
  runner?: ProcessRunner;
  probeRunner?: ProcessRunner;
}
const defaultModels: readonly ModelInfo[] = [{
  id: "gemini-2.5-flash",
  provider: "gemini",
  aliases: [],
  source: "compatibility-catalog",
  availability: "unverified",
}];

export function createGeminiCliProvider(
  options: GeminiCliProviderOptions = {},
): ProviderRegistration {
  const catalog = (options.modelCatalog ?? defaultModels).map((model) => ({
    ...model,
    aliases: [...model.aliases],
    ...(model.supportedEffort
      ? { supportedEffort: [...model.supportedEffort] }
      : {}),
  }));
  for (const model of catalog)
    if (model.provider !== "gemini")
      throw new TypeError("Gemini catalog contains a foreign provider");
  const runner = options.runner;
  const probeRunner = options.probeRunner;
  if (probeRunner !== undefined && typeof probeRunner !== "function") throw new TypeError("probeRunner must be a function");
  const executable = options.executable
    ? {
        command: options.executable.command,
        argsPrefix: [...options.executable.argsPrefix],
      }
    : undefined;
  const adapter = (target?: LaunchTarget) =>
    new GeminiExecAdapter({
      modelCatalog: catalog,
      ...(target ? { target } : {}),
      ...(runner ? { runner } : {}),
      ...(probeRunner === undefined ? {} : { probeRunner }),
    });
  return {
    apiVersion: 1,
    id: "gemini",
    exec: {
      adapter: adapter(executable),
      token: "geminiExecV1",
      adapterVersion: RUNTIME_ADAPTER_VERSION,
      withTarget: (target) => adapter(target),
    },
    modelCatalog: catalog.map((model) => ({
      ...model,
      aliases: [...model.aliases],
      ...(model.supportedEffort
        ? { supportedEffort: [...model.supportedEffort] }
        : {}),
    })),
    resolveModel(nativeId: string): ModelInfo {
      if (!nativeId || nativeId.startsWith("-") || nativeId.includes("\0"))
        throw new TypeError("Invalid Gemini model identifier");
      const found = catalog.find(
        (m) => m.id === nativeId || m.aliases.includes(nativeId),
      );
      return found
        ? {
            ...found,
            aliases: [...found.aliases],
            ...(found.supportedEffort
              ? { supportedEffort: [...found.supportedEffort] }
              : {}),
          }
        : {
            id: nativeId,
            provider: "gemini",
            aliases: [],
            source: "explicit",
            availability: "unverified",
          };
    },
    execCapabilities: EXEC_CAPABILITIES,
    translateContext: translateGeminiContext,
    translatePermissions: translateGeminiPermissions,
    validateOptions(
      value: Readonly<AgentOptions>,
      transport: TransportKind,
    ): void {
      const unsupported = translateGeminiPermissions(
        value.permissions ?? { mode: "analyze" },
        transport,
      ).report.unsupported;
      unsupported.push(...translateGeminiContext(value.context).unsupported);
      if (value.instructions !== undefined || value.effort !== undefined)
        unsupported.push("privileged-instructions-effort-schema");
      const external = value.providerOptions?.external?.gemini;
      if (external && Object.keys(external).length)
        unsupported.push("providerOptions.external.gemini");
      if (unsupported.length)
        throw new UnsupportedCapabilityError(
          {
            provider: "gemini",
            transport,
            retryable: false,
            sanitizedDiagnostics: { unsupported },
          },
          "Gemini cannot enforce requested options",
        );
    },
  };
}
