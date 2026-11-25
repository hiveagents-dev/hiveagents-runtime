import type { AgentEvent, Usage } from '../../public/types.js';

export interface TraceIdentity {
  episodeId: string;
  task: { id: string; version: string; inputDigest: string };
  source: { id: string; version: string; digest: string };
  profile: { id: string; version: string; digest: string };
  provider?: string;
  model?: string;
  transport?: string;
  cliVersion?: string;
}

/** Metadata only. Arbitrary fields, free text, raw provider events and tool payloads are rejected. */
export interface TraceEventInput {
  type: string;
  phaseId?: string;
  parentId?: string;
  sessionId?: string;
  turnId?: string;
  status?: string;
  code?: string;
  count?: number;
  toolId?: string;
  subagentId?: string;
  interactionId?: string;
  usage?: Usage;
}
export interface TraceEntry extends TraceEventInput { sequence: number; timestamp: number }
export type TraceTerminalStatus = 'completed' | 'failed' | 'cancelled';
export interface TraceEpisode {
  format: 1;
  identity: TraceIdentity;
  status: 'running' | TraceTerminalStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  entries: readonly TraceEntry[];
  /** Corruption checksum, not an authentication signature against store writers. */
  digest: string;
}

/** Trusted app port: exclusive across all clients for this episode; never expires active ownership. */
export interface TraceLease {
  load(): Promise<unknown | undefined>;
  /** Atomic durable save. Reject failures rather than reporting undurable progress. */
  save(episode: TraceEpisode): Promise<void>;
  release(): Promise<void>;
}
export interface TraceStore { acquire(episodeId: string): Promise<TraceLease> }
export interface TraceWriter {
  append(event: TraceEventInput): Promise<void>;
  observe?(event: AgentEvent): Promise<void>;
}
export interface TraceRecorder extends TraceWriter {
  observe(event: AgentEvent): Promise<void>;
  snapshot(): TraceEpisode;
  finish(status: TraceTerminalStatus): Promise<TraceEpisode>;
  /** Waits for already submitted writes, then releases. Safe to call more than once. */
  close(): Promise<void>;
}
