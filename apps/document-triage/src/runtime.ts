import { createGeminiCliProvider, createAntigravityCliProvider, createClaudeProvider, createCodexProvider, ClaudeExecAdapter, CodexExecAdapter, Runtime, type LaunchTarget, type ProviderRegistration } from 'hiveagents-runtime';

const configurations = new WeakMap<Runtime, { adapters: Map<string, unknown>; targets: Map<string, LaunchTarget> }>();

/** Factory provenance only; it never attests authentication or provider quality. */
export function appRuntimeLaunchTarget(runtime: Runtime, provider: string): { known: boolean; target?: LaunchTarget } {
  const configuration = configurations.get(runtime);
  if (!configuration || configuration.adapters.get(provider) !== runtime.adapter(provider)) return { known: false };
  const target = configuration.targets.get(provider);
  return { known: true, ...(target ? { target: { command: target.command, argsPrefix: [...target.argsPrefix] } } : {}) };
}

export interface AppRuntimeOptions {
  claudeExecutable?: LaunchTarget;
  codexExecutable?: LaunchTarget;
  geminiExecutable?: LaunchTarget;
  antigravityExecutable?: LaunchTarget;
}

/** All provider state belongs to the runtime explicitly passed to this app. */
export function createAppRuntime(options: AppRuntimeOptions = {}): Runtime {
  const builtin = (registration: ProviderRegistration, target: LaunchTarget | undefined) => target === undefined ? registration
    : { ...registration, exec: { ...registration.exec,
      adapter: registration.id === 'claude' ? new ClaudeExecAdapter({ target }) : new CodexExecAdapter({ target }) } };
  const runtime = new Runtime({ providers: [
    builtin(createClaudeProvider(), options.claudeExecutable), builtin(createCodexProvider(), options.codexExecutable),
    createGeminiCliProvider(options.geminiExecutable === undefined ? {} : { executable: options.geminiExecutable }),
    createAntigravityCliProvider(options.antigravityExecutable === undefined ? {} : { executable: options.antigravityExecutable }),
  ] });
  configurations.set(runtime, { adapters: new Map(runtime.providers().map(provider => [provider, runtime.adapter(provider)])),
    targets: new Map(Object.entries({ claude: options.claudeExecutable, codex: options.codexExecutable, gemini: options.geminiExecutable, antigravity: options.antigravityExecutable })
      .filter((entry): entry is [string, LaunchTarget] => entry[1] !== undefined)
      .map(([provider, target]) => [provider, { command: target.command, argsPrefix: [...target.argsPrefix] }])) });
  return runtime;
}
