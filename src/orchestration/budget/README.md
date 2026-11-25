# Host admission

`HostLedger` is an optional export from `hiveagents-runtime/orchestration`. Cooperating processes use one local SQLite file; it coordinates launches and retains crash reservations. It is neither vendor quota discovery nor an authorization boundary against another process that can write the file.

```ts
const ledger = new HostLedger({
  concurrency: { mode: 'unlimited' }, // or { mode: 'limited', maxConcurrent: 3 }
});
await ledger.withSlot('claude', 'my-system:job-id', {
  maxWaitMs: 30_000, signal,
  isQuotaError: error => error instanceof AgentRuntimeError && error.code === 'USAGE_LIMIT',
}, () => actualProviderWork());
```

Limited zero disables launches. Unlimited omits only the concurrency ceiling: defaults still allow 400 launches/hour and 800/day, with a 60-second observed-quota cooldown. These are operator settings, not subscription guarantees. An explicit `providers` map sets each provider's policy; do not combine it with the concurrency shorthand. The first client to register a provider seeds its concurrency. Every later HostLedger admission reads the shared value from SQLite. Hourly, daily and cooldown configuration must still agree.

Waits use filesystem notifications with a bounded missed-event backstop. Cancellation/deadlines prevent later admission; queue time does not belong to an inference timeout. Pass SDK `awaitSettlement: true` inside the callback: a resolved wrapper that abandoned native work is insufficient. Failed durable release or quota persistence surfaces a nominal error; treat it as a halt.

`hostLedgerPath()` supports `OAR_HOST_LEDGER`. Grow and Marketing also accept `OAR_HOST_CONCURRENCY=unlimited` or a canonical nonnegative integer. Their isolated data overrides select separate files unless an explicit shared file is provided. Update both apps that share the file before changing its policy. Older binaries can refuse admission when their startup value differs.

The operator can inspect and change a provider from the installed CLI:

```sh
hiveagents-runtime concurrency claude --database /absolute/path/ledger.sqlite
hiveagents-runtime concurrency claude 5 --database /absolute/path/ledger.sqlite --expected-revision 0
hiveagents-runtime concurrency claude unlimited --database /absolute/path/ledger.sqlite --expected-revision 1
```

The SDK exposes `getConcurrency(provider)` and `setConcurrency(provider, { expectedRevision, concurrency })`. Compare-and-set serializes concurrent operator edits. Repeating a successful transition at the immediately following revision is safe. Decreasing the limit preserves active reservations and waits for enough releases. Increasing it wakes queued clients. Edits preserve usage counts and cooldowns.

After observing an explicit usage denial, `recordQuotaError(provider, retryAtMs?)` accepts a verified absolute reset time in Unix milliseconds. The ledger persists the latest of that time, its configured cooldown and any existing pause. Available-window reports and soft warnings are observations only.

Recovery is explicit: inspect an exact token set privately, show counts/digest, then call `recover` with that set and a stopped-work acknowledgement bound to the inspection. The caller must verify that work stopped. Elapsed time, a missing PID, a lock or reopening an app do not prove it. Newer and foreign reservations remain held. Raw tokens must not reach UI snapshots or logs.

`lookupOwner(provider, exactOwner, { limit: 2 })` is a bounded host-only inspection for an admission whose acknowledgement was lost. The default limit is two, the maximum is 100, and `truncated` distinguishes additional matches. It includes retained released rows and matches literal owners, never prefixes. It does not advance the observed clock, prune, acquire or release. A missing result cannot prove that an older acquisition will not commit; released history can also have been pruned. Multiple matches or a storage/policy/clock failure require explicit reconciliation. Results contain bearer tokens and must never cross into worker/model/UI messages.

`storageIdentity()` measures the pinned SQLite connection's canonical file binding and returns only `{ format: 1, digest }` inside a `BudgetResult`. Device/inode identifiers retain exact integer precision. The digest stays stable as debits and releases change; a copied/replaced file does not become the same binding. Failure or a closed connection returns no claimed identity. This is local storage evidence for trusted composition, not a lease, authorization, stopped-work proof or portable restore identity. It never exposes the path or reservation tokens and never acquires/releases capacity or advances the budget clock.

Repository operator utilities, after building:

- `node scripts/recover-host-ledger.mjs inspect --ledger /absolute/admission.sqlite --owner-prefix marketing: --inspection /private/new-inspection.json` writes a new private file and prints counts/digest. Recovery requires the same arguments with `recover`, `--expected-digest DIGEST` and `--confirm-work-stopped`. Supply `--concurrency unlimited` when that is the persisted policy. Files contain bearer tokens and must remain private.
- `node scripts/migrate-host-ledger.mjs --source /absolute/turn-admission.sqlite --owner-prefix grow:` prints a token-free legacy inspection. After stopping the old app, add `--apply --expected-digest DIGEST --confirm-source-stopped` and optionally `--target /absolute/admission.sqlite --concurrency unlimited`. Do not run an old writer afterward.

Legacy migration preserves debits, active holds, cooldowns, observed clock and pruning watermarks in one target transaction. It never writes or frees the source. Persistent import provenance survives reservation pruning, preventing recovered holds from reappearing on a later import. Grow refuses shared admission when legacy history exists without a matching migration receipt. An unchanged receipt does not prove termination; the operator acknowledgement remains a trusted input.

## Read-only view

`readHostLedgerView(databasePath, now?)` returns what the ledger holds right now, for a screen: per provider, the limits, the launch counts, the pause and who holds each slot. It opens the file read-only, so it needs no concurrency policy, never creates or migrates the file, never moves the clock mark and cannot refuse a launch. Tokens are never returned. A missing file reads as `absent`, a file that is not this ledger as `unrecognized`, and a read that fails as `unavailable`.

## Priority

Admission has two priorities. `normal` is the default and what every existing caller gets. `low` is for canaries and evaluation runs:

```ts
await ledger.withSlot('claude', 'my-system:canary', { maxWaitMs: 600_000, priority: 'low' }, () => canaryWork());
ledger.reserve('claude', 'my-system:canary', 'low'); // one immediate attempt
```

A caller that waits (`acquire` or `withSlot` with `maxWaitMs > 0`) is declared in the shared file from its first refused attempt until it is admitted or stops waiting. While a `normal` launch is declared for a provider, a `low` launch for that provider is refused even if a slot is free: the answer is `concurrency-limit` with `outranked: true`, and a waiting `low` caller keeps waiting. So when a slot frees, the waiting production run gets it before a canary that arrived earlier. This holds between separate processes, because the declaration lives in SQLite and the check runs inside the admission transaction.

What it does not do. A canary that is already running keeps its slot until it finishes: nothing is preempted and no slot is held back for production. There is no order among callers of the same priority. A canary can wait for as long as production keeps queueing; bound it with `maxWaitMs`.

Only a production caller that waits has precedence. A `reserve` call, or an `acquire` with `maxWaitMs: 0`, is one immediate attempt and is never declared, so a canary cannot know that it would come back. If such a caller is refused while a canary is waiting, the canary takes the slot when it frees and the caller's next attempt is refused again. A production path that wants to go ahead of canaries has to use `acquire` or `withSlot` with a wait. Of the repository's apps today, Marketing waits (`withSlot`) and is covered. Grow makes one immediate `reserve` and stops with `agent_capacity`, so it is not covered until it waits briefly before stopping (plan, phase 1, correction 11).

A slot held by a canary is like any other reservation: it never expires. The promotion gate gives it back when the attempt settles, and cuts a stuck verifier off at the attempt deadline, but it waits for a run that ignores its stop signal (see the evaluation README).

A declaration is a lease of `WAITER_LEASE_MS` (90 seconds) that a live waiter renews on every attempt, at most 30 seconds apart. If the waiting process dies, its precedence lapses with the lease; that never frees or grants a slot. The declarations live in one additive table, `budget_waiters`, created on first use. The file stays at `user_version` 1, so `readHostLedgerView`, the legacy inspection and a process on an older build keep working on it. An older build neither declares its waits nor yields: the rule only binds processes that run this version.
