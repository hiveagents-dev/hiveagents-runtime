/**
 * The slice of the Model Context Protocol the memory server speaks, verified against
 * https://modelcontextprotocol.io/specification (revisions 2026-07-28, 2025-11-25, 2025-06-18,
 * 2025-03-26 and 2024-11-05: base protocol, versioning, lifecycle, ping, stdio and tools pages).
 *
 * - Legacy revisions (2025-11-25 and earlier) open with `initialize`: the server answers with the
 *   client's requested version when it supports it, otherwise with its latest legacy version.
 * - The modern revision (2026-07-28) has no handshake: every request carries its version and the
 *   client capabilities in `params._meta`, results carry `resultType`, and `server/discover` lists
 *   the versions. A request carrying the modern version key is served statelessly; an
 *   unsupported version gets `-32022` with the supported list.
 * - `structuredContent` and tool `title` exist from 2025-06-18 on; JSON-RPC batches only in 2025-03-26.
 * - JSON-RPC 2.0 leaves -32000 to -32099 to the server: `SERVER_BUSY` refuses a call past the queue cap.
 */

export const MCP_MODERN_VERSIONS: readonly string[] = Object.freeze(['2026-07-28']);
/** Newest first: the first one answers an `initialize` that asks for a version not listed here. */
export const MCP_LEGACY_VERSIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS]);
/** Revisions whose tool results carry `structuredContent` and whose tools carry `title`. */
const STRUCTURED_VERSIONS = new Set(['2026-07-28', '2025-11-25', '2025-06-18']);
export const BATCH_VERSION = '2025-03-26';

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** JSON-RPC's implementation-defined server error range (-32000 to -32099): too many calls waiting. */
export const SERVER_BUSY = -32000;

export type JsonRpcId = string | number;
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: Record<string, unknown> }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export function isStructured(version: string): boolean { return STRUCTURED_VERSIONS.has(version); }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function resultOf(id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorOf(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** A key that names one request for cancellation: `1` and `"1"` are different ids. */
export function idKey(id: unknown): string | undefined {
  return isRequestId(id) ? `${typeof id}:${String(id)}` : undefined;
}
