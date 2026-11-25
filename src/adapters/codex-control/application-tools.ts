import { ProtocolError } from '../../public/errors.js';
import { ApplicationToolRegistry } from '../../tools/registry.js';
import type { ApplicationTool } from '../../tools/types.js';
import type { CodexDynamicToolDefinition } from './dynamic-tools.js';

/** Keep the legacy host/wire contract while sharing validation and authorization. */
export function createCodexApplicationToolBinding(tools: readonly ApplicationTool[]) {
  const registry = new ApplicationToolRegistry(tools);
  const definitions: CodexDynamicToolDefinition[] = registry.declarations().map(declaration => ({
    ...declaration,
    // The registry holds the immutable original limits; the legacy host adds no wider authority.
    timeoutMs: tools.find(tool => tool.name === declaration.name)!.timeoutMs,
    maxOutputBytes: tools.find(tool => tool.name === declaration.name)!.maxOutputBytes,
    handler: (input, context) => {
      if (!context.scope) throw new ProtocolError(
        { provider: 'codex', transport: 'control', retryable: false }, 'Application tool call has no trusted session scope',
      );
      return registry.call(declaration.name, input, { signal: context.signal, scope: context.scope,
        ...(context.deadline === undefined ? {} : { deadline: context.deadline }) });
    },
  }));
  return { definitions, hasPending: (sessionId: string) => registry.hasPending(sessionId) };
}

export function bindCodexApplicationTools(tools: readonly ApplicationTool[]): CodexDynamicToolDefinition[] {
  return createCodexApplicationToolBinding(tools).definitions;
}
