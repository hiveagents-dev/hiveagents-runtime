/**
 * The launch entry of an application's memory MCP server script. Pure: it formats data and
 * starts nothing.
 *
 * Structurally the same `McpServerRecipe` that `hiveagents-runtime/orchestration/memory` exports
 * (and that its `claudeMcpConfig` accepts): `{ name, command, args, env }`. The type is repeated
 * here rather than imported because nothing outside `src/orchestration/memory` may import that
 * folder except through its two public entries, and this entry must stay free of it.
 */
export interface MemoryMcpRecipe {
  readonly name: string;
  /** The absolute path given as `executable`. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface MemoryMcpRecipeOptions {
  /** MCP server name; Claude names the tools `mcp__<name>__memory_search`. Default `oar-memory`. */
  readonly name?: string;
  /** Absolute path of the Node.js binary that runs the script, e.g. `process.execPath`. */
  readonly executable: string;
  /** Absolute path of the application's script that calls `serveMemoryMcp`. */
  readonly script: string;
  /** Environment for the server process, e.g. the path of the memory database. */
  readonly env?: Readonly<Record<string, string>>;
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KEYS = ['name', 'executable', 'script', 'env'];

/** POSIX `/…`, Windows `C:\…` or `C:/…`, and UNC `\\server\…`, as the orchestration recipes accept. */
function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && value.trim() === value
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value));
}

/**
 * `<executable> <script>` with the given environment. Pass the result to `claudeMcpConfig` for
 * `providerOptions.claude.mcpConfigs` (Claude exec). For Codex exec the same command, args and env
 * go in a `mcp_servers.<name>` entry of `providerOptions.codex.config`; no Codex helper is offered
 * because that entry's layout is not verified against the Codex CLI in this repository.
 */
export function memoryMcpRecipe(options: MemoryMcpRecipeOptions): MemoryMcpRecipe {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('memoryMcpRecipe options must be an object.');
  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw new TypeError(`memoryMcpRecipe options do not accept: ${unknown.join(', ')}.`);
  const name = options.name ?? 'oar-memory';
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) throw new TypeError('MCP server name must be 1-64 letters, digits, "_" or "-".');
  if (!isAbsolutePath(options.executable)) throw new TypeError('memoryMcpRecipe executable must be an absolute path.');
  if (!isAbsolutePath(options.script)) throw new TypeError('memoryMcpRecipe script must be an absolute path.');
  const env: Record<string, string> = {};
  if (options.env !== undefined) {
    if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)) throw new TypeError('memoryMcpRecipe env must be an object.');
    for (const [key, value] of Object.entries(options.env)) {
      if (!ENV_NAME.test(key) || typeof value !== 'string' || value.includes('\0')) throw new TypeError('memoryMcpRecipe env must map variable names to strings.');
      env[key] = value;
    }
  }
  return Object.freeze({ name, command: options.executable, args: Object.freeze([options.script]), env: Object.freeze(env) });
}
