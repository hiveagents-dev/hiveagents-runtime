# Guía de integración

Partí del [inicio rápido](../README.md). Esta guía reúne los contratos y los ejemplos que necesitás al pasar de un turno a una integración. Si querés ubicar cada pieza primero, consultá los [diagramas de arquitectura](architecture.md).

## Sesiones

`send()` crea una sesión implícita en el primer turn y reanuda el transcript **nativo** en los siguientes. El runtime no reconstruye contexto reenviando mensajes anteriores.

```ts
const agent = new Agent({ model: 'opus-5' });

await agent.send('Leé el repositorio');
await agent.send('Ahora profundizá en el módulo de auth');  // resume nativo
```

Para lifecycle explícito y portabilidad entre procesos:

```ts
const session = await agent.openSession();
console.log(session.ref);            // undefined: el CLI todavía no confirmó un ID nativo

await session.send('Analizá la arquitectura');

const ref = session.export();        // PersistedSessionRef, serializable
await session.close();
const resumed = await agent.openSession({ resume: ref });
try {
  await resumed.send('Continuá con el próximo paso.');
} finally {
  await resumed.close();
}
```

`SessionRef` liga provider, ID opaco, modelo cuando se conoce, cwd canonicalizado, transport, persistencia y versión de CLI. `resume` rechaza refs incompatibles con `SessionMismatchError`. Cambiar de modelo dentro del mismo provider está permitido y agrega el warning `SESSION_MODEL_CHANGED` al turn.

Una sesión permite **un solo turn activo**. Dos `send()` concurrentes producen `SessionBusyError`.

Un turn fallido no inutiliza el `Agent`: el siguiente `send()` continúa la sesión nativa cuando el proceso anterior terminó, sin reintentar el turn por su cuenta. Una `Session` explícita exige `await session.reconcile()` antes de seguir; si el proceso no terminó, el estado sigue `unknown` y conviene reemplazarla.

`run()` ejecuta un turn one-shot sin tocar la sesión implícita del `Agent`:

```ts
const veredicto = await agent.run('Clasificá este cambio');
```

## Streaming

```ts
for await (const event of agent.stream('Revisá los tests')) {
  if (event.type === 'message.delta') process.stdout.write(event.text);
}
```

El stream procesa JSONL por bytes y entrega eventos normalizados mientras el proceso sigue vivo, sin polling. Abandonar el iterador aborta el proceso del turn. Los tipos nativos que el runtime no conoce se preservan como `provider.event` en vez de descartarse.

`start()` es la variante eager: devuelve un `TurnHandle` sincrónicamente, con `events`, `result`, `interrupt()`, `detach()` y `respond()` separados. `detach` no es `interrupt`, e `interrupt` no es matar el proceso.

## Structured output

El schema se compila antes de lanzar el CLI y el resultado se valida otra vez contra el schema original después de la respuesta nativa.

```ts
const turn = await agent.run('Clasificá el riesgo', {
  outputSchema: {
    type: 'object',
    properties: { risk: { enum: ['low', 'medium', 'high'] } },
    required: ['risk'],
    additionalProperties: false,
  },
});

console.log(turn.output);
```

---

## Transports

| Transport | Qué es | Estado |
|---|---|---|
| **exec** | Un proceso de CLI por turn, JSONL por stdout, resume nativo entre turns. | Implementado y alcanzable. Pruebas vivas históricas en macOS para versiones específicas. |
| **control** | Proceso long-lived: un `Query` del Agent SDK para Claude, App Server por stdio con peer RPC bidireccional para Codex. Habilita aprobaciones, steering, tools in-process y sesiones sólo-en-proceso. | Incluido en el paquete; requiere **registro explícito** y opt-in experimental. |

Ambos control planes vienen en este paquete. No se activan solos: hay que registrarlos en código, porque no existe discovery dinámico por diseño.

```ts
import {
  Agent, Runtime,
  createClaudeControlRegistration,
  createCodexControlRegistration,
} from 'hiveagents-runtime';

const runtime = new Runtime({
  controlAdapters: [
    createClaudeControlRegistration(),
    createCodexControlRegistration(),
  ],
});

const agent = new Agent({
  model: 'gpt-5.6-sol',
  transport: 'control',
  providerOptions: { experimentalControl: true },
}, runtime);
```

Sin registro, pedir control falla con un error tipado que nombra el token del transport y qué falta. El registro y el gate son condiciones **separadas**: registrar un adapter no lo habilita, y habilitar el gate no lo registra.

El 2026-09-24 se verificaron handshakes sin modelo y dos turns mínimos por proveedor con Claude Code 2.1.228 + Agent SDK 0.3.252 y Codex 0.153.4. Los resultados y límites están en el [informe de estabilización](validation/providers.md#control). Esto no certifica todas las interacciones: los adapters conservan su evidencia declarada `sdk-capability` / `generated-schema`.

Claude Control rechaza `outputSchema` por turno. Codex Control admite `outputSchema` por turno con respaldo de esquema y fixtures. Claude aplica los perfiles de contexto y rechaza sus `providerOptions` de exec. Codex control admite contexto `native` y el directorio de trabajo; rechaza `project`/`clean`, directorios adicionales y config que pueda cambiar la autoridad. Los grants dinámicos de permisos de Codex no están implementados; sus aprobaciones no pueden ampliar el permiso inicial ni persistir reglas.

Las pruebas vivas sin turnos usan `OAR_LIVE=1`; para consumir turnos también se requiere `OAR_LIVE_TURNS=1`. Ambas condiciones aplican a exec y control.

Los gates experimentales son **dos, separados, y ninguno implica al otro**:

- `experimentalControl` — habilita la negociación del transport de control.
- `experimentalApi` — habilita las herramientas TypeScript de aplicación en ambos adaptadores de Control.

Ambos default a `false`. Un requirement declarado `required` que la negociación resuelve como `unknown` o `none` falla antes del turn: **evidencia desconocida no satisface una capacidad requerida.**

```ts
const agent = new Agent({
  model: 'opus-5',
  capabilities: { interactiveApprovals: 'required' },  // falla en exec, explícitamente
});
```

---

## Contexto, permisos y environment

El default es `{ profile: 'native', memory: 'inherit' }`: conserva la experiencia local completa — instrucciones, settings, memoria, skills, hooks, plugins y MCP que el harness decida cargar. Es el modo de mayor fidelidad, y también el menos reproducible y el que más contexto consume.

```ts
const agent = new Agent({
  model: 'opus-5',
  context: { profile: 'clean', memory: 'off' },
  permissions: { mode: 'analyze' },
});
```

Claude `clean` usa `--safe-mode`, no `--bare`, para preservar OAuth/Keychain. Codex exec **no** tiene evidencia suficiente de que sus flags de aislamiento excluyan también `AGENTS.md`, plugins, skills, hooks y MCP, así que `clean` estricto **falla** en Codex exec. El SDK no presenta aislamiento parcial como aislamiento completo.

Los intents de permisos son `analyze`, `respond`, `edit` y `unrestricted`. El capability report describe el enforcement efectivo y todo lo que el harness **no** puede cumplir; con `strict` (default) una política no aplicable falla antes de correr. El `PermissionIntent` se compila en un `SafetyEnvelope` inmutable con `authorityEpoch`, roots de filesystem canonicalizados, hosts de red, tools, ejecutables, servidores MCP y variables de environment permitidas.

Para agentes comerciales que deben entregar un resultado terminado, `respond` evita el modo de planificación de Claude Code. Solo admite Claude exec con contexto `clean`, instrucciones que reemplazan la personalidad de programación (`claude.systemPromptMode: 'replace'`) y una lista explícita `claude.tools: []` o `['WebSearch']`. Usa `dontAsk`, restringe MCP y autoriza únicamente la búsqueda pública cuando está elegida. Rechaza settings, servidores MCP, directorios adicionales o capacidades no comprobadas en el CLI, incluso con `strict: false`. Es una restricción del harness, no un sandbox del sistema operativo; para Codex sigue disponible `analyze` con su sandbox de solo lectura. Una instalación rota que falla `--version` no oculta otras instalaciones existentes en el PATH; una ruta elegida explícitamente nunca se sustituye.

`EnvironmentPolicy` es explícita:

- `inherit` — hereda el environment completo, **incluidas las credenciales presentes**;
- `minimal` — variables de bootstrap más un passthrough exacto;
- `explicit` — bootstrap mínimo más las variables declaradas.

No se usa una regex de nombres "sensibles" como falsa garantía de deny-by-default. Los probes y los turns reciben exactamente la misma política.

El perfil `native` asume un repositorio confiable: los agentes pueden acceder a filesystem, shell, red, hooks, plugins y MCP según la configuración local. **Para repositorios no confiables hace falta aislamiento externo** en un contenedor o VM; este SDK no es un sandbox.

---

## Orquestación opcional

El entry point principal sigue dedicado a ejecutar agentes. La entrada separada
`hiveagents-runtime/orchestration` permite componer aplicaciones con workflows
recuperables, admisión compartida por proveedor y ranking de memoria. Se activa
mediante imports explícitos y no agrega dependencias de runtime.

```ts
import { FileWorkflowStore, WorkflowRunner } from 'hiveagents-runtime/orchestration';

const runner = new WorkflowRunner(new FileWorkflowStore('/absolute/app/workflows'));
await runner.run({
  id: 'review', version: '1',
  steps: [
    { id: 'inspect', execute: async () => ({ finding: 'ready for review' }) },
    { id: 'review', dependencies: ['inspect'], execute: ({ dependencyOutputs }) => dependencyOutputs.inspect! },
  ],
}, { runId: 'review-001', concurrency: 2 });
```

Los callbacks pueden llamar a `Agent.run()`; los permisos y autenticación del
proveedor siguen siendo los del runtime. El ejemplo
[`08-document-triage.ts`](../examples/08-document-triage.ts) muestra los tres
componentes en otro dominio, funciona offline por defecto y conserva checkpoints
entre procesos. Ver [contratos, recuperación y límites](orchestration.md).

`HostLedger`, también opcional, comparte admisión entre procesos y sistemas con
concurrencia configurable (`limited` o `unlimited`), ventanas y cooldown
independientes, espera por eventos y recuperación de reservas inspeccionadas.
Las apps cooperantes comparten un archivo si necesitan el mismo límite. La migración del historial anterior es explícita y conserva los contadores. Ver [configuración y operación](../src/orchestration/budget/README.md).

## Límites del runtime

- **La ejecución y la composición son capas separadas.** El import principal no carga el módulo opcional de orquestación. La aplicación define tareas, dependencias y callbacks; el selector automático se activa separadamente desde `hiveagents-runtime/routing`.
- **No administra credenciales.** Usa la sesión que el usuario ya tiene en su CLI. No pide API keys, no las guarda, no las rota y no las inyecta.
- **No promete "gratis" ni "costo cero".** Usa la fuente de autenticación local activa y los límites o créditos aplicables del proveedor. `Usage.costMeaning` distingue `provider-reported`, `api-equivalent`, `estimate` y `unavailable`; un costo API-equivalent **no** se presenta como cargo marginal de una suscripción, y el SDK no inventa precios faltantes. La política de consumo de los proveedores es un blanco móvil y este SDK no promete su estabilidad.
- **Aislamiento.** Para ejecutar contenido no confiable, usá un contenedor o VM. Los perfiles de permisos expresan qué política puede aplicar el CLI.
- **No sincroniza memorias.** La memoria durable de Claude y la de Codex son stores distintos. El conocimiento compartido entre agentes debe vivir en un recurso de la aplicación: archivos, base de datos, vector store o MCP. `AgentOptions.memory` es opt-in y por agente: conecta un proveedor de la aplicación, que es dueña del store; el SDK no copia ni sincroniza nada entre proveedores.
- **No promete paridad entre providers.** Full-fidelity significa fidelidad declarada, no paridad falsa. Donde un transport no ofrece el canal necesario, la capacidad se reporta `none` o `partial` y la llamada falla con un error tipado en vez de simular el comportamiento.

---

## CLI

```bash
node dist/cli.js doctor
node dist/cli.js models
node dist/cli.js capabilities --model opus-5
node dist/cli.js run --model gpt-5.6-sol "analizá este repo"
```

---

## Herramientas y primitivas para apps

`AgentOptions.tools` recibe herramientas TypeScript con `name`, `description`,
`inputSchema`, `timeoutMs`, `maxOutputBytes`, `authorize(input, context)` y
`execute(input, context)`. El contexto lleva señal derivada, deadline y alcance
con proveedor, cwd, sesión, turno y epoch de autoridad. La app conserva la
responsabilidad de autorizar cada efecto. El runtime captura metadata y callbacks,
valida input y limita salida; una declaración no concede permisos.

Las herramientas requieren control registrado y `experimentalControl`. En ambos proveedores, las herramientas de aplicación
requieren además `experimentalApi`. Para Claude, instalar los peers opcionales
`@anthropic-ai/claude-agent-sdk` y `@modelcontextprotocol/sdk`; exec y los demás
proveedores funcionan sin ellos. Codex permite `outputSchema` por turno de control.
Claude no tiene ese contrato por turno en su Query persistente: la app puede
validar texto JSON sin declarar soporte nativo.

`Session.startFork(input, options)` entrega la sesión hija tras confirmar su ID
nativo y un handle vivo para eventos, respuesta a interacciones e interrupción.
`forkAndSend` y `forkAndStart` mantienen su comportamiento asentado. Un deadline
abarca readiness, autenticación, apertura y ejecución. Código de aplicación que
ignore abort puede seguir pendiente; no se libera su autoridad ni reserva como
si hubiera terminado.

El entry opcional `hiveagents-runtime/orchestration` añade `runObservedTask`,
`bindDecision`, `DecisionRunner` y `WorkflowDecisionStore`. Comparte observación,
presupuesto y recibos durables; la app aporta política, efectos, verificación y
almacenamiento. Los puertos de memoria en `/orchestration/memory` conservan scope,
provenance, identidad de embeddings y revocación sin imponer una base de datos.
`agentDbMcpServer`, `ruvectorMcpServer` y `claudeMcpConfig` arman la configuración
MCP de esas herramientas para `providerOptions.claude.mcpConfigs` (Claude exec); el
SDK no instala ni ejecuta esos paquetes. La forma recomendada es `executable`, un bin
instalado desde un lockfile; con `version` se lanza `npx -y paquete@x.y.z`, que sólo
fija el paquete de primer nivel y que un workspace no confiable puede sustituir (ver
[matriz](capability-matrix.md)). `SafetyEnvelope.mcpServers` lista los servidores
que el SDK entrega (configs de Claude exec, `mcp_servers` de Codex exec, el servidor
`oar_application` de Claude control con `tools`) y marca con `config:*` las capas de
configuración del CLI que pueden añadir más.

`hiveagents-runtime/memory-tools` ofrece la memoria como herramientas que el agente
llama: `memoryTools({ provider, scope })` devuelve `memory_search` (y `memory_propose`
con `propose: true`) para `AgentOptions.tools` en control, y `serveMemoryMcp` sirve las
mismas herramientas por MCP sobre stdio para Claude exec y Codex exec, desde un script
de la app que `memoryMcpRecipe` + `claudeMcpConfig` lanzan. El scope lo fija la app,
nunca un argumento del modelo; la búsqueda pasa por `provider.recall` con las mismas
reglas y presupuesto que el bloque recordado, y una propuesta es sólo un candidato
hasta que la app la promueve. Un proveedor sólo de persistencia (con `propose` y sin
`recall`) sirve `memory_propose` solo; `memoryProviderFromPorts` expone `propose` sólo
en ese caso o con `captureGate: 'store-promotes'`. El servidor MCP acota los batches y
la cola, deja de leer mientras la salida no drena, y su `log` nombra un error sólo por
su clase (ver [matriz](capability-matrix.md)).

`hiveagents-runtime/orchestration/dynamic` (Node, sin SQLite) ejecuta workflows dinámicos:
un script de la app o un plan JSON que un modelo puede escribir (`planWorkflow`), validado
como entrada no confiable (`validatePlan`) y ejecutado con `runWorkflowPlan` bajo límites de llamadas y concurrencia, con presupuesto de tokens según el uso reportado. Cada llamada es un turno real de `Agent`, registrado en un journal para reanudar sin
repetir las llamadas terminadas; un paso con `isolation: 'worktree'` exige `isolation` en
las opciones del run, por ejemplo `gitWorktreeIsolation` (ver [workflows dinámicos](orchestration.md#dynamic-workflows)).

La [app document-triage](../apps/document-triage/README.md) instala el SDK con
npm fuera del repositorio. Incluye `tool-demo` (mock por defecto, Claude/Codex
opt-in) y `triage-decision` con autoridad local del operador. La ruta de adopción
completa se verifica con `npm run verify:release`; sus resultados no publican el
paquete. Ver [checklist](release-checklist.md).

## Evaluaciones, trazas y handoff

El entry opcional `hiveagents-runtime/orchestration` añade `runEvaluation` y
`compareEvaluations`, episodios con `openTraceEpisode`/`WorkflowTraceStore`, y
`createTaskHandoff`/`WorkflowHandoffStore`/`runHandoff`. Las evaluaciones usan
verificadores de la app, perfiles y corpus versionados; las trazas guardan
metadata acotada y conservan el texto y payloads fuera del registro por defecto.
El handoff conserva contexto seleccionado y evidencia durable, y reutiliza
DecisionRunner para autorizar, ejecutar y verificar sin repetir efectos ambiguos.

La app documental muestra una evaluación local de 30 casos, comparación de dos
clasificadores, inspección de trazas y entrega entre procesos. Funciona sin modelos
por defecto; los ensayos con proveedores exigen modelo y presupuesto explícitos.
Los resultados de esa demo no representan una medición de calidad de modelos.
Ver [contratos y límites](harness.md) y [comandos de la app](../apps/document-triage/README.md).

El módulo opcional [`routing/learning`](../src/routing/learning/README.md) aprende
con resultados verificados por tarea. Permite modelo fijo o candidatos de varios
proveedores; acumula evidencia en SQLite y propone políticas por similitud,
calidad, latencia o costo conocido. Una política sólo se activa tras superar
evaluaciones protegidas con tareas nuevas; incluye recibos y rollback durable.
La app independiente demuestra el ciclo continuo con un presupuesto explícito.
Con [corpus propios y estudios reanudables](../apps/document-triage/README.md) se pueden anexar tareas nuevas conservando la historia, pausar por presupuesto y
retomar desde otro proceso sin repetir trabajo incierto. El mantenimiento espera
feedback independiente y conserva límites acumulados de turnos/evaluaciones.

## Proveedores incluidos y CLIs personalizados

`new Runtime()` registra Claude Code, Codex, Gemini CLI y Antigravity CLI. Una aplicación instala `hiveagents-runtime` e importa los mismos tipos para los cuatro. Cada CLI conserva su instalación, autenticación, catálogo y capacidades.

```ts
import { Agent, Runtime } from 'hiveagents-runtime';

const agent = new Agent({
  model: 'antigravity/gemini-3.8-flash-low',
  permissions: { mode: 'edit' },
}, new Runtime());
try {
  const turn = await agent.run('Resumí las notas de este proyecto.');
  console.log(turn.text);
} finally {
  await agent.close();
}
```

Para sumar otro CLI, implementá `ProviderRegistration` con un `ExecAdapter` para preparar y ejecutar turnos, resolver modelos y traducir las políticas. Registralo con `new Runtime({ providers: [...createDefaultProviders(), miProveedor] })`. `createDefaultProviders` se importa desde `hiveagents-runtime`. El módulo `hiveagents-runtime/adapter-kit` incluye discovery, ejecución de procesos supervisada y utilidades de decodificación. La lista `providers` también permite construir un runtime con un conjunto propio o ajustar rutas mediante las factories de cada CLI.

`npm run verify:first-delivery` crea `.artifacts/first-delivery/core.tgz`, lo instala en una app externa y comprueba los tipos públicos y las integraciones con procesos simulados. Consume cero turnos de modelos. `OAR_ARTIFACT_DIR` cambia la carpeta de evidencia y `OAR_CONSUMER_KEEP=1` conserva la app instalada.

La validación del 2026-11-08 aprobó el consumidor instalado y los contratos con fixtures. El acceso OAuth local de Gemini CLI 0.56.0 fue rechazado por Google con `UNSUPPORTED_CLIENT`. El perfil Vertex AI completó el envío y la reanudación en una validación posterior. Ver [evidencia y límites](validation/providers.md#gemini).

Gemini restringe las herramientas del modelo a lectura mediante un overlay administrativo temporal. Su contexto nativo conserva la configuración local confiable y sus efectos propios, incluidas las sesiones. Las políticas administrativas incompatibles y garantías de aislamiento que el CLI no puede demostrar se rechazan antes de enviar el prompt. La autenticación observada pasivamente se informa con estado `unknown`; OAuth de Google conserva esa fuente y la titularidad de una suscripción requiere evidencia específica. Ver [compatibilidad](compatibility.md) y [la app](../apps/document-triage/README.md).

Antigravity utiliza su propio protocolo y sesiones nativas mediante `--conversation <id>`. Su perfil inicial admite `edit` explícito con configuración `request-review`; conserva los grants y configuración nativos y no garantiza solo lectura, sandbox del sistema ni denegación de red. `analyze` y requerimientos de enforcement más fuertes se rechazan. Usá `Agent.capabilities()` o `Agent.ready()` con `edit` para comprobar Antigravity. Los comandos `capabilities` y `run` del SDK usan `analyze` por defecto. Los conteos acumulativos de una conversación reanudada se conservan en eventos nativos y no se presentan como tokens nuevos del turno. Ver [compatibilidad](compatibility.md).

El procedimiento opt-in para comprobar envío y recuperación reales usa `scripts/verify-antigravity-live.mjs` con `OAR_LIVE=1`, `OAR_LIVE_TURNS=1`, `OAR_ANTIGRAVITY_MODEL=antigravity/gemini-3.8-flash-low` y `OAR_ANTIGRAVITY_EXTERNAL_APP` apuntando a la app instalada. El supervisor acota cada lanzamiento a 60 segundos y 1 MiB y mantiene un contador durable de hasta cuatro lanzamientos. La segunda invocación recupera un token que solo recibió el primer proceso.

## Selector local de modelo

Pasá `model: { mode: 'auto' }` sin enumerar candidatos para usar el catálogo registrado. El preflight elige el primer candidato que satisface la política. El laboratorio muestra el recibo y enlaza el ciclo que selecciona con evidencia de calidad. [Selección automática sin indicar un modelo](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/labs/auto-model.md)

`hiveagents-runtime/routing` permite declarar un modelo fijo o elegir uno de los
proveedores registrados mediante prioridades y reglas de tags. No llama a JEV,
servicios de ruteo, embeddings ni otro modelo para decidir.

```ts
import { Runtime } from 'hiveagents-runtime';
import { createAgent, WorkflowRoutingReceiptStore } from 'hiveagents-runtime/routing';
import { FileWorkflowStore } from 'hiveagents-runtime/orchestration';

const runtime = new Runtime();
const { agent, receipt } = await createAgent({
  // También puede ser model: 'codex/gpt-5.6-sol'.
  model: {
    mode: 'auto',
    allowUnverifiedModels: true,
  },
  permissions: { mode: 'analyze' },
}, {
  runtime,
  receipts: new WorkflowRoutingReceiptStore(new FileWorkflowStore('./routing-state')),
  timeoutMs: 30000,
});
console.log(receipt.selected?.model);
try {
  const turn = await agent.run('Clasificá estas notas.');
  console.log(turn.text);
} finally {
  await agent.close();
}
```

Si omitís `candidates`, el selector toma los modelos de los catálogos de los proveedores registrados. Selecciona el primero que cumple los filtros según el orden del catálogo o la regla de la tarea. Pasá `candidates`, reglas por tags o un fallback para definir tus propias prioridades. El selector filtra disponibilidad, CLI, autenticación, permisos y capacidades antes de devolver el `Agent`. En este ejemplo Antigravity queda excluido por el requisito `analyze`. Los catálogos estáticos son
`unverified`: aceptar esos modelos en automático requiere el opt-in mostrado;
esto no verifica su disponibilidad en una cuenta. La autenticación desconocida se
excluye en automático salvo opt-in explícito. El fallback debe pertenecer al conjunto
de candidatos y respetar los mismos filtros. No reintenta una ejecución fallida con
otro proveedor ni migra sesiones.

Cada intento válido guarda un recibo inmutable de **propuesta de selección**, con
digests y motivos acotados, sin prompts, credenciales ni texto de tarea. Ese recibo no
autoriza ejecución ni acredita que la factory devolvió un agente. Un ID ya usado se
rechaza. Si vence el plazo durante el guardado, se espera su terminación y no se
devuelve un agente; puede quedar la propuesta calculada antes del vencimiento.
Los callbacks de herramientas sólo quedan ligados a una versión de código si la
app aporta `sourceDigest`. Ver [contrato del módulo](../src/routing/README.md) y
[demo independiente](../apps/document-triage/README.md).

`Agent.ready({ signal, timeoutMs, awaitSettlement: true })` comprueba preparación sin
abrir conversaciones ni enviar prompts. La variante sin argumentos conserva su
caché; la variante con opciones prepara de nuevo de forma independiente. El selector
espera que terminen los probes reales al cancelar: un adaptador que ignore la señal
puede retrasar su devolución. La app conserva un único plazo para selección y envío.


## Verificación para contribuidores

Desde un checkout, construí primero los entry points públicos que importan los ejemplos y los tests.

```bash
npm ci
npm run build
npm run typecheck
npm test -- --maxWorkers=2
npm run verify:first-delivery
```

La última comprobación instala el tarball del SDK en una app temporal y usa CLIs simulados. El comando separado `npm run test:live` habilita pruebas contra los CLIs instalados. Las pruebas que envían un prompt requieren además `OAR_LIVE_TURNS=1` y consumen capacidad de la cuenta. Registrá versiones y modo de autenticación antes de usar un resultado como evidencia. [Distribución y reproducción](release-checklist.md)
