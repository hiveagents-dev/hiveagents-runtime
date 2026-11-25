# Matriz de capacidades — auditoría

**Base histórica 2026-09-24:** handshakes y dos turns mínimos de control verificados con Claude Code 2.1.228 + SDK 0.3.252 y Codex 0.153.4. Ver [evidencia y límites actuales](validation/providers.md#control). Las cifras de bundle y suite de la auditoría original que siguen son históricas.

**Las secciones de auditoría de septiembre conservan cifras históricas.** Para elegir un módulo y distinguir las comprobaciones de la beta de las históricas, empezá por [Módulos y evidencia](modules.md).

**Fecha de la auditoría original:** 2026-09-01, 08:25 (revisión 2, tras el wiring de control y el split de fork)
**Suite:** 297 passed / 16 skipped, 40 archivos · typecheck limpio · build limpio · `npm audit` sin vulnerabilidades
**CLIs de referencia:** Claude Code 2.1.228–2.1.251 · Codex CLI 0.149.0 · Claude Agent SDK 0.3.252 · Node 22.23.2 (macOS/Darwin)

Esta tabla reemplaza las afirmaciones vagas de `docs/compatibility.md` y del Apéndice B del design spec. Cada celda declara **dos cosas separadas**: qué nivel de soporte declara el adapter, y **de qué clase es la evidencia** que respalda ese nivel. Un `full` con evidencia `fake` no es lo mismo que un `full` con evidencia `live`, y este documento no los mezcla.

---

## Alcance: qué ship y qué es alcanzable

El paquete core **sí incluye ambos control planes**. Verificado contra los artefactos construidos, no contra el código fuente: `dist/index.js.map` lista **53 fuentes**, entre ellas los 5 módulos de `adapters/claude-control/**`, los 16 de `adapters/codex-control/**` (incluidos los tres JSON de schemas pinneados), `control/{interaction-broker,bounded-queue,bounded-lanes}.ts` y `security/safety-envelope.ts`. `dist/index.js` pesa 301.9 KB.

Los nombres `@open-agent-runtime/claude-control` y `@open-agent-runtime/codex-control` siguen existiendo en `CONTROL_TRANSPORTS`, pero hoy son **etiquetas de diagnóstico**: metadatos históricos de compatibilidad; los diagnósticos actuales indican las fábricas importables desde el core. Los adapters viven en este paquete.

Tres condiciones separadas gobiernan si el control es utilizable, y conviene no confundirlas:

1. **Ship** — sí, está en el bundle.
2. **Registrado** — **no por default**. `Runtime` acepta `controlAdapters?: ControlAdapterRegistration[]` y los registra explícitamente; no hay discovery dinámico (plan Tarea 8). La aplicación debe construir su `Runtime` con `createClaudeControlRegistration()` / `createCodexControlRegistration()`.
3. **Habilitado** — requiere además el gate `experimentalControl`, y las herramientas TypeScript de aplicación requieren `experimentalApi` por separado. Ninguno implica al otro.

Sin registro explícito, pedir control falla con un error tipado que nombra el token y el paquete.

### Bundleado no es exportado

Distinción que importa para el compromiso de compatibilidad: un módulo puede estar en el bundle sin que sus símbolos sean importables. El bloque `export` de `dist/index.d.ts` tiene 177 entradas (78 valores de runtime), y deja fuera a propósito las clases internas del control plane: `ClaudeControlSession`, `CodexControlProjector`, `CodexThreadControl`, `CodexRpcPeer`, `CodexAppServerSupervisor`, `CodexInteractionBridge`, `BoundedQueue`, `PinnedExecAdapter`.

Lo que sí se exporta del control plane es la superficie de registración y contrato: `createClaudeControlRegistration`, `createCodexControlRegistration`, ambas constantes `*_CAPABILITY_VERDICTS`, `InteractionBroker`, `toBrokerResponse`, el tipo `SafetyEnvelope` con sus helpers de enforcement, `AdapterRegistry`, `CONTROL_TRANSPORTS`, `experimentalGates` y `assertExperimentalApiEnabled`.

`TurnJournal` (Tarea 2) y `control/bounded-writer.ts` se eliminaron el 2026-11-14: nunca se bundlearon ni exportaron y no tenían usos fuera de sus propios tests.

---

## Leyenda

**Nivel de soporte** (`SupportLevel`, spec §2.1) — `full` · `partial` · `none` · `unknown`. `unknown` nunca satisface un requirement `required`.

**Clase de evidencia** — es también lo que cada adapter declara en su `evidenceSource`:

| Clase | Significado | Quién la declara |
|---|---|---|
| `live` | Ejecutado contra el CLI real en macOS. En `docs/validation/` o reproducible con `OAR_LIVE=1`. | exec, vía compatibility manifest con `evidence: 'live-contract'` |
| `sdk` | Derivado de los tipos y el comportamiento publicados del Agent SDK, ejercitado con un SDK inyectado. | Claude control declara `evidenceSource: 'sdk-capability'` |
| `schema` | Derivado de los JSON schemas de Codex 0.149.0 pinneados, con provenance y sha256. | Codex control declara `evidenceSource: 'generated-schema'` |
| `fake` | Contract test determinista contra fakes/fixtures del repo. Ningún proceso del provider corrió. | — |
| `none` | Sin evidencia ejecutable. |  — |

**Ninguno de los dos control planes declara globalmente `live-handshake`.** Ya hay pruebas vivas acotadas, registradas en el informe del 2026-09-24; no se promueven automáticamente todas las capacidades de otras versiones a evidencia viva.

---

## Matriz

| Capacidad | Claude exec | Codex exec | Claude control | Codex control |
|---|---|---|---|---|
| Turn agentic con tools | `full` · live | `full` · live | `full` · sdk | `full` · schema |
| Resume persistido | `full` · live | `full` · live | `full` · sdk | `full` · schema |
| **Fork con prompt** | `full` · live | `full` · live | `partial` · sdk (sólo persisted) | `full` · schema |
| **Fork sin prompt** | `none` · live | `none` · live | `none` · sdk | `full` · schema |
| Sesión multi-turno sólo en proceso | `none` · live | `none` · live | `full` · sdk | `full` · schema |
| Interrupt semántico | `partial` · live | `partial` · live | `full` · sdk | `full` · schema |
| Steering del turn activo | `none` · live | `none` · live | `none` · sdk | `full` · schema |
| Aprobaciones bidireccionales | `none` · live | `none` · live | `full` · sdk | `partial` · schema/fake; sólo `decline` de escalados bajo unrestricted |
| Preguntas al usuario durante el turn | `none` · live | `none` · live | **`none`** · sdk | `full` · schema |
| Tools TypeScript in-process | `none` | `none` | `partial` · sdk/fake (MCP público) | `partial` · schema/fake (experimental) |
| Deltas de mensaje | `full` · live | `none` · live | `full` · sdk | `full` · schema |
| Cambio dinámico de permisos/modelo | `none` · live | `none` · live | `partial` · sdk | `none` · grants rechazados |
| Inspección de sesión sin resume | `none` · live | `none` · live | **`none`** · sdk | `partial` · schema |
| Checkpoint / rollback | `none` · live | `none` · live | **`none`** · sdk | `none` · schema |
| Lifecycle de subagentes | `unknown` · none | `unknown` · none | **`unknown`** · sdk | `unknown` · schema |
| Mensajes completos de subagentes | `unknown` · none | `unknown` · none | **`unknown`** · sdk | `unknown` · schema |
| Deltas de subagentes | `none` · none | `none` · none | `none` · sdk | `none` · schema |
| Detección de refusal | `none` · fake (ningún fixture trae señal) | `none` · fake (ningún fixture trae señal) | `none` · sdk | `none` · schema |
| Structured output | `full` · live histórico | `full` · live histórico | `none` · rechazo explícito por turno | `full` · schema/fake, `turn/start.outputSchema` |
| Catálogo de modelos | `full` · live | `full` · live | `unknown` · none | `full` · schema (advertised) |

Las celdas en **negrita** contradicen el design spec; ver discrepancias.

**Refusal.** `Turn.status: 'refused'` sólo se emite ante una señal nativa de negativa. Ningún fixture capturado (`tests/fixtures/claude/*.jsonl`, `tests/fixtures/codex/*.jsonl`) ni los schemas pinneados de Codex contienen una, y el Agent SDK no está instalado para consultar sus tipos. Por eso todos los adapters devuelven `refused: false`, los exec declaran `refusalDetection: 'unsupported'` en su compatibility y los control `none`; Gemini y Antigravity declaran `unsupported`. Lo fija `tests/contract/refusal-detection.test.ts`.

**Aprobaciones de Codex control.** El hilo pide aprobación `on-request`, pero aceptar un comando o un cambio de archivo lo saca del sandbox. Bajo un techo distinto de `bypassPermissions` sólo se puede declinar: si la aplicación acepta, el proveedor recibe la decisión de rechazo del método (`decline`, de la unión pinneada `CommandExecutionApprovalDecision`; `denied` en los métodos v1) y `respond()` rechaza con `UNSUPPORTED_CAPABILITY` (`sanitizedDiagnostics.wireDecision`). Los grants de `item/permissions/requestApproval` siguen fallando con error JSON-RPC: su respuesta no está pinneada. El `EnforcementReport` lo declara: `approvals: 'interactive; decline-only for command and file-change escalations below unrestricted'`; Claude control sigue en `interactive`.

---

## Origen de cada columna

### Claude exec / Codex exec

Niveles del compatibility manifest (`src/compatibility/manifest.ts`), clase `live` del contract vivo histórico en `docs/validation/`, reproducible con `OAR_LIVE=1 OAR_LIVE_TURNS=1 npm run test:live` (skipped por default). Los turnos exec no se repitieron en la estabilización del 2026-09-24.

**El fork ya no es una sola capability.** El manifest declara `forkWithPrompt: 'supported'` y `forkWithoutPrompt: 'unsupported'` para las tres entradas de CLI, y `CapabilityRequirements` expone ambas por separado. Eso corrige la conflación anterior, en la que un único verdict `fork: 'partial'` bloqueaba también el fork con prompt, que ambos CLIs sí soportan. `Session.forkAndSend()` y `Session.forkAndStart()` ahora exigen sólo `forkWithPrompt` y funcionan en exec; el fork sin prompt sigue rechazado, que es lo correcto.

`interrupt` sigue siendo `partial`, no `none`: exec mata el process group con escalación TERM→KILL verificada en Darwin, pero matar un proceso no es un interrupt semántico.

### Claude control

Niveles literales de `CLAUDE_CONTROL_CAPABILITY_VERDICTS` (`src/adapters/claude-control/session.ts:37-51`), registrados con `evidenceSource: 'sdk-capability'`:

```
interactiveApprovals: full     userInputDuringTurn: none    steering: none
inProcessTools: partial        processPersistence: full     messageDeltas: full
dynamicPermissions: partial    sessionInspection: none      checkpointOrRollback: none
subagentLifecycle: unknown     subagentMessages: unknown    subagentDeltas: none
refusalDetection: none
```

Implementado y probado con el SDK inyectado: un `Query` long-lived por sesión, `canUseTool` como dispatcher de aprobaciones, `interrupt()`, `setModel`, `setPermissionMode` con jerarquía de autoridad (un cambio a rango mayor amplía el envelope y exige sesión nueva), `persistSession:false`, y diff de usage por turn.

`AskUserQuestion` sigue fuera del contrato portable. Las herramientas MCP in-process de aplicación se implementaron el 2026-11-08 con schema exacto, autorización y cancelación; su verdict es `partial`.

### Codex control

Ya existe una tabla declarada: `CODEX_CONTROL_CAPABILITY_VERDICTS` (`src/adapters/codex-control/factory.ts:44-63`), registrada con `evidenceSource: 'generated-schema'` y `protocolVersion: 'codex-app-server-0.149.0'`. La revisión anterior de este documento derivaba estas celdas leyendo los módulos porque la tabla no existía; ahora la fuente es el adapter.

Notable: es el único transport donde **ambas** formas de fork son `full` — `thread/fork` devuelve un id de hijo confirmado sin prompt, cosa que ningún exec CLI hace.

La clase `schema` cubre sólo las **server requests inbound**: el envelope JSON-RPC y las uniones `ServerRequest` stable/experimental, pinneadas con sha256 en `PROVENANCE.json`. Ese archivo es explícito en que **las notifications no se validan a propósito** — una notification desconocida o drifteada debe pasar preservada como `provider.event`, nunca descartarse ni fallar cerrado. Los client requests son outbound y están tipados en el call site.

Módulos y cobertura: `thread-control` (start/resume/fork/read), `turn-control` (start/steer/interrupt), `interactions` (approvals de comando/archivo/red/permiso, user input, elicitation, dynamic tool), `dynamic-tools` (gate `experimentalApi`, hash de registry para rebind), `projector` (deltas, `completed` autoritativo), `supervisor` (lifecycle macOS, shutdown ordenado, identidad de proceso verificada), `schemas`, `rpc-peer`, `jsonl-channel`, `connection`.

---

## Discrepancias con el design spec (Apéndice B)

Cuatro afirmaciones del spec y del plan §4 que el código contradice. Las cuatro están en **Claude control**, y en todas el código es el conservador:

| Afirmación del spec/plan | Verdict implementado | Dónde |
|---|---|---|
| "Preguntas al usuario durante turn: **Sí**" · plan §4 "Approvals/user input: full" | `userInputDuringTurn: 'none'` | `session.ts:39` |
| Herramientas MCP de aplicación | `inProcessTools: 'partial'`, implementado en noviembre | MCP público + autorización de aplicación |
| "Inspección de historial sin resume: **Sí**" | `sessionInspection: 'none'` | `session.ts:45` |
| "Rewind de archivos/checkpoints: **Sí**" | `checkpointOrRollback: 'none'` | `session.ts:46` |

Las aprobaciones en sí **sí** están respaldadas: `canUseTool` está genuinamente wired, así que `interactiveApprovals: 'full'` es honesto. Lo inventado es la mitad de user-input de ese bullet.

Y una más, en la matriz §4 del plan: "Subagent lifecycle/messages: full/partial por dimensión". El código dice `unknown` en ambas dimensiones para los dos control planes, y `unknown` no satisface un requirement `required` por diseño (§2.1).

---

## Cómo reproducir

```bash
npm run typecheck && npm test && npm run build
npm audit --audit-level=high
npm pack --dry-run

# Qué fuentes entran realmente al bundle
python3 -c "import json;s=json.load(open('dist/index.js.map'))['sources'];print(len(s));print('\n'.join(sorted(s)))"

# Qué símbolos son realmente importables
python3 -c "import re;d=open('dist/index.d.ts').read();m=re.search(r'\nexport \{(.*?)\};\s*\$',d,re.S);print(len(m.group(1).split(',')))"
```

Las clases `live` valen **sólo** para el host, versiones de CLI, fuente de auth y fecha declarados. Un cambio de versión de CLI invalida la columna hasta que se vuelva a correr `OAR_LIVE=1 npm run test:live`.

> Claude 2.1.228 y 2.1.251 tienen evidencia histórica separada; no se exige que dos binarios distintos compartan una única entrada.


## Gemini CLI como proveedor externo

El adaptador Gemini incluido en `hiveagents-runtime` implementa exec con texto, deltas de mensaje, ID UUID de sesión nativa y resume por ID exacto para 0.56.0. Esos recorridos están verificados con procesos falsos, así que `turns`, `resume`, `messageDeltas`, `tokenDeltas` y `permissions` se declaran `unverified` (nunca `supported`): la preparación y el envío siguen permitidos, pero un requirement `required` no se satisface con evidencia desconocida. `refusalDetection` es `unsupported`. El probe de `--help` exige exactamente los flags que el adaptador pasa; `--approval-mode` no se exige porque nunca se pasa y la política administrativa de analyze deniega en todos los modos de aprobación; tres contratos del motor instalado verifican la precedencia de lectura sin consumir modelos. El 2026-11-08 Google rechazó el acceso OAuth local con `UNSUPPORTED_CLIENT`: cuatro lanzamientos y cero comprobaciones vivas confirmadas. Con Vertex AI, una validación posterior del 2026-11-23 confirmó envío y reanudación entre procesos con 0.56.0 y `gemini-3.7-flash`. El canario quedó ausente y la corrida no observó una llamada de escritura. [Evidencia histórica de OAuth](validation/providers.md#gemini) · [Evidencia con Vertex](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/evidence/gemini-live.json).

Control, fork, herramientas TypeScript en proceso, schema nativo, instrucciones privilegiadas y perfiles de contexto distintos de native/inherit producen capacidades ausentes o errores tipados antes del envío. La restricción analyze corresponde a herramientas del modelo. El sandbox del sistema y la denegación de red tienen contratos independientes y se reportan como incompatibles cuando faltan garantías.


## Antigravity CLI como proveedor externo

`hiveagents-runtime` registra `antigravity` mediante APIs públicas. La versión objetivo inicial es 1.5.3 (macOS). Los fixtures cubren texto, deltas, terminal coherente, resume por UUID, límites de salida y cancelación. Los fixtures conservan el contrato de 1.5.3. Para 1.5.15, la beta.4 verificó dos turnos reales con deltas y reanudación en otro proceso. [Laboratorio](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/labs/antigravity-live.md) · [Evidencia](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/evidence/antigravity-live.json)

| Capacidad | Contrato inicial |
|---|---|
| Texto y deltas | Exec NDJSON `event/init`, `step_update`, `result` |
| Resume | `--conversation` con UUID exacto, sin selectores implícitos |
| Permisos | Partial: `edit` explícito, configuración nativa `request-review`; grants nativos conservados |
| Analyze, red denegada, mínimo de enforcement | Rechazados antes del prompt |
| Contexto | Solo native/inherit; startup/MCP/config confiables conservados |
| Usage | Conteos solo si son del primer turno nuevo; acumulativos de resume conservados como datos nativos |
| Fork, control, schema, esfuerzo, instrucciones privilegiadas, imágenes/archivos | Sin implementación en este adaptador |
| Detección de refusal | `unsupported`: el evento `result` no trae señal de negativa |

Los flags de ayuda solo demuestran sintaxis; el supervisor de envío/resume vincula cada prueba viva a CLI, modelo y artefactos concretos. El soporte de un modelo Gemini dentro de Antigravity pertenece a `antigravity`, con su propio protocolo y autenticación.

## Extensiones del 2026-11-08

- El deadline compuesto cancela probes, apertura, herramientas y turnos mediante señales derivadas. Timeout no demuestra que un callback arbitrario haya terminado: trabajo pendiente impide reutilización segura o mantiene su reserva.
- `startFork` expone progreso e interacciones vivos tras confirmar el hijo. Execute-only ofrece un resultado asentado y observabilidad limitada. La cola del observador tiene límite independiente; desbordarla no invalida el resultado del proveedor.
- Claude y Codex comparten `ApplicationTool`; cada llamada valida input, consulta el authorizer y ejecuta dentro del menor deadline disponible, con salida JSON acotada. El callback es código confiable de la app y puede realizar IO incluso bajo un perfil del modelo analyze. El perfil del modelo no reemplaza su autorización.
- Los módulos opcionales de tareas observadas, decisiones durables y puertos de memoria se importan desde `/orchestration`. No añaden una política de negocio ni un store global. Los puertos de memoria definen contratos; no instalan una base vectorial.
- El estado de pruebas y contratos vivos de esta extensión pertenece al [informe de cierre](release-checklist.md), no a las cifras de septiembre.

En los bindings actuales, las herramientas comunes requieren `experimentalControl`
y `experimentalApi` explícitos para ambos proveedores. La prueba viva de noviembre
acredita una lectura/escritura autorizada para Claude2.1.228+SDK0.3.252 y
Codex0.153.4; en Codex también acredita schema nativo por turno. Es evidencia de
esos recorridos y artefactos concretos, sin cambiar la clase global de todas las
capacidades. Claude fork con prompt se declara `full` en su registro para sesiones
persistidas; fork de una sesión sólo en proceso sigue rechazado por la fábrica.

## Memoria por agente

`AgentOptions.memory` es opt-in; sin él nada cambia. El store pertenece a la aplicación y el SDK no sincroniza nada entre proveedores ni entre las memorias nativas de Claude y Codex. El proveedor necesita `recall`, `capture` o `profile`: uno con sólo `propose` es un `TypeError` al construir el Agent, porque `propose` sirve únicamente a las herramientas de memoria y no hace nada en un turn; cada método presente, `propose` incluido, debe ser una función. El `id` del proveedor es la fuente del encabezado `### Profile [source: <id>]`, así que sigue la regla de los ids y fuentes de ítem: sin corchetes ni otra puntuación de apertura o cierre tras NFKC (`TypeError` si no).

| Aspecto | Claude exec | Codex exec | Claude control | Codex control |
|---|---|---|---|---|
| Recall | Bloque de datos de referencia antepuesto al prompt | Igual | Igual | Igual |
| Captura | Lado host, tras el turn, sólo con `capture: true` | Igual | Igual | Igual |
| Herramientas MCP de memoria | Vía `providerOptions.claude.mcpConfigs` (`claudeMcpConfig`) | Vía `providerOptions.codex.config` con claves `mcp_servers.<nombre>`; sin helper (el formato de la entrada no está verificado en el repo) | No cableado (rechaza provider options) | No cableado (rechaza `mcp_servers`) |
| Herramientas de memoria del SDK (`hiveagents-runtime/memory-tools`) | `serveMemoryMcp` en un script de la app + `memoryMcpRecipe` + `claudeMcpConfig` en `providerOptions.claude.mcpConfigs` | `serveMemoryMcp` en un script de la app, declarado como `mcp_servers.<nombre>` en `providerOptions.codex.config` (mismo `command`/`args`/`env` de `memoryMcpRecipe`; sin helper) | `memoryTools` en `AgentOptions.tools`, con `experimentalControl` y `experimentalApi` | `memoryTools` en `AgentOptions.tools` (dynamic tools), con `experimentalControl` y `experimentalApi` |
| `SafetyEnvelope.mcpServers` | Nombres de los configs inline; `config:<ruta absoluta>` por archivo, sin leerlo; `config:claude-settings` salvo `strictMcpConfig: true`, `respond` o perfil `clean` | Nombres de `mcp_servers` y de las claves `mcp_servers.<nombre>…`; `config:codex-user` salvo `ignoreUserConfig: true` o perfiles `project`/`clean` (cubre `$CODEX_HOME/config.toml` y el `.codex/config.toml` del proyecto cuando el usuario lo marcó como confiable) | `oar_application` si el agente tiene `tools`; lo que el Agent SDK cargue de settings no se refleja | `config:codex-user` (siempre carga `config.toml`); las `tools` son dynamic tools, no MCP, y sólo figuran en `tools` |

El recall está disponible donde haya prompt, y un fallo o timeout del proveedor no hace fallar el turn: queda en `Turn.providerMetadata.memory`. Las recetas MCP (`agentDbMcpServer`, `ruvectorMcpServer`, `claudeMcpConfig`) fijan un perfil explícito; el SDK no instala ni ejecuta esos paquetes.

- **Herramientas de memoria (`hiveagents-runtime/memory-tools`):** `memory_search` (`{ query, limit? }`) llama a `provider.recall` con el scope fijo de la app; ningún argumento del modelo puede nombrarlo ni ampliarlo (el schema sólo admite `query` y `limit`, y `authorize` rechaza cualquier otro campo). Aplica las mismas reglas de ítem que el bloque recordado (`recallableMemory`), los mismos defaults y techos (`maxItems` 2/8, `maxBytes` 8/32 KiB, medido sobre el JSON de cada ítem) y devuelve `{ notice, items, omitted }`, donde `notice` declara que los ítems son datos de referencia, no instrucciones. `memory_propose` (`{ text, title? }`) existe sólo con `propose: true` y un proveedor con `propose` (si no, `TypeError` al construir); entrega un candidato con `origin: 'memory-tool'` (o `mcp:<nombre>` por MCP), que no se recupera hasta que la app lo promueve, con un límite de 10 propuestas por minuto por conjunto de herramientas (`proposalsPerMinute`). La plaza se reserva al admitir la propuesta (dos propuestas concurrentes no superan el límite; una llamada ya cancelada no se admite) y sólo se devuelve si el proveedor rechaza la propuesta. Un `TypeError` de `provider.propose` es un rechazo de la propuesta tal como está escrita (por ejemplo, `memoryProviderFromPorts` con un texto que no cabe en los 6 KiB del episodio) y llega al modelo como `INVALID_INPUT` con un mensaje fijo del SDK; cualquier otro error es `PROVIDER_FAILED`. Un `PROVIDER_FAILED`, una respuesta sin id utilizable, un plazo vencido o una cancelación con la llamada al proveedor ya hecha conservan la plaza, porque el proveedor pudo haberla guardado (o puede guardarla después). `memory_search` existe cuando el proveedor tiene `recall`: un proveedor sólo de persistencia (con `propose` y sin `recall`) y `propose: true` dan un conjunto con `memory_propose` solo, y un conjunto sin ninguna herramienta es `TypeError`. En el adaptador `memoryProviderFromPorts` de `/orchestration/memory`, `propose` existe sólo para un proveedor sólo de persistencia o con `captureGate: 'store-promotes'`: es la regla de ese adaptador, no del contrato `AgentMemoryProvider`. Los fallos llegan al modelo como `{ error: { code, message } }` con un código cerrado y un mensaje del SDK; el error del proveedor sólo va a `onError`, y el `log` del servidor MCP lo nombra sólo por su clase (`Error`, `TypeError`), nunca por su mensaje ni sus campos, que pueden citar la consulta del cliente. `authorize` admite sólo llamadas de control desde el `cwd` configurado, si lo hay, y que pasen el `authorize` opcional de la app.
- **Servidor MCP (`serveMemoryMcp`):** JSON-RPC 2.0 delimitado por líneas sobre los streams que la app le pase (normalmente `process.stdin`/`process.stdout`); el SDK entrega la biblioteca, no un binario. Habla `initialize` para 2025-11-25, 2025-06-18, 2025-03-26 (con batches) y 2024-11-05 (responde la versión pedida si la soporta, si no 2025-11-25), y la revisión 2026-07-28 sin handshake (`_meta` por petición, `server/discover`, `resultType`, `-32022` para versiones no soportadas). `structuredContent` y `title` sólo desde 2025-06-18. Líneas de hasta 1 MiB, 4 llamadas concurrentes, sólo mensajes de protocolo en la salida; al cerrarse la entrada responde lo ya recibido y termina. Límites y contrapresión: con 16 llamadas en espera por plaza deja de leer la entrada, incluido el resto de un chunk ya recibido, hasta que esperen menos de 8 por plaza; una llamada por encima de 32 en espera por plaza (sólo alcanzable con un batch) se rechaza con `-32000`; un batch de 2025-03-26 con más de 64 mensajes se rechaza entero con `-32600`; y mientras `output.write()` indique el buffer lleno no lee la entrada hasta `'drain'`. `memoryMcpRecipe({ name, executable, script, env })` arma `<node> <script>` para `claudeMcpConfig`; las rutas deben ser absolutas.
- **Forma recomendada, `executable`:** ruta absoluta a un bin instalado antes desde un lockfile (`npm ci` en un directorio que el agente no puede escribir, luego `<dir>/node_modules/.bin/agentdb`). Todo el árbol de dependencias queda fijado por el lockfile.
- **Forma `version` (`npx -y paquete@x.y.z`):** sólo fija el paquete de primer nivel. npm resuelve sus dependencias desde los rangos declarados al instalar en su caché; npx usa un paquete del mismo nombre y versión que encuentre en el proyecto del directorio de arranque en lugar de descargarlo, y el `.npmrc` de ese proyecto puede redirigir el registry, incluidos los registries con scope. Un workspace no confiable puede sustituir el servidor. El SDK no fija variables `npm_config_*`: un `npm_config_registry` sólo prevalecería sobre el registry sin scope de un `.npmrc` de proyecto, no evitaría la sustitución local y anularía el mirror del dueño.
- **RuVector:** el servidor guarda en `.ruvector/intelligence.json` bajo el directorio de arranque (o el home) y no acepta ruta; ese store lo comparten todos los agentes que arrancan desde el mismo directorio o home, sin el scope de memoria del SDK. `readonly` lee lo que cualquier escritor haya puesto; `unrestricted` se rechaza salvo `sharedStoreAcknowledged: true`.
- **Envelope:** los marcadores `config:*` registran capas de configuración que el SDK no lee pero que el CLI carga y que pueden definir servidores MCP. Para Codex, `config:codex-user` cubre `$CODEX_HOME/config.toml` y el `.codex/config.toml` del proyecto, que Codex 0.153.4 carga cuando la configuración del usuario marca el proyecto como confiable; ambas capas se omiten con `--ignore-user-config`.
- **Ruteo con aprendizaje:** `executionDigest` incluye la envelope completa salvo `authorityEpoch`. Desde que `mcpServers` lleva estos marcadores, el digest de los agentes Claude exec sin `strictMcpConfig`/`clean` y de los agentes Codex que no ignoran la configuración del usuario cambió: la evidencia aprendida antes para esos brazos no se reutiliza y el selector arranca en frío para ellos.
