import { resolve } from 'node:path';

/**
 * What `SafetyEnvelope.mcpServers` records: the MCP servers a launch can reach,
 * by name where the SDK hands them over, and by marker where a configuration
 * layer the SDK does not read can add more.
 *
 * Claude exec (`providerOptions.claude.mcpConfigs`, `--mcp-config`):
 * - An inline JSON config contributes its server names.
 * - A path contributes `config:<absolute path>`, resolved against the agent's
 *   cwd as the CLI resolves it. Readiness does not read the file: the CLI reads
 *   it again on every turn, so names read now would describe a snapshot the
 *   turn may no longer use. The marker records the authority that is actually
 *   granted, "whatever this file defines when the turn starts".
 * - Inline text that is not a `{"mcpServers":{...}}` object contributes
 *   `config:inline`, so its presence stays visible.
 * - Unless the launch passes `--strict-mcp-config` (`strictMcpConfig: true`,
 *   or the `respond` intent) or `--safe-mode` (the `clean` profile), the CLI
 *   also loads the servers of its own settings, project `.mcp.json` and
 *   plugins: `config:claude-settings`.
 *
 * Codex exec (`providerOptions.codex.config`, `--config key=TOML`):
 * - `mcp_servers: { <name>: {...} }` and dotted keys `mcp_servers.<name>[.…]`
 *   contribute `<name>`; an `mcp_servers` value that is not a table contributes
 *   `config:inline`.
 * - Unless the launch passes `--ignore-user-config` (`ignoreUserConfig: true`,
 *   or the `project`/`clean` profiles), `$CODEX_HOME/config.toml` loads with
 *   its `mcp_servers`, and so does `<cwd>/.codex/config.toml` when that user
 *   config marks the project as trusted: `config:codex-user` stands for both
 *   layers. Codex control always loads them (it accepts only the native
 *   profile), so it carries the marker too.
 *
 * Claude control registers the in-process `oar_application` server when the
 * agent has application tools. Codex control hands application tools over as
 * dynamic tools, not MCP, so they appear in `tools` only. Whatever the Claude
 * Agent SDK loads from settings by itself is not reflected.
 */
export const INLINE_MCP_CONFIG_MARKER = 'config:inline';
export const CLAUDE_SETTINGS_MCP_MARKER = 'config:claude-settings';
export const CODEX_USER_CONFIG_MARKER = 'config:codex-user';
/** Mirrors `APPLICATION_TOOL_SERVER` in the Claude control adapter; a test keeps them equal. */
export const CLAUDE_APPLICATION_TOOL_SERVER = 'oar_application';

export interface EnvelopeMcpInput {
  provider: string;
  transport: 'exec' | 'control';
  cwd: string;
  /** The provider's own options object (`providerOptions.claude`, `.codex`). */
  providerOptions: Readonly<Record<string, unknown>> | undefined;
  contextArgs: readonly string[];
  permissionArgs: readonly string[];
  applicationTools: number;
}

export function envelopeMcpServers(input: EnvelopeMcpInput): string[] {
  const options = input.providerOptions;
  if (input.provider === 'claude' && input.transport === 'exec') {
    const servers = mcpServersFromClaudeConfigs(options?.mcpConfigs, input.cwd);
    const strict = options?.strictMcpConfig === true || input.permissionArgs.includes('--strict-mcp-config');
    if (!strict && !input.contextArgs.includes('--safe-mode')) servers.push(CLAUDE_SETTINGS_MCP_MARKER);
    return servers;
  }
  if (input.provider === 'claude') return input.applicationTools > 0 ? [CLAUDE_APPLICATION_TOOL_SERVER] : [];
  if (input.provider === 'codex') {
    // Codex control refuses `mcp_servers` keys in its config, so only exec reads them.
    const servers = input.transport === 'exec' ? mcpServersFromCodexConfig(options?.config) : [];
    const ignored = input.contextArgs.includes('--ignore-user-config')
      || (input.transport === 'exec' && options?.ignoreUserConfig === true);
    if (!ignored) servers.push(CODEX_USER_CONFIG_MARKER);
    return servers;
  }
  return [];
}

export function mcpServersFromClaudeConfigs(configs: unknown, cwd: string): string[] {
  if (!Array.isArray(configs)) return [];
  const servers = new Set<string>();
  for (const config of configs) {
    // Malformed entries are refused by the exec adapter before any turn runs.
    if (typeof config !== 'string' || config.trim() === '') continue;
    if (!config.trimStart().startsWith('{')) {
      servers.add(`config:${resolve(cwd, config)}`);
      continue;
    }
    const names = inlineServerNames(config);
    if (names === undefined) servers.add(INLINE_MCP_CONFIG_MARKER);
    else for (const name of names) servers.add(name);
  }
  return [...servers];
}

/** Server names in a Codex `--config` object, as the exec adapter turns each key into `key=TOML`. */
export function mcpServersFromCodexConfig(config: unknown): string[] {
  if (!isTable(config)) return [];
  const servers = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (key === 'mcp_servers') {
      if (isTable(value)) for (const name of Object.keys(value)) servers.add(name);
      else servers.add(INLINE_MCP_CONFIG_MARKER);
    } else if (key.startsWith('mcp_servers.')) {
      // The adapter accepts only dotted bare keys, so the second segment is the server name.
      servers.add(key.split('.')[1]!);
    }
  }
  return [...servers];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inlineServerNames(config: string): string[] | undefined {
  try {
    const parsed = JSON.parse(config) as unknown;
    const map = isTable(parsed) ? parsed.mcpServers : undefined;
    return isTable(map) ? Object.keys(map) : undefined;
  } catch {
    return undefined;
  }
}
