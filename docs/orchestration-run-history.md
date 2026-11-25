# Declarative task history in the neutral execution log

`hiveagents-runtime/orchestration/log` exposes the existing `LogExecutionDatabase`, managed effect/workflow stores, trace/audit projectors and the additive `createRunHistory` API. They share one immutable log source. No second run database or schema migration is required.

```ts
import { LogExecutionDatabase, createRunHistory } from 'hiveagents-runtime/orchestration/log';
import { Runtime } from 'hiveagents-runtime';

const database = new LogExecutionDatabase({ databasePath, systemId });
const history = createRunHistory({ database });
const start = await history.begin({ identity, requestId: beginRequestId, inputDigest });
if (start.kind === 'started') {
  const runtime = new Runtime({ providers: approvedRegistrations,
    capture: { store: database.captureStore, identity } });
  // Execute the accepted task and drain its owned work before observing completion.
  await history.complete(start.run, { requestId: completeRequestId, outputDigest });
}
const recovered = await history.recover(identity);
const recent = await history.list({ generation: identity.generation, limit: 64 });
```

The example shows the storage seam; it does not grant a provider, Host admission, effect execution, or permission to spawn. Hosted composition forwards `capture` into its actual `Runtime`; creating a second RPC client is unnecessary. `Runtime` gives each actual Agent its own child `agentId` while retaining the task `runId`. Use that Agent's `logIdentity` for its metadata trace and the task identity for lifecycle/audit. All share the same `sourceId` and source head.

`begin` atomically reserves `(systemId, runId)` in the existing SQLite log transaction. Only its original acknowledged first invocation returns the opaque in-process `run` handle. Repeating the identity/input returns `{kind:'existing',record}` with no execution handle. A changed generation, harness, agent or input under that same run ID is refused. A new intentional task needs a new run ID; generation changes do not reinterpret old task identities.

`recover` returns `undefined` for no run, or immutable data with `schemaVersion`, `sourceId`, `identity`, `inputDigest`, `started`, `status` and optional `terminal`, `outputDigest`, `reason`. Status is `unknown` for an acknowledged start without terminal, including a process crash or lost start COMMIT acknowledgement. This state never authorizes replay. `completed` records the trusted producer's completion observation and optional output content digest. It does not prove business postconditions, external effect application, Native cleanup, quota persistence or reservation release. Store output bytes privately and verify their digest when displaying them.

`interrupt(run,{requestId,reason})` records one of `aborted`, `failed`, `stopped`, `halted`; it cannot overwrite completion. Repeating the same terminal observation with the original handle returns the original record. A different terminal observation is refused. A reopened process cannot reconstruct that handle from data. Metadata has no prompts, outputs, exception prose, native diagnostics or credentials.

The data port `database.captureStore.append` accepts only the two closed Runtime metadata schemas, validates and snapshots before awaiting, and admits at most two concurrent producer promises. It cannot append lifecycle, decision, workflow or ownership records. Runtime's existing required capture also bounds writes and halts on missing persistence acknowledgements. Calls after database close fail conservatively.

History reads and writes validate the whole source chain/index before filtering. `maxEntries` defaults to 4096 and can be configured from 1 through 65536. A new start must leave space for its terminal marker and one terminal marker per existing open run. This admission check runs in the same write transaction as the start. Other log producers share the source and can still consume that headroom, so size the limit for both lifecycle and telemetry. Exceeding the scan limit fails closed with a nominal `LogExecutionError`. `list` returns at most 256 starts, latest first, optionally filtered by generation. The history is a bounded recent-data view without pagination or automatic pruning.

Use the existing `LogDecisionStore` + `DecisionRunner` for managed external effects and `LogWorkflowStore` for checkpoints. A recovered intent remains owner-required; a workflow's replay-safe flag and a run-history marker cannot override it. Existing `WorkflowHandoffStore` and `WorkflowTraceStore` adapt the workflow store when durable handoffs/traces are needed. Standalone `recoverAbandoned` requires an explicit exact-owner stopped acknowledgement; it is not a Host termination proof. Native/Host settlement remains separate.

Validation is offline: public built SDK consumed by actual independent Node processes, real Runtime/Agent with an owned Node CLI fixture, one managed file effect, recovery, concurrent first publication and crash UNKNOWN. No installed provider, credentials or inference is involved. The separate existing `log-recovery.test.ts` covers explicit decision/workflow recovery without repeating uncertain effects.
