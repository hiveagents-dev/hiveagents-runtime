import type { AgentOptions, ModelInfo, TransportKind } from "../../public/types.js";
import type { LaunchTarget } from "../../process/resolve-binary.js";
import type { ProcessRunner } from "../provider.js";
import type { ProviderRegistration } from "../../core/provider-registration.js";
import { RUNTIME_ADAPTER_VERSION } from "../../core/registry.js";
import { UnsupportedCapabilityError } from "../../public/errors.js";
import { EXEC_CAPABILITIES } from "./compatibility.js";
import { AntigravityExecAdapter } from "./exec-adapter.js";
import {
  translateAntigravityContext,
  translateAntigravityPermissions,
} from "./policy.js";
export interface AntigravityCliProviderOptions {
  executable?: LaunchTarget;
  modelCatalog?: readonly ModelInfo[];
  runner?: ProcessRunner;
}
const defaults: readonly ModelInfo[] = ["low", "medium", "high"].map(
  (level) => ({
    provider: "antigravity",
    id: `gemini-3.8-flash-${level}`,
    aliases: [`flash-${level}`],
    source: "compatibility-catalog",
    availability: "unverified",
  }),
);
const copy = (model: ModelInfo): ModelInfo => ({
  ...model,
  aliases: [...model.aliases],
  ...(model.supportedEffort
    ? { supportedEffort: [...model.supportedEffort] }
    : {}),
});
export function createAntigravityCliProvider(
  options: AntigravityCliProviderOptions = {},
): ProviderRegistration {
  const runner = options.runner;
  const catalog = (options.modelCatalog ?? defaults).map(copy);
  for (const model of catalog)
    if (model.provider !== "antigravity")
      throw new TypeError("Antigravity catalog contains a foreign provider");
  const executable = options.executable
    ? {
        command: options.executable.command,
        argsPrefix: [...options.executable.argsPrefix],
      }
    : undefined;
  const adapter = (target?: LaunchTarget) =>
    new AntigravityExecAdapter({
      modelCatalog: catalog,
      ...(target ? { target } : {}),
      ...(runner ? { runner } : {}),
    });
  return {
    apiVersion: 1,
    id: "antigravity",
    exec: {
      adapter: adapter(executable),
      token: "antigravityExecV1",
      adapterVersion: RUNTIME_ADAPTER_VERSION,
      withTarget: (target) => adapter(target),
    },
    modelCatalog: catalog.map(copy),
    resolveModel(nativeId: string): ModelInfo {
      if (!nativeId || nativeId.startsWith("-") || nativeId.includes("\0"))
        throw new TypeError("Invalid Antigravity model identifier");
      const found = catalog.find(
        (model) => model.id === nativeId || model.aliases.includes(nativeId),
      );
      return found
        ? copy(found)
        : {
            id: nativeId,
            provider: "antigravity",
            aliases: [],
            source: "explicit",
            availability: "unverified",
          };
    },
    execCapabilities: EXEC_CAPABILITIES,
    translateContext: translateAntigravityContext,
    translatePermissions: translateAntigravityPermissions,
    validateOptions(
      value: Readonly<AgentOptions>,
      transport: TransportKind,
    ): void {
      const unsupported = translateAntigravityPermissions(
        value.permissions ?? { mode: "analyze" },
        transport,
      ).report.unsupported;
      unsupported.push(
        ...translateAntigravityContext(value.context).unsupported,
      );
      if (value.instructions !== undefined || value.effort !== undefined)
        unsupported.push("privileged-instructions-effort");
      if (
        Object.keys(value.providerOptions?.external?.antigravity ?? {}).length
      )
        unsupported.push("providerOptions.external.antigravity");
      if (unsupported.length)
        throw new UnsupportedCapabilityError(
          {
            provider: "antigravity",
            transport,
            retryable: false,
            sanitizedDiagnostics: { unsupported },
          },
          "Antigravity cannot enforce requested options",
        );
    },
  };
}
