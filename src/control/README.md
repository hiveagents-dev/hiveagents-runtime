# Control turn buffering

Claude and Codex control adapters prepare a private, turn-local output spool before native prompt submission. Progress and sequence records are JSON; interaction signals and terminal records stay in a separate bounded reference lane. Native approval handlers, tool cancellation and terminal waiters run independently of public reads. RPC publication never waits for disk or UI delivery.

The default limits per turn are:

| Resource | Limit |
| --- | --- |
| Unread public progress | 16 MiB / 65,536 items, including an envelope charge |
| Live critical references | 64 MiB / 4,096 items |
| Encoded unread spool | 17 MiB / 69,632 records |
| Segment size | 1 MiB; configurable downward for fixtures |
| Live segment files | 256, including pending creation/deletion |
| Observed writer tasks | 1, with staging charged to the unread budget |
| Read-ahead window | 64 KiB |

Factory `buffering` options may lower the public/critical limits or choose an existing absolute temporary directory. The byte, item and segment fuses are independent. Overflow is nominal `OUTPUT_LIMIT`; filesystem failure is nominal `PROTOCOL_ERROR` with the original cause. The affected handle becomes unusable and never replays a prompt or claims the failed turn's output complete. Other Codex threads keep their independent delivery.

Owned temporary directories use mode 0700 and segments 0600. Consumed segments are deleted; completion, direct adapter return and close await disposal of their owned files. These files are temporary transport storage, without an fsync/durability or restart/replay contract. They do not establish OS containment or prove process termination.

The public `Session.stream()` wrapper retains its existing one-second cancellation grace. An early public return can report an interrupted/unknown outcome before the background native drain has disposed the spool. Reconciliation/close must observe that drain and cleanup; an early return does not establish native termination. Direct adapter return and completion await their own cleanup. The separate `Session.start().events` observer retains its existing 4,096-item / 64 MiB policy; this change does not make that observer an unbounded transcript.

## Explicit persisted Codex recovery

A persisted Codex control handle can explicitly reconcile a dead transport. One candidate per handle resumes the same thread with the original captured policy/tool binding, reads its explicit idle metadata, and fetches only one newest turn summary. A known previous turn must match in ID and terminal state. Empty history requires a handle known never to have dispatched a turn; an unacknowledged start remains unknown. Unsupported metadata methods or shapes remain unknown; there is no full-history fallback or prompt replay.

A successful adoption mints a new transport epoch and immediately refreshes Session identity/export. Old approvals, controls, tool completions and callbacks cannot act on that plane. Fork siblings remain independently unknown. Live transport failures caused solely by abandoned/bounded output are not restart signals; process-only failures are terminal.

The recovery wait has a five-second deadline. One synchronous commit checks ownership/deadline and retires the timer before adopting the new plane; a later deadline cannot undo that adoption. Any advertised candidate status must be recognized idle metadata. Old delivery remains busy through actual spool disposal, so recovery and overlapping turns cannot bypass pending cleanup. A late starter/RPC remains observed and quarantined until its known cleanup settles, so repeated calls cannot accumulate transports. Close fences adoption; it does not assert native process or descendant termination. Old turn/application-effect uncertainty and admission holds are not reclassified or refunded. Hosted grants continue to reject control until a guardian-owned transport is available.

The metadata projection follows the official App Server documentation retrieved on 2026-11-09 (`thread/read` without history and `thread/turns/list` with limit 1); this adds no claim of complete modern RPC or installed-provider conformance. The repository's 0.149.0 inbound schema pin is separate.
