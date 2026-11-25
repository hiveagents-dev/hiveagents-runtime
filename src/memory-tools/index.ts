/**
 * `hiveagents-runtime/memory-tools`: per-agent memory as tools the agent calls, beside the
 * recalled block `AgentOptions.memory` prepends. Node-only, SQLite-free, and independent of the
 * orchestration memory store: it reaches memory only through the application's
 * `AgentMemoryProvider` (`recall`, and `propose` when offered).
 */
export {
  MEMORY_PROPOSE_NOTICE, MEMORY_PROPOSE_TOOL, MEMORY_SEARCH_TOOL, MEMORY_TOOL_DEFAULT_PROPOSALS_PER_MINUTE, MEMORY_TOOL_NOTICE,
  MEMORY_TOOL_TEXT_MAX, MemoryToolError,
} from './core.js';
export type {
  MemoryProposeResult, MemorySearchItem, MemorySearchResult, MemoryToolErrorCode, MemoryToolsBaseOptions,
} from './core.js';
export { MEMORY_TOOL_ORIGIN, memoryTools } from './application-tools.js';
export type { MemoryToolsOptions } from './application-tools.js';
export { serveMemoryMcp } from './mcp-server.js';
export type { MemoryMcpLogEntry, MemoryMcpServerHandle, MemoryMcpServerOptions } from './mcp-server.js';
export { MCP_LEGACY_VERSIONS, MCP_MODERN_VERSIONS, MCP_SUPPORTED_VERSIONS } from './mcp-protocol.js';
export { memoryMcpRecipe } from './recipe.js';
export type { MemoryMcpRecipe, MemoryMcpRecipeOptions } from './recipe.js';
export type { ApplicationTool, ApplicationToolContext, ApplicationToolScope } from '../tools/types.js';
export type { AgentMemoryProvider, AgentMemoryScope, MemoryProposeRequest, MemoryRecallRequest, RecalledMemory } from '../public/memory-types.js';
