import { OperationScope } from '../../control/operation-scope.js';
import { ProtocolError, SessionBusyError } from '../../public/errors.js';
import { ApplicationToolRegistry } from '../../tools/registry.js';
import type { ApplicationTool, ApplicationToolScope } from '../../tools/types.js';
import type { ClaudeAgentSdk, SdkMcpServerConfig } from './sdk.js';
import { APPLICATION_TOOL_SERVER, createClaudeToolServer, type McpToolSchemaLoader } from './tools.js';

/** Per-query binding, with fresh cancellation and authority metadata per turn. */
export class ClaudeToolLifecycle {
  readonly #registry: ApplicationToolRegistry;
  readonly #scope: () => ApplicationToolScope;
  readonly #loadSchemas: McpToolSchemaLoader | undefined;
  #operation: OperationScope | undefined;
  #controller: AbortController | undefined;
  constructor(tools: readonly ApplicationTool[], scope: () => ApplicationToolScope, loadSchemas?: McpToolSchemaLoader) {
    this.#registry = new ApplicationToolRegistry(tools); this.#scope = scope; this.#loadSchemas = loadSchemas;
  }
  start(timeoutMs: number, signal?: AbortSignal): void {
    if (this.#registry.hasPending()) throw new SessionBusyError({ provider: 'claude', transport: 'control', retryable: false }, 'A previous application tool callback has not settled');
    this.end(); this.#controller = new AbortController();
    this.#operation = new OperationScope({ timeoutMs, signal: signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal,
      context: { provider: 'claude', transport: 'control', retryable: false } });
  }
  end(): void { this.#controller?.abort(); this.#operation?.dispose(); this.#operation = undefined; }
  ownsSdkName(name: string): boolean {
    const prefix = `mcp__${APPLICATION_TOOL_SERVER}__`;
    return this.#operation !== undefined && name.startsWith(prefix) && this.#registry.has(name.slice(prefix.length));
  }
  async server(sdk: ClaudeAgentSdk): Promise<SdkMcpServerConfig> {
    return createClaudeToolServer(sdk, this.#registry, () => {
      const operation = this.#operation;
      if (!operation) throw new ProtocolError({ provider: 'claude', transport: 'control', retryable: false }, 'Application tool has no active turn');
      return { signal: operation.signal, deadline: operation.deadline, scope: this.#scope() };
    }, this.#loadSchemas);
  }
}
