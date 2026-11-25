import type { ExecAdapter } from '../adapters/provider.js';
import type { LaunchTarget } from '../process/resolve-binary.js';
import { AmbiguousModelError, UnknownModelError, UnknownProviderError } from '../public/errors.js';
import type { ModelInfo, ProviderId } from '../public/types.js';
import type { RuntimeMemoryDefault } from '../public/memory-types.js';
import { resolveModel as resolveBuiltinModel } from './models.js';
import { createClaudeProvider, createCodexProvider, createDefaultProviders } from './builtin-providers.js';
import { snapshotProvider, type ProviderRegistration } from './provider-registration.js';
import { AdapterRegistry, type ControlAdapterRegistration } from './registry.js';
import { createRuntimeCapture, type RuntimeCaptureOptions } from '../orchestration/log/capture-runtime.js';
import { field } from '../orchestration/log/capture-codec.js';

export interface RuntimeOptions {
  providers?: readonly ProviderRegistration[];
  adapters?: ExecAdapter[];
  controlAdapters?: ControlAdapterRegistration[];
  /** Explicit required metadata capture; absent preserves ordinary standalone behavior. */
  capture?: RuntimeCaptureOptions;
  /**
   * Memory for every Agent built on this Runtime, unless the Agent sets its own `memory` or
   * `memory: false`. `scope` runs once per Agent (and once per candidate model when routing
   * digests a definition); the rest is validated when each Agent is built.
   */
  memory?: RuntimeMemoryDefault;
}

export class Runtime {
  readonly #registry = new AdapterRegistry();
  readonly #providers = new Map<ProviderId, ProviderRegistration>();
  readonly #legacyAdapters: boolean;
  readonly #capture: ReturnType<typeof createRuntimeCapture> | undefined;
  readonly #memory: RuntimeMemoryDefault | undefined;

  constructor(options: RuntimeOptions = {}) {
    const memory: unknown = options.memory;
    if (memory !== undefined && (typeof memory !== 'object' || memory === null || typeof (memory as { scope?: unknown }).scope !== 'function')) {
      throw new TypeError('The Runtime memory default must be an object whose scope is a function');
    }
    this.#memory = memory === undefined ? undefined : Object.freeze({ ...(memory as RuntimeMemoryDefault) });
    const capture = field(options, 'capture') as RuntimeCaptureOptions | undefined;
    this.#capture = capture === undefined ? undefined : createRuntimeCapture(capture);
    this.#legacyAdapters = options.adapters !== undefined;
    if (options.providers && (options.adapters || options.controlAdapters)) {
      throw new TypeError('providers cannot be combined with adapters or controlAdapters');
    }
    const providers = options.providers ?? (this.#legacyAdapters
      ? [createClaudeProvider(), createCodexProvider()]
      : createDefaultProviders());
    for (const input of providers) {
      const registration = snapshotProvider(input);
      if (this.#providers.has(registration.id)) {
        throw new TypeError(`Provider ${registration.id} is already registered`);
      }
      this.#providers.set(registration.id, registration);
      if (!options.adapters) this.#registry.registerExec(registration.exec);
      if (registration.control) this.#registry.registerControl(registration.control);
    }
    for (const adapter of options.adapters ?? []) {
      this.#registry.registerExec({ adapter });
    }
    for (const registration of options.controlAdapters ?? []) {
      this.#registry.registerControl(registration);
    }
  }

  get registry(): AdapterRegistry {
    return this.#registry;
  }
  bindLogCapture() { return this.#capture?.bindAgent(); }
  /** The memory every Agent of this Runtime gets unless it says otherwise. */
  memoryDefault(): RuntimeMemoryDefault | undefined { return this.#memory; }

  registration(provider: ProviderId): ProviderRegistration {
    const registration = this.#providers.get(provider);
    if (!registration) throw new UnknownProviderError(provider);
    return registration;
  }

  resolveModel(requested: string): ModelInfo {
    const value = requested.trim();
    if (!value) throw new UnknownModelError(requested);
    const slash = value.indexOf('/');
    if (slash > 0) {
      const prefix = value.slice(0, slash);
      const provider = ['claude', 'codex'].includes(prefix.toLowerCase()) ? prefix.toLowerCase() : prefix;
      const native = value.slice(slash + 1);
      if (!native) throw new UnknownModelError(requested);
      const registration = this.registration(provider);
      const known = this.#find(registration, native);
      const model = known ?? registration.resolveModel(native);
      if (model.provider !== provider || !model.id.trim()) {
        throw new TypeError('Resolved model provider mismatch');
      }
      return structuredClone(model);
    }
    const matches = [...this.#providers.values()].flatMap((registration) => {
      const match = this.#find(registration, value);
      return match ? [match] : [];
    });
    if (matches.length > 1 || (['best', 'default'].includes(value.toLowerCase()) && this.#providers.size > 1)) {
      throw new AmbiguousModelError(requested, matches.length
        ? matches.map((model) => model.provider)
        : [...this.#providers.keys()]);
    }
    if (matches[0]) return structuredClone(matches[0]);
    // Preserve built-in unprefixed native IDs without asking arbitrary external resolvers to guess aliases.
    const inferred = value.toLowerCase().startsWith('claude-') ? 'claude'
      : value.toLowerCase().startsWith('gpt-') || /^o\d/.test(value.toLowerCase()) ? 'codex' : undefined;
    if (inferred && this.#providers.has(inferred)) {
      const model = this.registration(inferred).resolveModel(value);
      if (model.provider !== inferred || !model.id.trim()) throw new TypeError('Resolved model provider mismatch');
      return structuredClone(model);
    }
    // Preserve the built-in spelling suggestions without sharing provider resolution state.
    try { resolveBuiltinModel(requested); }
    catch (error) {
      if (error instanceof UnknownModelError) throw error;
    }
    throw new UnknownModelError(requested);
  }

  #find(registration: ProviderRegistration, id: string): ModelInfo | undefined {
    const builtin = registration.id === 'claude' || registration.id === 'codex';
    const value = builtin ? id.toLowerCase() : id;
    return registration.modelCatalog.find((model) => model.id === value || model.aliases.includes(value));
  }

  async models(provider?: ProviderId): Promise<ModelInfo[]> {
    if (this.#legacyAdapters) {
      const ids = provider === undefined ? this.providers() : [provider];
      const catalogs = await Promise.all(ids.map(async (id) => {
        const models = await this.adapter(id).models();
        if (models.some((model) => model.provider !== id)) throw new TypeError('Model catalog provider mismatch');
        return structuredClone(models);
      }));
      return catalogs.flat();
    }
    const providers = provider === undefined ? [...this.#providers.values()] : [this.registration(provider)];
    return providers.flatMap((registration) => structuredClone([...registration.modelCatalog]));
  }

  adapter(provider: ProviderId): ExecAdapter {
    const registration = this.#registry.execRegistration(provider);
    if (!registration) throw new UnknownProviderError(provider);
    return registration.adapter;
  }

  adapterWithTarget(provider: ProviderId, target: LaunchTarget): ExecAdapter {
    const registration = this.#registry.execRegistration(provider);
    if (!registration) throw new UnknownProviderError(provider);
    const adapter = registration.withTarget?.(target) ?? registration.adapter;
    if (adapter.id !== provider) throw new TypeError('Bound adapter provider mismatch');
    return adapter;
  }
  controlRegistration(provider: ProviderId): ControlAdapterRegistration | undefined {
    return this.#registry.control(provider);
  }

  providers(): ProviderId[] {
    return this.#registry.providers();
  }
}
export const defaultRuntime = new Runtime();
