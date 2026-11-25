import { snapshotApplicationTools } from '../tools/registry.js';
import type { AgentOptions } from './types.js';

/** Snapshot callback metadata without cloning trusted application functions. */
export function snapshotAgentOptions(options: AgentOptions): Readonly<AgentOptions> {
  const { tools, ...metadata } = options;
  return Object.freeze({ ...structuredClone(metadata),
    ...(tools === undefined ? {} : { tools: snapshotApplicationTools(tools) }),
    ...((tools?.length ?? 0) > 0 ? { capabilities: { ...metadata.capabilities, inProcessTools: 'required' as const } } : {}),
  });
}
