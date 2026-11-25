export type LogJsonValue = null | boolean | number | string | readonly LogJsonValue[] | { readonly [key: string]: LogJsonValue };
export interface LogPosition { readonly sourceId: string; readonly sequence: number; readonly digest: string }
export interface RunIdentity {
  readonly systemId: string; readonly generation: number; readonly runId: string; readonly agentId: string;
  readonly harness: Readonly<{ id: string; version: string; digest: string }>;
}
export interface PayloadReference {
  readonly sourceId: string; readonly systemId: string; readonly generation: number; readonly digest: string;
  readonly bytes: number; readonly mediaType: 'application/json' | 'application/octet-stream';
}
export interface LogDraft {
  readonly identity: RunIdentity; readonly schema: Readonly<{ id: string; version: number }>;
  readonly type: string; readonly causal: readonly LogPosition[];
  readonly payload: Readonly<{ inline: LogJsonValue }> | Readonly<{ artifact: PayloadReference }>;
}
export interface LogCommit { readonly requestId: string; readonly records: readonly LogDraft[] }
export interface LogReceipt { readonly first: LogPosition; readonly head: LogPosition; readonly count: number }
