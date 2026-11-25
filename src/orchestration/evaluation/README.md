# Evaluation runner

`runEvaluation` runs JSON cases sequentially with explicit repetitions and app-owned
verifiers. It never creates an Agent or retries a callback. Use it through the
optional `hiveagents-runtime/orchestration` entry after integration.

```ts
const report = await runEvaluation({
  id: 'classifier-v2',
  suite: { id: 'independent-labels', version: '1', cases: [
    { id: 'one', input: 'A backup failed', expected: 'backup' },
  ] },
  profile: { id: 'classifier', version: '2', sourceDigest: sourceSha256 },
  repetitions: 2,
  timeoutMs: 10_000,
  execute: async (input, context) => ({
    output: await classify(input, { signal: context.signal }),
  }),
  scorers: [{ id: 'category', version: '1', score: (output, expected) => ({
    value: Number(output === expected), passed: output === expected,
  }) }],
});
```

Callbacks receive a stable attempt ID, case ID, one-based repetition, derived
signal, epoch-millisecond deadline and awaitable `recordEvent`. JSON inputs,
expected values and outputs are strict snapshots and deeply frozen. Callbacks,
scorer identities, profile and trusted port methods are captured before work.
Change scorer versions whenever oracle code or semantics change; their digest
binds these explicit identities, not JavaScript function source or closures.

The timeout includes tracing, budget admission, execution and verification.
Cancellation is cooperative: pending callbacks, admission promises and submitted
event writes are drained before releasing a budget reservation or starting the
next attempt. Callbacks must await their own external work. With SDK exec
`Agent`/`Session` starters, pass `awaitSettlement: true` in the turn options
(including when using `runObservedTask`). This propagates through readiness,
exec-only fallbacks, adapter prerequisites, pending stream `next()` and cleanup.
The deadline still aborts the cooperative signal, while actual noncooperative
work keeps the callback and reservation pending. Default turn cleanup remains
bounded; awaiting its public promise alone cannot attest native settlement.
Control turns reject this exec-only option before starting a model turn. A callback that never
settles keeps the returned promise and reservation pending. A denied admission
stops the remaining suite; it does not trigger a retry. Admissions describe this
runner's accepted attempts and are not evidence of native provider launches.
The first cancellation or deadline cause wins, including during terminal writes.
The deadline timer keeps standalone Node evaluation processes alive until it fires
or cleanup clears it. Event submission closes after callbacks finish; already
submitted event writes are drained before terminal tracing begins.

Terminal tracing uses `evaluation.attempt.completed` and, when a deadline or
parent cancellation arrives during that write or the suite completion marker,
an explicit `evaluation.attempt.corrected` record with the final status and code.
For each attempt's `phaseId`, the latest completed/corrected record is authoritative.
The runner awaits corrective writes before returning or releasing its reservation;
a corrective sink failure rejects the run. `evaluation.completed` is a suite
scheduling marker, while the trace episode itself remains owned by its caller.
An observed budget rejection is retained as `budgetDenied: true` even if tracing
later times out or is cancelled. It still stops scheduling and contributes to
`metrics.denials`; an interrupted admission without an observed rejection does not.

All scorers must pass. Reports contain bounded statuses, symbolic failure codes,
scores, SHA256 corpus/output/profile/scorer digests and scalar usage. They do not
contain raw cases, outputs, exception messages or AgentEvent payloads. Free-form
scorer codes are replaced with `SCORER_CODE_REDACTED`. A trace writer may implement
`observe` to project AgentEvents safely; trace persistence failures remain fatal
and are never relabelled as model or verifier failures. Budget release failures
also reject the run.

First-pass and per-repetition pass rates use the full corpus as their denominator,
including cases not reached after cancellation or denial. `metrics.total` counts
observed attempts. Consistency is the fraction of cases with an output digest for
every repetition and one distinct digest. p50 and p95 are nearest-rank observed
attempt durations, including admission, callbacks, trace writes and cleanup;
empty observations yield zero duration and zero rates.

Usage coverage records the number of attempts with each scalar field and its
known sum. An unknown sum is `null`, while a reported zero stays zero. Costs are
partitioned by `costMeaning` and are never mixed. Per-model usage is validated but
not retained in the report. Integer aggregate overflow rejects the report.

`validateEvaluationReport` checks loaded JSON, exact fields, digest, attempt order,
status/verification invariants, aggregate usage and metrics. These checks detect
corruption; checksums do not authenticate an attacker-controlled store. The app
owns report persistence. `compareEvaluations` validates both reports and requires
the same corpus digest, suite identity/case IDs, scorer digest and repetitions.
It returns measured deltas with explicit profile and source digests. Different
profiles/sources are allowed so a baseline and candidate can be compared; all
versions, labels and source identities remain the app's responsibility.

## Promotion gate

`runPromotionGate` decides whether a changed harness, model or prompt may replace the
current one. "Done" is a verified postcondition: each postcondition the system's manifest
declares is checked by a verifier, registered under the same id, that inspects the state
a run left behind. The agent's final message is a claim and decides nothing.

```ts
const verifiers = new PostconditionRegistry().register({
  id: 'followup recorded', version: '1',
  verify: ({ state, input }) => {
    const rows = readFollowups(state.database, input.customer);
    return rows.length === 1
      ? { status: 'verified', evidence: { rows: 1 } }
      : { status: 'failed', evidence: { rows: rows.length }, code: 'ROW_MISSING' };
  },
});
const decision = await runPromotionGate({
  id: 'followups-prompt-3',
  postconditions: manifest.host.postconditions,
  verifiers, suite,
  baseline: { profile: currentProfile, promptDigest: sha256(currentPrompt), run: runCurrent },
  candidate: { profile: nextProfile, promptDigest: sha256(nextPrompt), run: runNext },
  budget: canaryBudget(ledger, { providerKey: 'claude', owner: 'followups:canary', maxWaitMs: 600_000 }),
  timeoutMs: 900_000,
});
if (decision.decision === 'promote') activate(nextProfile);
```

`run` returns `{ state, claim?, usage? }`. `state` says where the results are: a path, a
row id, a record key. It comes from the harness, not from the model. `claim` is the
agent's last message: the gate keeps its SHA-256 and never passes it to a verifier. A
verdict is `verified` or `failed`, with evidence of what was observed. These count as
failed: a verifier that throws (`VERIFIER_ERROR`), a malformed verdict (`INVALID_VERDICT`),
`verified` without evidence (`VERDICT_WITHOUT_EVIDENCE`), evidence over 16,384
characters of JSON (`EVIDENCE_TOO_LARGE`) and evidence that quotes the agent's message
(`CLAIM_AS_EVIDENCE`).

Evidence is a non-blank text, or a list or object with at least one text, number or
boolean somewhere inside. A bare `true`, a bare number, a blank string and containers
holding only nulls, blanks or empty containers are not evidence. The gate checks that
evidence is present; it cannot judge whether a text such as `'ok'` describes anything.
What a verifier reports is the verifier author's responsibility.

`timeoutMs` bounds each attempt. At the deadline the attempt's signal aborts, and the two
callbacks are treated differently:

- A verifier is cut off at that moment. The attempt ends as `timed-out`, the side is
  incomplete (`BASELINE_INCOMPLETE` or `CANDIDATE_INCOMPLETE`), the admission slot is
  given back, and whatever the verifier answers later is discarded. A verifier launches
  no provider process, so nothing can still be using the slot.
- A `run` is waited for. It may have a provider process alive, and a slot is given back
  only once that work has stopped. A `run` must stop and settle when `context.signal`
  aborts; one that ignores it keeps the gate pending and its slot held, and with
  `canaryBudget` that slot blocks production on the provider until the run settles or
  an operator recovers the reservation.

The decision is `promote`, `block` or `unchanged`. `changed` lists what differs between
baseline and candidate: `harness` (source digest, transport, options digest), `model`
(provider, model) and `prompt` (prompt digest). When nothing differs the gate runs
nothing and answers `unchanged`. `blocks` lists every reason for a block:

| Code | Meaning |
|---|---|
| `NO_POSTCONDITIONS` | The system declares none, so nothing could be verified. |
| `VERIFIER_MISSING` | A declared postcondition has no registered verifier. Nothing is run. |
| `POSTCONDITION_FAILED` | The candidate left a state that fails it. `regression` is true when the baseline verified it. |
| `CANDIDATE_INCOMPLETE` | Some attempt did not reach a verdict: error, timeout, cancellation or refused admission. |
| `BASELINE_INCOMPLETE` | The same for the baseline. The candidate is then not run. |
| `BASELINE_INCOMPARABLE` | A recorded baseline used another suite, verifier versions or repetitions. Nothing is run. |

A baseline that completes but fails a postcondition does not block a candidate that
verifies it. The baseline is either a subject that the gate runs first, or the record
of an earlier promotion, `{ report, promptDigest }` taken from that decision's
`candidate`, which costs no run.

The decision is frozen JSON with its own digest: the reports of both sides, each
attempt's status, claim digest and per-postcondition evidence, and the measured
comparison. It holds no raw inputs, outputs or messages beyond the evidence verifiers
chose to return; the app decides where to store it. At most 100 postconditions fit in
one gate.

`canaryBudget` admits every attempt through the shared admission ledger at `low`
priority, so a waiting production launch is admitted first (see the budget README).
The attempt timeout includes that wait. The evaluated `run` must not take a second
slot for the same turn.
