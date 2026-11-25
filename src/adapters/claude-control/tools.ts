import { AgentRuntimeError, RequiredTransportUnavailableError } from '../../public/errors.js';
import type { ApplicationToolCallOptions, ApplicationToolRegistry } from '../../tools/registry.js';
import type { ClaudeAgentSdk, SdkMcpServerConfig } from './sdk.js';

export const APPLICATION_TOOL_SERVER = 'oar_application';
export interface McpToolSchemas { ListToolsRequestSchema: unknown; CallToolRequestSchema: unknown }
export type McpToolSchemaLoader = () => Promise<McpToolSchemas>;

export async function loadMcpToolSchemas(): Promise<McpToolSchemas> {
  const specifier = '@modelcontextprotocol/sdk/types.js';
  try {
    const loaded = await import(specifier) as McpToolSchemas;
    if (loaded.ListToolsRequestSchema && loaded.CallToolRequestSchema) return loaded;
  } catch { /* Report the optional dependency, without loader internals. */ }
  throw new RequiredTransportUnavailableError(
    { provider: 'claude', transport: 'control', retryable: false },
    'Claude application tools require the optional package "@modelcontextprotocol/sdk"',
  );
}

/**
 * Use the SDK's MCP server and MCP's public request schemas directly. SDK.tool
 * accepts a Zod raw shape; converting arbitrary JSON Schema to that shape would
 * silently lose constraints, so the list handler advertises the original schema.
 */
export async function createClaudeToolServer(
  sdk: ClaudeAgentSdk,
  registry: ApplicationToolRegistry,
  currentCall: () => ApplicationToolCallOptions,
  loadSchemas: McpToolSchemaLoader = loadMcpToolSchemas,
): Promise<SdkMcpServerConfig> {
  if (!sdk.createSdkMcpServer) throw new RequiredTransportUnavailableError(
    { provider: 'claude', transport: 'control', retryable: false },
    'Claude application tools require the public createSdkMcpServer SDK API',
  );
  const schemas = await loadSchemas();
  const config = sdk.createSdkMcpServer({ name: APPLICATION_TOOL_SERVER, version: '1.0.0', tools: [] });
  const server = config.instance?.server;
  if (!server || typeof server.setRequestHandler !== 'function') throw new RequiredTransportUnavailableError(
    { provider: 'claude', transport: 'control', retryable: false }, 'Claude SDK MCP server has no public request handler surface',
  );
  server.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({ tools: registry.declarations() }));
  server.setRequestHandler(schemas.CallToolRequestSchema, async (
    request: { params?: { name?: string; arguments?: unknown } },
    extra: { signal?: AbortSignal; requestId?: string | number },
  ) => {
    try {
      const active = currentCall();
      const signal = extra.signal ? AbortSignal.any([active.signal, extra.signal]) : active.signal;
      const output = await registry.call(request.params?.name ?? '', request.params?.arguments ?? {}, {
        ...active, signal,
        scope: { ...active.scope, ...(extra.requestId === undefined ? {} : { callId: String(extra.requestId) }) },
      });
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    } catch (error) {
      const code = error instanceof AgentRuntimeError ? error.code : 'PROTOCOL_ERROR';
      return { isError: true, content: [{ type: 'text', text: `Application tool failed (${code})` }] };
    }
  });
  return config;
}
