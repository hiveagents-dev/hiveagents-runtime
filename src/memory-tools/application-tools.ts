import { resolve } from 'node:path';
import type { ApplicationTool, ApplicationToolContext, ApplicationToolScope } from '../tools/types.js';
import {
  BASE_KEYS, closedOptions, MEMORY_PROPOSE_DESCRIPTION, MEMORY_PROPOSE_SCHEMA, MEMORY_PROPOSE_TOOL, MEMORY_SEARCH_DESCRIPTION,
  MEMORY_SEARCH_SCHEMA, MEMORY_SEARCH_TOOL, MemoryToolCore, toolFailure, type MemoryToolsBaseOptions,
} from './core.js';

/** `MemoryProposeRequest.origin` of a proposal made through these application tools. */
export const MEMORY_TOOL_ORIGIN = 'memory-tool';
/** Room the result needs besides its items: the notice, field names and separators. */
const RESULT_OVERHEAD_BYTES = 4096;
/** The provider deadline fires first, so a slow provider is a TIMEOUT result rather than a registry timeout. */
const DEADLINE_GRACE_MS = 1_000;

export interface MemoryToolsOptions extends MemoryToolsBaseOptions {
  /**
   * The working directory the tools serve. When set, `authorize` admits a call only from a session
   * whose resolved cwd is this one. Without it any session of the Agent the tools are given to is
   * admitted; the memory scope stays the fixed one either way.
   */
  readonly cwd?: string;
  /** An extra application check on each call's trusted scope (session, turn, provider); it must return true. */
  readonly authorize?: (scope: Readonly<ApplicationToolScope>) => boolean | Promise<boolean>;
}

function sameObject(input: unknown, keys: readonly string[]): boolean {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && Reflect.ownKeys(input).every((key) => typeof key === 'string' && keys.includes(key));
}

/**
 * The memory tools as application tools for a control transport (`AgentOptions.tools`, which needs
 * `providerOptions.experimentalControl` and, for Claude control, `experimentalApi`).
 *
 * - `memory_search` `{ query, limit? }`, when the provider has `recall`, asks it with the fixed scope
 *   and returns `{ notice, items: [{ id, source, title?, observedAt?, text }], omitted }`.
 * - `memory_propose` `{ text, title? }`, only with `propose: true`, hands `provider.propose` a candidate
 *   with origin `memory-tool` and returns `{ id, status: 'candidate', notice }`. A provider with
 *   `propose` and no `recall` gives a tool set of `memory_propose` alone; one that would offer no
 *   tool at all is a TypeError.
 *
 * `authorize` admits only control-transport calls whose input has no field beyond the tool's own,
 * from the configured `cwd` when one is set, and passing the application's `authorize` when given.
 * A failure is a JSON result `{ error: { code, message } }` with a closed code and an SDK message.
 */
export function memoryTools(options: MemoryToolsOptions): ApplicationTool[] {
  closedOptions(options, [...BASE_KEYS, 'cwd', 'authorize'], 'memoryTools options');
  const core = new MemoryToolCore(options, 'memoryTools');
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.length === 0 || options.cwd.includes('\0'))) {
    throw new TypeError('memoryTools.cwd must be a non-empty path');
  }
  if (options.authorize !== undefined && typeof options.authorize !== 'function') throw new TypeError('memoryTools.authorize must be a function');
  const cwd = options.cwd === undefined ? undefined : resolve(options.cwd);
  const check = options.authorize;

  const authorize = (keys: readonly string[]) => async (input: unknown, context: ApplicationToolContext): Promise<boolean> => {
    const scope = context?.scope;
    if (!scope || scope.transport !== 'control' || typeof scope.cwd !== 'string' || typeof scope.sessionId !== 'string') return false;
    if (!sameObject(input, keys)) return false;
    if (cwd !== undefined && resolve(scope.cwd) !== cwd) return false;
    if (check === undefined) return true;
    try { return (await check(scope)) === true; } catch { return false; }
  };
  const call = (context: ApplicationToolContext) => ({
    provider: context.scope.provider, transport: context.scope.transport, cwd: context.scope.cwd, signal: context.signal,
  });
  const timeoutMs = core.timeoutMs + DEADLINE_GRACE_MS;

  const tools: ApplicationTool[] = [];
  if (core.offersSearch) {
    tools.push({
      name: MEMORY_SEARCH_TOOL,
      description: MEMORY_SEARCH_DESCRIPTION,
      inputSchema: structuredClone(MEMORY_SEARCH_SCHEMA) as Record<string, unknown>,
      timeoutMs,
      maxOutputBytes: core.maxBytes + RESULT_OVERHEAD_BYTES,
      authorize: authorize(['query', 'limit']),
      execute: async (input, context) => {
        try { return await core.search(input, call(context)); } catch (error) { return toolFailure(error); }
      },
    });
  }
  if (core.propose) {
    tools.push({
      name: MEMORY_PROPOSE_TOOL,
      description: MEMORY_PROPOSE_DESCRIPTION,
      inputSchema: structuredClone(MEMORY_PROPOSE_SCHEMA) as Record<string, unknown>,
      timeoutMs,
      maxOutputBytes: RESULT_OVERHEAD_BYTES,
      authorize: authorize(['text', 'title']),
      execute: async (input, context) => {
        try { return await core.proposeMemory(input, { signal: context.signal }, MEMORY_TOOL_ORIGIN); } catch (error) { return toolFailure(error); }
      },
    });
  }
  return tools;
}
