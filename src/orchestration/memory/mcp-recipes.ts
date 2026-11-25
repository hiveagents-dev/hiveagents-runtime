/**
 * MCP server recipes for agent memory tools. Pure (no Node imports): a recipe
 * is data the application hands to a provider, the SDK neither installs nor
 * runs the package, and nothing here reads or writes the memory store.
 *
 * {@link claudeMcpConfig} turns recipes into one inline config for
 * `providerOptions.claude.mcpConfigs` (Claude exec). Codex exec also takes MCP
 * servers, as `mcp_servers.<name>` entries of `providerOptions.codex.config`,
 * but the field layout of those entries is not verified against the Codex CLI
 * in this repository, so no Codex helper is offered. Claude control rejects
 * provider options and Codex control refuses `mcp_servers`, so a recipe reaches
 * neither control transport.
 *
 * Two launch forms:
 * - `executable`: an absolute path to a binary installed beforehand from a
 *   lockfile (`npm ci` in a directory the agent cannot write, then
 *   `<dir>/node_modules/.bin/agentdb`). The whole dependency tree is the one
 *   the lockfile pinned. This is the recommended form.
 * - `version`: `npx -y <package>@<version>`. Only the top-level package is
 *   pinned: npm resolves its dependencies from their declared ranges when it
 *   installs into its cache, npx runs a package of the same name and version
 *   found in the launch directory's own project instead of fetching it, and
 *   that project's `.npmrc` can point the registry, scoped registries included,
 *   elsewhere. An untrusted workspace can therefore substitute the server. The
 *   SDK sets no `npm_config_*` variable: a registry override would outrank only
 *   the unscoped registry of a project `.npmrc`, would not stop the local
 *   substitution, and would override an owner's mirror.
 *
 * Both packages are published by a single maintainer and move fast, so the npx
 * form pins an exact version: ranges, dist-tags and `latest` are refused.
 * Arguments and environment names below were read from the published
 * `agentdb@3.10.1` and `ruvector@0.3.27` sources; another version may differ.
 */

export interface McpServerRecipe {
  readonly name: string;
  /** `npx`, or the absolute path given as `executable`. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Exactly one launch form: an exact npm version (npx) or a pre-installed binary. */
export type McpRecipeLaunch =
  | { /** Exact semver, e.g. `3.10.1`; launched with `npx -y`. */ readonly version: string; readonly executable?: undefined }
  | { /** Absolute path of a lockfile-installed bin, e.g. `/opt/oar/node_modules/.bin/agentdb`. */
    readonly executable: string; readonly version?: undefined };

/**
 * `AGENTDB_MCP_PROFILE` values, read-only first. `readonly` and `retrieval`
 * expose the same read tools in 3.10.1; `learning` (the server's default when
 * the variable is unset) adds store, update and feedback tools. `admin`, which
 * unlocks delete and reset tools, is deliberately not offered here.
 */
export type AgentDbMcpProfile = 'readonly' | 'retrieval' | 'learning';

export type AgentDbMcpServerOptions = McpRecipeLaunch & {
  /** Absolute path of this agent's database file (`AGENTDB_PATH`); one file per agent. */
  readonly databasePath: string;
  readonly profile: AgentDbMcpProfile;
  /** MCP server name, default `agentdb`; Claude names its tools `mcp__<name>__<tool>`. */
  readonly name?: string;
};

/**
 * RuVector policy, read-only first. `readonly` sets `RUVECTOR_MCP_PROFILE=readonly`,
 * the only profile 0.3.27 defines. `unrestricted` sets no policy, which in
 * 0.3.27 exposes every registered tool, memory writes included.
 */
export type RuvectorMcpProfile = 'readonly' | 'unrestricted';

export type RuvectorMcpServerOptions = McpRecipeLaunch & {
  /** MCP server name, default `ruvector`. */
  readonly name?: string;
} & (
  | { readonly profile: 'readonly'; readonly sharedStoreAcknowledged?: boolean }
  | {
    readonly profile: 'unrestricted';
    /**
     * Required for `unrestricted`: the server's store is shared by every agent
     * launched from the same directory (or home), whatever its memory scope, so
     * a write here is readable by another tenant's agent. The SDK cannot scope it.
     */
    readonly sharedStoreAcknowledged: true;
  }
);

const PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_SEMVER = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)?$`,
);
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const AGENTDB_PROFILES: readonly string[] = ['readonly', 'retrieval', 'learning'];
const RUVECTOR_PROFILES: readonly string[] = ['readonly', 'unrestricted'];

function plainOptions(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} options must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`${label} options do not accept: ${unknown.join(', ')}.`);
  return value as Record<string, unknown>;
}

function exactVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EXACT_SEMVER.test(value)) {
    throw new TypeError(`${label} version must be an exact semver such as 1.2.3; ranges, tags and latest are refused.`);
  }
  return value;
}

/** POSIX `/…`, Windows `C:\…` or `C:/…`, and UNC `\\server\…`. */
function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && value.trim() === value
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value));
}

function absolutePath(value: unknown, label: string): string {
  if (!isAbsolutePath(value)) throw new TypeError(`${label} must be an absolute path.`);
  return value;
}

function serverName(value: unknown, fallback: string): string {
  const name = value ?? fallback;
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) {
    throw new TypeError('MCP server name must be 1-64 letters, digits, "_" or "-".');
  }
  return name;
}

function profileOf(value: unknown, profiles: readonly string[], label: string): string {
  if (typeof value !== 'string' || !profiles.includes(value)) {
    throw new TypeError(`${label} profile must be one of: ${profiles.join(', ')}.`);
  }
  return value;
}

const LAUNCH_KEYS = ['version', 'executable'];

/** `npx -y <pkg>@<version> …` or `<executable> …`; exactly one of the two. */
function launch(input: Record<string, unknown>, pkg: string, label: string, serverArgs: string[]): [string, string[]] {
  const hasVersion = input.version !== undefined;
  if (hasVersion === (input.executable !== undefined)) {
    throw new TypeError(`${label} needs exactly one of version (npx) or executable (pre-installed binary).`);
  }
  if (hasVersion) return ['npx', ['-y', `${pkg}@${exactVersion(input.version, label)}`, ...serverArgs]];
  return [absolutePath(input.executable, `${label} executable`), serverArgs];
}

function freezeRecipe(name: string, [command, args]: [string, string[]], env: Record<string, string>): McpServerRecipe {
  return Object.freeze({
    name,
    command,
    args: Object.freeze(args),
    env: Object.freeze(env),
  });
}

/**
 * `agentdb mcp start` (through `npx -y agentdb@<version>` or the given
 * executable) with `AGENTDB_PATH` and an explicit `AGENTDB_MCP_PROFILE`, so the
 * server never falls back to its write-enabled default. The stdio server takes
 * no flags; the database is set only by env.
 */
export function agentDbMcpServer(options: AgentDbMcpServerOptions): McpServerRecipe {
  const input = plainOptions(options, [...LAUNCH_KEYS, 'databasePath', 'profile', 'name'], 'AgentDB');
  const command = launch(input, 'agentdb', 'AgentDB', ['mcp', 'start']);
  const databasePath = absolutePath(input.databasePath, 'AgentDB databasePath');
  const profile = profileOf(input.profile, AGENTDB_PROFILES, 'AgentDB');
  return freezeRecipe(serverName(input.name, 'agentdb'), command,
    { AGENTDB_PATH: databasePath, AGENTDB_MCP_PROFILE: profile });
}

/**
 * `ruvector mcp start` (through `npx -y ruvector@<version>` or the given
 * executable). The 0.3.27 server keeps its memory in
 * `.ruvector/intelligence.json` under the directory it is launched from (or the
 * home directory when that already holds one) and reads no environment variable
 * or flag for it, so this recipe offers no storage path option. That store is
 * shared by every agent launched from the same directory or home and is not
 * scoped by the SDK: `readonly` agents read whatever any writer put there, and
 * `unrestricted` is refused unless `sharedStoreAcknowledged: true` is passed.
 */
export function ruvectorMcpServer(options: RuvectorMcpServerOptions): McpServerRecipe {
  const input = plainOptions(options, [...LAUNCH_KEYS, 'profile', 'name', 'sharedStoreAcknowledged'], 'RuVector');
  const command = launch(input, 'ruvector', 'RuVector', ['mcp', 'start']);
  const profile = profileOf(input.profile, RUVECTOR_PROFILES, 'RuVector');
  const acknowledged = input.sharedStoreAcknowledged;
  if (acknowledged !== undefined && typeof acknowledged !== 'boolean') {
    throw new TypeError('RuVector sharedStoreAcknowledged must be true or false.');
  }
  if (profile === 'unrestricted' && acknowledged !== true) {
    throw new TypeError('RuVector unrestricted writes to a store shared per working directory or home, not per agent; '
      + 'pass sharedStoreAcknowledged: true to accept that.');
  }
  return freezeRecipe(serverName(input.name, 'ruvector'), command,
    profile === 'readonly' ? { RUVECTOR_MCP_PROFILE: 'readonly' } : {});
}

/**
 * One inline config for `providerOptions.claude.mcpConfigs`:
 * `{"mcpServers":{"<name>":{"command","args","env"}}}`. Duplicate names are
 * refused rather than letting the later server silently replace the earlier.
 */
export function claudeMcpConfig(recipes: readonly McpServerRecipe[]): string {
  if (!Array.isArray(recipes) || recipes.length === 0) throw new TypeError('claudeMcpConfig needs at least one recipe.');
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const recipe of recipes as readonly unknown[]) {
    if (!recipe || typeof recipe !== 'object') throw new TypeError('Each MCP recipe must be an object.');
    const { name, command, args, env } = recipe as Record<string, unknown>;
    const checked = serverName(name, '');
    if (Object.hasOwn(servers, checked)) throw new TypeError(`Duplicate MCP server name: ${checked}.`);
    if (!(command === 'npx' || isAbsolutePath(command)) || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')
      || !env || typeof env !== 'object' || Array.isArray(env)
      || !Object.values(env).every((value) => typeof value === 'string')) {
      throw new TypeError(`MCP recipe ${checked} is malformed.`);
    }
    servers[checked] = { command, args: [...args] as string[], env: { ...(env as Record<string, string>) } };
  }
  return JSON.stringify({ mcpServers: servers });
}
