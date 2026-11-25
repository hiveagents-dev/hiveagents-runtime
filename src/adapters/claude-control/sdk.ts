import { RequiredTransportUnavailableError } from '../../public/errors.js';

export const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export type SdkPermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: { signal: AbortSignal },
) => Promise<SdkPermissionResult>;

export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: unknown };
  parent_tool_use_id: null;
  session_id: string;
}

/** Structural public MCP surface; optional packages stay lazy at runtime. */
export interface SdkMcpServerConfig {
  type: 'sdk';
  name: string;
  instance: { server: { setRequestHandler(schema: unknown, handler: (request: any, extra: any) => Promise<unknown>): void } };
}

export interface SdkQueryOptions {
  mcpServers?: Record<string, SdkMcpServerConfig>;

  settingSources?: Array<'user' | 'project' | 'local'>;
  extraArgs?: Record<string, string | null>;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  effort?: string;
  additionalDirectories?: string[];
  cwd?: string;
  model?: string;
  resume?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  permissionMode?: SdkPermissionMode;
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
  canUseTool?: SdkCanUseTool;
  /**
   * Whether the SDK reports the assistant message as it is produced.
   *
   * Verified against the installed package rather than assumed: declared as
   * `includePartialMessages?: boolean` in the SDK's own runtime types, and its
   * default there is `false`. That default is why a turn which only thinks —
   * no tools, one structured answer at the end — emits nothing at all between
   * its first event and its last, and why any liveness check watching this
   * stream cannot tell such a turn from a hung one.
   */
  includePartialMessages?: boolean;
}

export interface SdkQuery extends AsyncIterable<Record<string, unknown>> {
  close?(): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
}

export interface ClaudeAgentSdk {
  createSdkMcpServer?(options: { name: string; version: string; tools: never[] }): SdkMcpServerConfig;

  query(input: { prompt: AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }): SdkQuery;
}

export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  // El specifier vive en una variable para que tsc no exija el paquete
  // opcional instalado al typecheckear este import dinámico.
  const specifier = CLAUDE_AGENT_SDK_PACKAGE;
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch {
    loaded = undefined;
  }
  if (typeof loaded === 'object' && loaded !== null
    && typeof (loaded as { query?: unknown }).query === 'function') {
    return loaded as ClaudeAgentSdk;
  }
  throw new RequiredTransportUnavailableError(
    { provider: 'claude', transport: 'control', retryable: false },
    `Claude control transport requires the optional package "${CLAUDE_AGENT_SDK_PACKAGE}"; install it next to hiveagents-runtime to enable it`,
  );
}
