import type { ExecAdapter } from '../adapters/provider.js';
import type {
  CapabilityStatus, CapabilitySupport, ModelInfo, RuntimeWarning,
  SessionPersistence, SessionRef, TransportKind,
} from '../public/types.js';
import type { ControlSessionHandle } from './control-session.js';
import type { AgentLogCaptureBinding } from '../orchestration/log/capture-runtime.js';
import type { PinnedTurns } from './pinned.js';
import type { MemoryTurns } from './memory.js';

export interface SessionConfig {
  capture?: AgentLogCaptureBinding;
  adapter: ExecAdapter;
  model: ModelInfo;
  resolveModel?: (requested: string) => ModelInfo;
  cwd: string;
  transport: TransportKind;
  persistence: SessionPersistence;
  cliVersion?: string;
  instructions?: string;
  effort?: string;
  contextArgs: string[];
  permissionArgs: string[];
  env: NodeJS.ProcessEnv;
  warnings: RuntimeWarning[];
  features: Record<string, CapabilitySupport>;
  providerOptions?: Record<string, unknown>;
  resume?: SessionRef;
  /** Present only on a control transport; its absence keeps the exec path. */
  control?: ControlSessionHandle;
  /** Negotiated control verdicts; gates steering and other control-only operations. */
  negotiated?: Record<string, CapabilityStatus>;
  /** Present only when the Agent was given the `pinned` option; its absence changes nothing. */
  pinned?: PinnedTurns;
  /** Present only when the Agent has memory (its own option or the Runtime default); its absence changes nothing. */
  memory?: MemoryTurns;
}
