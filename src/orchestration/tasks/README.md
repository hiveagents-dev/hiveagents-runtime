# Observed application tasks

`runObservedTask(starter, input, turnOptions, hooks)` accepts an Agent, Session,
or application-owned stream starter through the public
`hiveagents-runtime/orchestration` entry. It reports early session identity and
progress, returns the terminal turn, and preserves native provider errors.
`ObservedTaskError` identifies missing results, idle timeout and cancellation
that the observer itself detects. Application wrappers own user-facing wording.

The optional idle timeout restarts on every event and pauses during a human
interaction. It is independent of the provider's total `timeoutMs`. The handle
and parent signal request cooperative interruption. Detached execution is
rejected because a settled stream would no longer establish that work stopped.
The starter must settle only after its work and iterator cleanup have stopped;
this helper cannot force an arbitrary JavaScript callback to stop.

The optional budget port adapts an application's admission service, including
`SharedLaunchBudget`. Its reservation is released only after the stream,
iterator cleanup and tracked interaction callbacks settle. A provider that
ignores abort can keep this promise and reservation pending; releasing a launch
slot merely because a timeout fired would permit overlapping live work.

For SDK exec `Agent` or `Session` starters, pass `awaitSettlement: true` in the turn
options. This explicit mode drains readiness probes, authentication and executable
pin checks, actual execute promises, pending iterator `next()`, and iterator cleanup.
It propagates through the SDK exec wrappers. Cancellation and deadlines still abort
the derived signal at the requested time. Noncooperative work can keep the operation
and reservation pending indefinitely; the SDK cannot force-stop arbitrary JS.

Without the option, SDK turn cancellation and stream cleanup retain their existing
bounded response behavior. Merely awaiting that bounded public call does not prove
that a custom adapter has stopped working. Control turns reject `awaitSettlement:
true` before dispatch because their current lifecycle cannot provide this contract.
The option must be a boolean, and defaults to false. Application-owned starters
must implement the same lifetime contract themselves; a type alone cannot attest it.
