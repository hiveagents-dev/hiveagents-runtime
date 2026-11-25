/** Supported process and discovery primitives for independently packaged adapters. */
export { runProcess } from '../process/run-process.js';
export type { ProcessRequest, ProcessOutcome } from '../process/run-process.js';
export { resolveBinaryCandidates } from '../process/resolve-binary.js';
export type { LaunchTarget } from '../process/resolve-binary.js';
export { ExecDiscovery } from '../process/exec-discovery.js';
export { IncrementalLineDecoder } from '../process/json-lines.js';
export { AbortError, AgentRuntimeError, OutputLimitError, ProtocolError, TimeoutError } from './errors.js';
export { ExecutionHaltedError, isExecutionHalted } from './execution-halt.js';
export type { ProcessRunner, ExecProbeContext, ExecProbeTurn } from '../adapters/provider.js';
