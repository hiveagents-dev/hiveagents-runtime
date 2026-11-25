# Durable local traces

`openTraceEpisode(store, identity)` snapshots the task, source and profile identity,
saves a running episode before returning, and owns its lease until `close()`.
Await `append()` before dispatching the corresponding work. Every append and
`finish('completed' | 'failed' | 'cancelled')` waits for durable persistence.
A sink rejection is visible, poisons later writes, and leaves `snapshot()` at the
last successful durable state. `close()` drains submitted writes and is idempotent.
Closing a running episode permits reopening with the exact same identity;
finished episodes are immutable and can only be read with `readTraceEpisode()`.

`TraceWriter` is the minimal consumer port: `append(event)` and optional
`observe(AgentEvent)`. The recorder's observer projects event type, session/turn,
tool/subagent/interaction IDs, terminal status, text character counts and validated
usage. It does not retain text, prompts, tool names/arguments/results/errors,
interaction authority, session paths, warnings, provider metadata or raw provider
events. `provider.event` keeps its type only. Use app-controlled identifiers and
codes for explicit append calls; identifiers themselves are retained. An episode
is metadata, not a full transcript or proof of model quality or effect success.

All public inputs and loaded records reject unknown fields. SHA256 fields require
64 lowercase hex characters; identifiers use letters, digits and `._:@/+~-`, start
with a letter or digit, and are at most 256 characters (types/versions: 128).
Counts and token quantities are nonnegative safe integers; costs are finite and
nonnegative with an explicit `costMeaning`. There are at most 32 per-model usage
buckets, 10,000 entries, 16 KiB per event and 4 MiB per episode. Unknown usage fields
remain absent rather than becoming zero. Timestamps are epoch milliseconds and
sequences are one-based. Checksums use recursively sorted JSON object keys and
detect corruption; a writer with store access can recompute them.

`WorkflowTraceStore` uses a versioned `trace:` workflow envelope and enforces the
episode identity, append-only history and terminal immutability under its lease.
The supplied `WorkflowStore` is a trusted application port and must provide actual
exclusion and atomic durable saves across all its clients. `FileWorkflowStore`
provides this in a trusted private local directory: newly created directories use
0700 and files use 0600. It is not a distributed store. There is no expiry-based
lease stealing; explicit abandoned-owner recovery remains with the workflow store
and requires the owner and its work to have stopped. Trace metadata grants no
execution authority, budget, native session resume or release permission.
