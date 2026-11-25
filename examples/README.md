# Examples

Runnable programs, smallest first. Examples that talk to a model use the real
CLIs and consume turns from your subscription. Document triage runs local rules
by default and offers an explicit provider mode. See the [module map](../docs/modules.md) to choose an example by API.

## Desktop tutorial

Build a local Kanban board that runs agents through the published npm SDK. Follow a card from prioritization to a verified Markdown deliverable, including a reviewer rejecting an incorrect draft and a writer revising it. The app has its own install instructions and an opt-in live walkthrough. [Step-by-step tutorial in Spanish](../apps/kanban-desktop/README.md) · [Runnable examples by SDK capability](../apps/kanban-desktop/labs/README.md)

## Before you run anything

```bash
npm ci
npm run build          # examples import the package by name, so dist must exist
```

The offline triage demo works without a provider CLI. For examples that use a provider, install and authenticate that CLI, then check with:

```bash
node dist/cli.js doctor
```

That prints what is installed, how you are authenticated, and what the runtime
thinks it can do, without sending a prompt. Example 06 adds a Claude-specific readiness check.

## Running

Start with the offline workflow. Node 22 can strip the example’s TypeScript annotations:

```bash
state_dir=$(mktemp -d)
node --experimental-strip-types examples/08-document-triage.ts --state-dir "$state_dir"
```

The first example in the table uses Claude Code and Codex. The [main README](../README.md#usalo-en-tu-app) has a one-provider example. If your shell runs inside a Claude Code session, prefix with `env -u CLAUDECODE`
so the nested-session guard does not reject the child process.

## The examples

| File | What it shows | Model turns |
|---|---|---|
| [`01-quickstart.ts`](01-quickstart.ts) | One turn on Claude Code and one on Codex; the provider is inferred from the model | 2 |
| [`02-sessions.ts`](02-sessions.ts) | Multi-turn context, `export()`/`resume`, and a real native `fork` | ~4 |
| [`03-structured-output.ts`](03-structured-output.ts) | JSON Schema, validated output and a handler for schema errors | 1 |
| [`04-streaming.ts`](04-streaming.ts) | Live exec events with `Session.stream()`, abort and explicit session reconciliation | up to 3 |
| [`05-multi-agent-dialogue.ts`](05-multi-agent-dialogue.ts) | A Codex orchestrator moderating a debate with a Claude participant | ~5 |
| [`06-diagnostics.ts`](06-diagnostics.ts) | `doctor()`, the negotiated plan, and how a missing capability fails | **0** |
| [`07-context-and-permissions.ts`](07-context-and-permissions.ts) | What an agent inherits from your machine, and what enforcement you really get | **0** |
| [`08-document-triage.ts`](08-document-triage.ts) | Recoverable workflow, shared admission and retrieval in a technical-document app | **0** by default; up to **2** with explicit model mode |

## Document triage and restart

This example builds a technical-notes report, independently of Marketing Swarm.
The default callbacks are deterministic local operations. These three commands
stop after intake, complete the pending work, then reuse the completed result:

```bash
node --experimental-strip-types examples/08-document-triage.ts --state-dir /tmp/triage-demo --stop-after-intake
node --experimental-strip-types examples/08-document-triage.ts --state-dir /tmp/triage-demo
node --experimental-strip-types examples/08-document-triage.ts --state-dir /tmp/triage-demo
```

`executedSteps` reports only work performed by the current process. The last
command should report an empty list. `admittedLaunches` counts demo operations,
including offline callbacks; it is not a provider's token usage or quota.
Input is a JSON array of `{ "id": "...", "text": "..." }` accepted through
`--input /absolute/notes.json`; its digest changes the checkpoint identity.

To run the two analysis steps through a local authenticated provider, pass both
`--model <model-id>` and `--allow-provider-turns`. This requires subscription
authentication and consumes plan capacity. Completed steps are still reused.
The example uses a separate Agent per branch and makes no cross-provider session
or memory transfer. No live model mode is used by its automated verification.

Use `--budget-db /absolute/shared/admission.sqlite` to share the same admission
ledger with another cooperating application. The demo's explicit policy is two
concurrent operations, twelve launches per hour and twenty-four per day, with a
sixty-second cooldown after a typed quota error. Those are example application
limits, not provider plan limits. Conflicting policies on the same key are denied.

## The hive-mind swarm moved

The queen-and-swarm example outgrew a terminal script and now lives as a desktop
application, `apps/marketing-swarm/`, in the platform repository.

A swarm you cannot watch, steer or answer is a swarm you cannot trust: turns run
for minutes or for an hour, agents block waiting for a human decision, and two
memory layers accumulate history worth browsing. That wanted a console, not
`console.log`. The app keeps the same engine — hierarchical mesh copied from
[ruvnet/marketing](https://github.com/ruvnet/marketing), a quality gate holding a
veto the queen cannot override, semantic recall in AgentDB and structured
history in SQLite — with an operations UI around it.

## What these examples are not

`05-multi-agent-dialogue.ts` composes agents in ordinary application code.
Document triage uses the optional orchestration entry point; its explicit task
graph does not choose models or invent tasks. Both approaches keep composition
under the application's control.

They also make no claim that a turn is free. Every model turn draws on the
limits of the plan you are already paying for, and where a cost is printed it
is labeled with what the number actually means.

## In your own project

The examples import the package by name:

```ts
import { Agent } from 'hiveagents-runtime';
```

Inside this repository that resolves through the package's own `exports` field
to `dist/`, which is why `npm run build` is a prerequisite. In an application
that installed the package, the same line needs no build step.

## If an example prints `unknown`

The compatibility manifest matches tested versions and declared ranges. When your installed
CLI is newer than the versions with recorded live contracts, capabilities
degrade to `unknown` with a `HELP_PROBED_ONLY` warning rather than being
assumed — flags are still probed from `--help`, but nothing claims verified
behavior it has not seen. This is the intended failure mode, not a bug, and
`06-diagnostics.ts` shows it plainly.

## Adoptar desde otra app

`apps/document-triage` es el consumidor independiente de referencia: instala el SDK desde un único tarball que incluye los cuatro proveedores. `npm run verify:release`
lo copia fuera del repo y valida instalación, tipos, build y pruebas. Sus comandos
`tool-demo` y `triage-decision` muestran herramientas comunes y decisiones durables.
Marketing y grow reutilizan observación/recibos desde el entry opcional
`hiveagents-runtime/orchestration`, conservando sus políticas y estado de negocio.

Para evaluar resultados y continuar tareas entre procesos, ver los comandos
`evaluate`, `evaluation-compare`, `trace-inspect` y `handoff-*` de la app documental.
Usan exclusivamente los exports públicos de orquestación y no consumen modelos por defecto.
