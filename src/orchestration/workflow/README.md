# Optional durable workflows

This module executes provider-independent callbacks in dependency waves. It has no model,
agent, policy, publication, or network adapter. Applications decide what each callback
may do. The browser-safe `graph.ts` exports `dependencyWaves` and `DependencyCycleError`;
the runner and file store require Node.js.

```ts
import { FileWorkflowStore, WorkflowRunner, type WorkflowDefinition } from 'hiveagents-runtime/orchestration/workflow';

const runner = new WorkflowRunner(new FileWorkflowStore('/absolute/private/workflow-state'));
const workflow: WorkflowDefinition = {
  id: 'document-review',
  version: '1',
  steps: [
    { id: 'read', execute: async () => ({ text: 'A supplied document.' }) },
    {
      id: 'review', dependencies: ['read'],
      execute: async ({ dependencyOutputs }) => ({ reviewed: dependencyOutputs.read ?? null }),
    },
  ],
};
const result = await runner.run(workflow, { runId: 'document-123', concurrency: 2 });
```

Steps need unique nonempty IDs and must name existing dependencies. Cycles and duplicate
dependencies are errors. Order within a wave follows declaration order. A later wave
waits for the entire preceding wave, including retries. Up to `concurrency` callbacks
run at once (default four). Failed dependencies block their descendants; independent
steps can still complete. A callback must return a JSON value, including `null` when it
has no output. Non-finite numbers, `undefined`, sparse arrays, class instances, accessors,
non-enumerable properties, functions, symbols and cycles are rejected. Dependency
outputs are copies, so a callback cannot mutate a previous step's saved result.

## Identity, retry and resume

`runId` identifies one persistent execution. Reusing it resumes that execution and
never reruns a completed step. A different run needs a different ID. The checkpoint
binds the workflow ID, version, step order, dependency graph, retry budgets and replay
flags. **Change `version` when callback implementation, closed-over input or semantics
change.** The fingerprint cannot identify arbitrary JavaScript closures or external
input changes; caller versioning is part of the contract.

`maxAttempts` includes the first call and defaults to one. The attempt is checkpointed
before invoking the callback and remains consumed across retries and restarts.
Opting into additional attempts permits repeated calls after reported failures; an
error does not imply that an external side effect did not occur. There is no automatic
backoff or external retry classification. The callback receives its one-based `attempt`,
its `signal`, and an `idempotencyKey` stable for that run, definition and step across all
attempts. Pass that key to an external system that actually implements deduplication.

An aborted signal stops queued work and is passed to active callbacks. The runner waits
for every active callback before releasing ownership. A callback that successfully
returns during cancellation is saved as completed; one that throws after cancellation
is interrupted. Callbacks that ignore cancellation may delay return indefinitely.
A fresh runner with the same store and definition resumes remaining pending steps.

A crash or interrupted callback can leave its external outcome unknown. The default
resume returns `status: 'halted'` before starting any more work. Replaying requires both
`replaySafe: true` on every ambiguous step and the explicit run option
`recoverInterrupted: 'replay-safe'`. This consumes another remaining attempt; exhaustion
fails the step. There is no implicit reset of retry budgets or completed results.
The module does **not** guarantee exactly-once external effects. If a side effect occurred
before its checkpoint, safe recovery depends on the application's idempotency/replay
contract; otherwise retain the halted run and reconcile outside this module.

## File store ownership and crash recovery

`FileWorkflowStore(directory)` is for a trusted private directory on a local filesystem.
Every run holds an exclusive nonempty lock directory for its entire lifetime. A second
runner, including one in another process, is rejected with `WorkflowRunLockedError`.
There is no TTL, automatic stale-lock removal or distributed lease. Checkpoints are
checksummed, written to a fresh file, synced, atomically renamed and followed by a
directory sync. Checksums detect accidental corruption, not an authorized or malicious
editor recomputing the checksum; checkpoint schema and definition checks still apply.
The store serializes its lease operations, including a release submitted during a save.
A persistence error aborts active work, drains it, and rejects the run without scheduling
more callbacks.

A crashed process deliberately leaves ownership behind. Inspect it first:

```ts
const store = new FileWorkflowStore('/absolute/private/workflow-state');
const owner = await store.inspectOwnership('document-123');
// Operator verifies that the previous owner, child processes and external work stopped.
if (owner) {
  await store.recoverAbandoned('document-123', owner.token, { ownerStopped: true });
}
```

The acknowledgement is a required assertion of operator verification. A PID is only a
conservative diagnostic: a live or reused PID, unknown liveness, another host, or a
changed token blocks recovery. A missing PID alone does not establish that descendants
or external work stopped. Recovery retains a nonempty tombstone for the old token so
a concurrent recovery cannot remove a later owner's lock. Do not remove tombstones,
edit ownership files, or clean up prepared directories while runners or recovery
operations are active. An unreadable/incomplete ownership record needs offline operator
reconciliation; it is never treated as expired.

These are local cooperation and process-crash semantics, not a distributed fencing or
release authority. Network filesystems, hostile writers, cross-host ownership, arbitrary
power-loss behavior and external-system fencing are outside this store's contract.
A custom `WorkflowStore` must preserve exclusive same-run leases and atomic checkpoint
replacement across all clients. Checkpoints contain application outputs as plaintext.

## Evidence

Run `node scripts/benchmarks/workflow-durability.mjs` for a pinned baseline comparison.
It executes the actual `readWaves` function from commit `171d67f` and a synthetic
`Promise.all` callback harness, then the durable runner on a six-step DAG. It reports
source hashes, real callback counts, peak concurrency, timings and the runtime.
There are no provider calls. A restart after the first three completed callbacks costs
nine total callbacks in a naive restart and six with checkpoints: three repeated calls
saved. The existing app already has waves and app-specific resume logic; this does not
claim an additional three-call saving over that implementation. File sync adds overhead
to a healthy run. No provider speed or cost reduction follows from synthetic timers.

The process-boundary tests also kill a real child process after its second callback
starts, reject a competing process, recover ownership explicitly, halt unsafe replay,
and resume a replay-safe step without reexecuting its completed predecessor.
