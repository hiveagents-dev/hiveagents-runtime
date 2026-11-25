# Local routing

The optional Node-only `hiveagents-runtime/routing` entry resolves a fixed model or a deterministic automatic priority policy to an ordinary existing Agent. It never sends a prompt or opens a native session. Supply a Runtime and a receipt store explicitly.

```ts
import { createAgent, WorkflowRoutingReceiptStore } from 'hiveagents-runtime/routing';
import { Runtime } from 'hiveagents-runtime';
import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';

const { agent, receipt } = await createAgent({
  model: {
    mode: 'auto',
    candidates: ['claude/sonnet', 'codex/gpt-5.4'],
    allowUnverifiedModels: true,
    fallback: 'codex/gpt-5.4',
  },
  permissions: { mode: 'analyze' },
}, {
  runtime: new Runtime(),
  receipts: new WorkflowRoutingReceiptStore(new FileWorkflowStore('/absolute/app-state')),
  timeoutMs: 30_000,
});
```

When candidates are omitted, automatic selection considers the model catalogs from all registered providers. A default Runtime includes Claude Code, Codex, Gemini CLI and Antigravity CLI. Register another CLI alongside them with `createDefaultProviders()` and your own `ProviderRegistration`. Legacy adapter dynamic discovery is never called. Canonical duplicate candidates and references outside the closed candidate universe reject before probes. Automatic mode defaults to exec transport; fixed strings preserve the Agent default. Availability, provider allowlists, full readiness and unsupported policies are hard filters. Unknown authentication and unverified models require separate explicit automatic opt-ins; explicit negative authentication and unavailable models are always excluded.

Without rules, candidate order determines primary priority. With rules, the first exact case-sensitive all-tags match determines primary priority; no matching rule leaves no primary candidates. Fallback is always removed from the primary list and tried last. Rules do not perform classification or provide quality, price or optimality guarantees. Task input is supplied only as an app-approved SHA256 digest plus bounded tags; tags are bound by taskDigest and not persisted as text.

Every persisted receipt has purpose `selection-proposal`, format 1 and nativeDispatches 0. It describes observed readiness and policy selection; it does not authorize execution, attest a returned Agent or prove a successful task/native dispatch. The receipt is persisted before factory return. If cancellation or deadline arrives during an immutable save, the save is allowed to settle and no Agent is returned; the stored proposal can still correctly say selected. Late raw store failures propagate even after cancellation. Probes and store operations retain actual lifetime until settlement; uncooperative operations can therefore exceed the nominal timeout. A caller needing a shared deadline or launch reservation must retain it around both selection and execution and pass remaining time, signal and `awaitSettlement: true` to exec execution. Control execution retains its existing restrictions.

`RoutingSelectionError` carries code NO_ROUTE, ABORTED or TIMEOUT and a validated receipt. Invalid requests reject before probes or persistence. Sink failures propagate directly and never trigger fallback. A retry requires a new opaque app-controlled, non-secret ID; selection IDs and rule IDs are retained. Receipts contain symbolic exclusion codes, canonical model IDs and digests, without paths, account information, environment values, callbacks or raw task/instruction text. configDigest binds normalized metadata including tool schemas but omits callback code; supply sourceDigest to bind app code provenance. A definition accepts `memory: false` to opt a routed Agent out of a Runtime memory default; when the Agent would have memory, configDigest also binds the memory provider id and the scope each candidate gets (never its functions), so evidence learned with and without memory is not pooled.

`validateRoutingReceipt` and `readRoutingReceipt` enforce strict JSON shape, semantic consistency and canonical SHA256 checksums. Returned receipts are deeply immutable. `WorkflowRoutingReceiptStore` uses a dedicated versioned `routing:<id>` WorkflowStore envelope, holds its exclusive lease for create-only insertion and rejects any existing ID, including identical content. Custom receipt stores must offer the same atomic create-only contract; load-then-save without shared exclusive ownership is insufficient. FileWorkflowStore retains its documented local filesystem modes (directory 0700/file 0600), cross-process ownership and explicit abandoned-owner recovery limitations. A lease is coordination, not release authority.

Bounds: 64 candidates, 64 rules, 32 task/rule tags, 128-character identifiers, 512-character canonical model IDs and 1MiB receipts. SHA256 inputs use lowercase 64-character hexadecimal strings. Metadata rejects accessors, proxies, unknown fields, nonplain objects, symbols, cycles, sparse arrays, undefined, nonfinite numbers and serialization hooks.
