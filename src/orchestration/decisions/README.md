# Durable application decisions

Import `bindDecision`, `DecisionRunner`, and `WorkflowDecisionStore` from
`hiveagents-runtime/orchestration`. These optional helpers do not run inside the
core SDK and do not choose application policy.

`bindDecision` snapshots JSON inputs and hashes the application's authority
identity. The application supplies explicit input and authority versions. Raw
authority data stays out of the persisted binding. `DecisionStore` owns storage
and exclusive leases; `WorkflowDecisionStore` adapts an existing `WorkflowStore`
without changing workflow checkpoints or adding another filesystem lock system.

A call to `DecisionRunner.run` checks a condition, obtains fresh authorization,
persists an intent, and then dispatches one effect. The trusted synchronous
`isCurrent` port checks the current input and authority immediately after the
intent save. If execution awaits more work before an external effect, the
application must check authority again at that effect boundary. Approval from a
model response is not authority. Protect operator policy storage from model
tools and do not include credentials in binding inputs or receipt evidence.

An approval has an expiry. Waiting does not consume an attempt. A condition can
be checked by calling `run` again after a restart; there is no polling timer.
Unchanged condition waits do not rewrite storage. Pending approvals are never
reused as permission for a new dispatch. Changed input or authority versions
block the record for owner reconciliation.

The result is persisted separately from verification. Only a verified result
with evidence gets a receipt binding the approval, input, authority, result hash
and verification time. A recovered dispatched result may be verified without
executing it again. A recovered intent or uncertain effect requires owner
reconciliation and is never replayed automatically. Replacement work must use a
new identity after the owner has inspected and reconciled the old effect.

Leases remain held while callbacks are active, including after cooperative
cancellation. Stores must serialize or reject competing owners and must not
reassign a live lease based on age alone. These ports do not provide distributed
fencing or an external service's idempotency guarantee.
