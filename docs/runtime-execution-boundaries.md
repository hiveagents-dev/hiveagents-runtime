# Provider runners and execution halts

Built-in factories accept `runner` and optional `probeRunner`. The external Gemini factory accepts the same pair. Discovery, authentication commands and compatibility probes use `probeRunner`; actual generation uses `runner`. When omitted, `probeRunner` uses the ordinary runner. Both references are captured when the factory is created and survive target pinning. This separates process ownership; it establishes no authentication entitlement or host authority.

```ts
const provider = createClaudeProvider({
  runner: generationRunner,
  probeRunner: metadataRunner,
});
```

`ExecutionHaltedError` signals that infrastructure cannot safely continue execution or dependent selection. It is always non-retryable. Fixed and automatic selectors, learning preflight and shared executable discovery preserve the same nominal error, including a genuine halt inside an outer native Error cause/AggregateError. The guard never evaluates supplied getters or proxy traps; a plain `code` object or fabricated prototype does not become a nominal halt.

Error graph inspection is bounded to 64 nodes and depth 16. An oversized genuine native error graph conservatively produces an `ExecutionHaltedError` with the original graph as private cause. This stops further work without granting permissions or releasing capacity. Error causes must be projected through a trusted safe catalog before crossing a worker/UI boundary.

Fresh readiness with `awaitSettlement: true` retains a genuine late probe halt even when caller cancellation won the initial public race. It drains actual probe ownership, rethrows the original halt graph and disposes the scope. Ordinary late probe errors retain cancellation behavior; callers that do not request settlement still receive prompt cancellation.

Learning execution settles its logical reservation exactly once before publishing terminal observations or a shadow snapshot. Infrastructure halts observed during streaming, cleanup or release produce unknown quality and latency, outside verified model training evidence. It preserves the original failure graph and skips shadow training and maintenance. A hosted budget's logical release must itself verify the native settlement state; ordinary SDK finally cleanup is never permission to release a hosted native reservation.

Gemini's own detect/help calls inside stream also use its probe runner. Its passive authentication result and subscription limitations are unchanged. These interfaces enable the optional host to bind actual provider attempts and separately bounded probes; they do not create that host, a guardian or a paid routing service.

The legacy native runner cannot signal a saved numeric group after its leader exits. Its supported group-cleanup fixture keeps the leader alive through escalation. Exited-leader ownership, inherited stdio and ignored-stdio descendants are covered separately by the host's native keeper proof; this document does not claim the legacy limitation is repaired. Synthetic failure fixtures have bounded lifelines, separate from framework cleanup evidence.

Session failure projection uses fixed public messages and `sanitizedDiagnostics.kind`. Raw provider prose and stderr remain private classification inputs; they are not copied into errors. `rawCode` retains only a finite catalog of known semantic codes, including verified terminal categories and bounded exit codes; arbitrary code-shaped strings are omitted. Code that previously inspected free-form error text should use the nominal SDK code and structured fields. Observed usage, confirmed session identity and retryability remain available.

Codex RPC error diagnostics likewise retain a fixed kind and recognized JSON-RPC code, excluding native message/data fields. Post-close requests do not interpolate an earlier cause. A genuine infrastructure halt graph is preserved before generic closed-peer projection. Explicitly requested provider streams/native transcripts and errors from trusted application callbacks remain separate data contracts; this projection does not sanitize or rewrite their content.
