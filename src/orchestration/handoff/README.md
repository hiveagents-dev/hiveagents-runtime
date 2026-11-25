# Durable task handoff

`createTaskHandoff` captures an immutable snapshot of application-selected JSON,
source and destination identity, evidence digests, inert artifact URIs, pending
work, and ambiguous effects. Its SHA256 digest uses recursively sorted object
keys, preserves array order, and excludes generated timestamps. Recreating the
same draft is idempotent. An optional `sourceSession` is validated provenance;
the module does not create an Agent, fetch artifacts, or resume a native session.
The receiver opens a new session explicitly when its application needs one.
Session identity fields emitted by SDK refs and exports (`sessionId`,
`forkedFromId`, and `parentSessionId`) are preserved as bounded provenance.
When present, `sessionId` must equal `id`; unknown raw provider fields reject.

`WorkflowHandoffStore` adapts an existing `WorkflowStore` using a versioned
`handoff:<id>` checkpoint envelope. Its exclusive lease serializes same-ID writes
and loads. Saving identical content does not rewrite it; saving different content
under that ID rejects. Loads validate the envelope, exact bundle fields and its
checksum. `FileWorkflowStore` provides private local files and explicit ownership;
its documented filesystem and recovery limitations still apply. A checksum detects
corruption, and does not authenticate a party that can rewrite the store.

`runHandoff` loads and validates the bundle, exact target and source digest, and
rejects unresolved effects before requesting authority. It composes the existing
`DecisionRunner` as its sole effect engine. The decision binds the handoff digest,
source digest, destination and explicit authority identity/version. `authorize`
receives fresh immutable context for every new dispatch; `isCurrent` checks live
application authority after durable intent persistence, immediately before
`execute`. These trusted application ports determine policy. Source metadata,
SessionRef provenance, selected context and model text never grant authority.
When `execute` awaits before its actual external effect, it must check current
authority again at that effect boundary.

`execute` receives the DecisionRunner context plus frozen `handoff` and `target`.
`verify(result, context)` must independently inspect real evidence and return
`{verified, evidence}`. A verified result receives a durable decision receipt.
A later call returns that receipt without repeating completed work. A recovered
`dispatched` result can be verified without executing again. A recovered intent,
changed binding or uncertain effect requires owner reconciliation and never
automatically replays. Replacement work needs a new identity after reconciliation.

Cancellation is cooperative: returned authorization, execution and verification
promises are awaited before releasing the decision lease. A late execution result
is persisted separately from verification; an aborted run does not start a new
verification callback. A later non-aborted call can verify that result. Store
failures propagate and do not become successful execution or verification.

Boundary validation rejects unknown fields, accessors, symbols, unsupported
objects, cycles, sparse arrays, undefined and nonfinite numbers. Bundle JSON is
limited to 1 MiB, depth 64 and 50,000 visited values; lists to 1,000 entries.
Identifiers are 1–256 ASCII identifier characters; digests are 64 lowercase hex
characters. Goal text is at most 16,384 characters, list entries and URIs 4,096,
and models/session identifiers 256. Artifact URIs require an absolute URI scheme
but remain inert. Custom stores and authority ports are trusted application code
and must preserve exclusive ownership and immutable same-ID persistence.

`readHandoffDecision({id, handoffId, store, decisionStore})` inspects existing
state without running authorization, effects, verification callbacks, or saving a
decision. It reuses `DecisionRunner` record validation and binds the decision input
to the loaded handoff ID, digest, source and exact destination with input version
`task-handoff:1`. An absent decision returns `undefined`; malformed records or a
different binding reject. The store's temporary exclusive read lease still applies.
