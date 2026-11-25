import type { ExecAdapter } from '../adapters/provider.js';
import type { LaunchTarget } from '../process/resolve-binary.js';
import type { AgentOptions, CapabilitySupport, ContextPolicy, ModelInfo, PermissionIntent, ProviderId, TransportKind } from '../public/types.js';
import type { ContextTranslation } from './context.js';
import type { PermissionTranslation } from './permissions.js';
import type { ControlAdapterRegistration, ExecAdapterRegistration } from './registry.js';

export interface ProviderRegistration {
  apiVersion: 1;
  id: ProviderId;
  exec: ExecAdapterRegistration & {
    token: string;
    adapterVersion: string;
    withTarget(target: LaunchTarget): ExecAdapter;
  };
  modelCatalog: readonly ModelInfo[];
  resolveModel(nativeId: string): ModelInfo;
  execCapabilities?: Readonly<Record<string, CapabilitySupport>>;
  translateContext(requested?: ContextPolicy): ContextTranslation;
  translatePermissions(requested: PermissionIntent, transport: TransportKind): PermissionTranslation;
  validateOptions(options: Readonly<AgentOptions>, transport: TransportKind): void;
  control?: ControlAdapterRegistration;
}

export function validateProviderId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) {
    throw new TypeError(`Invalid provider id ${id}`);
  }
}

export function snapshotProvider(input: ProviderRegistration): ProviderRegistration {
  validateProviderId(input.id);
  if (input.apiVersion !== 1 || input.exec.adapter.id !== input.id || !input.exec.adapterVersion
    || !/^[a-zA-Z][a-zA-Z0-9]*V[1-9][0-9]*$/.test(input.exec.token)
    || typeof input.exec.withTarget !== 'function') {
    throw new TypeError(`Invalid registration for ${input.id}`);
  }
  for (const model of input.modelCatalog) {
    if (model.provider !== input.id || !model.id.trim()) {
      throw new TypeError(`Model catalog does not match ${input.id}`);
    }
  }
  if (input.control?.provider !== undefined && input.control.provider !== input.id) {
    throw new TypeError('Control provider mismatch');
  }
  return Object.freeze({
    ...input,
    exec: Object.freeze({ ...input.exec }),
    modelCatalog: Object.freeze(input.modelCatalog.map((model) => Object.freeze({
      ...structuredClone(model),
      aliases: Object.freeze([...model.aliases]) as unknown as string[],
      ...(model.supportedEffort ? { supportedEffort: Object.freeze([...model.supportedEffort]) as unknown as string[] } : {}),
    }))),
    ...(input.execCapabilities ? { execCapabilities: Object.freeze({ ...input.execCapabilities }) } : {}),
    ...(input.control ? { control: Object.freeze({ ...input.control, capabilityVerdicts: Object.freeze({ ...input.control.capabilityVerdicts }) }) } : {}),
  });
}
