# Compatibility status

Esta tabla describe lo que implementa la Fase 1 developer preview. “Visible” significa que el flag aparece en `--help`; no sustituye un contract test vivo.

| Superficie | Claude exec | Codex exec | Estado del runtime |
|---|---|---|---|
| Turn agentic | Sí | Sí | Implementado |
| Resume persistido | Sí | Sí | Implementado con `SessionRef` |
| Fork con prompt | Sí: `--resume <id> --fork-session` | Sí: `exec fork <id> <prompt>` | `forkAndSend()` / `forkAndStart()`, verificados en vivo |
| Fork sin prompt | No: print mode exige prompt | No: `exec fork` rechaza stdin vacío | Capability separada; rechazado antes del spawn |
| Structured output | `--json-schema` | `--output-schema` | Implementado + validación Ajv |
| Eventos desconocidos | Preservados | Preservados | `provider.event` |
| Token deltas | Stream JSON | No en exec 0.149.0 | Capability-gated |
| Aprobaciones/user input | No | No | Requiere control (registro explícito + gate) |
| Steering | No | No | Requiere control; sólo Codex control lo declara `full` |
| Sesión sólo-en-proceso | No | No | Requiere control |
| Developer instructions | `--append-system-prompt` | Sin canal exec verificado | Codex falla explícitamente |
| Clean context | `--safe-mode` | Aislamiento incompleto | Codex strict falla |
| Memory read-only | Sin separación portable | Sin separación exec verificada | Unsupported |
| Costos | `total_cost_usd` API-equivalent | Tokens, sin costo comparable | Nunca se presenta como cargo real |

> **Alcance de esta tabla.** Describe el transport **exec**. Los transports de control también ship en el paquete, pero requieren registro explícito y un opt-in experimental; su estado por celda, con nivel de soporte y clase de evidencia separados, está en [`capability-matrix.md`](capability-matrix.md).

## Nota sobre fork (actualizada 2026-09-01)

`Session.fork()` fue eliminado en la Tarea 1: la API portable ya no expone un fork sin input. Lo que existe es `Session.forkAndSend(input)` y `Session.forkAndStart(input)`, que crean la rama nativa y ejecutan explícitamente su primer turn.

**El fork es hoy dos capabilities separadas, no una.** El manifest declara `forkWithPrompt: 'supported'` y `forkWithoutPrompt: 'unsupported'` para ambos providers, y `CapabilityRequirements` las expone por separado. Eso corrige una conflación anterior en la que un único verdict `fork: 'partial'` — derivado de la falta de fork *sin* prompt — bloqueaba también el fork *con* prompt, que ambos CLIs sí soportan. `forkAndSend`/`forkAndStart` exigen sólo `forkWithPrompt` y funcionan en exec; el fork sin prompt sigue rechazado antes del spawn, sin inventar un prompt no-op.

## Versiones observadas el 2026-08-31

- Claude Code: **2.1.251 y 2.1.228**, ambas con entrada propia en el manifest. No es una inconsistencia: se observaron dos binarios distintos en dos entornos de validación, y cada una es una entrada de versión exacta con su propio veredicto (ver [Rangos de versión](#rangos-de-versión-en-el-manifest)). Contract vivo aprobado en ambas para first turn, resume, export/reopen desde otro proceso Node, structured output, abort y recovery; fork sin prompt no está soportado en ninguna. El SDK 0.3.251 opera además un binario 2.1.228 vía `pathToClaudeCodeExecutable`, que es la evidencia de que el par bundled no es una restricción.
- Codex CLI local: 0.149.0. Contract vivo aprobado para first turn, resume, export/reopen desde otro proceso Node, structured output, abort y recovery; fork sin prompt no está soportado. Un `item.type=error` puede ser recuperable si el stream termina en `turn.completed`.
- Node.js local: 22.23.2.

## Rangos de versión en el manifest

`CompatibilityEntry.cliRange` (`src/compatibility/manifest.ts`, gramática en `src/compatibility/version-range.ts`) acepta exactamente dos formas:

- **Versión exacta** `MAJOR.MINOR.PATCH` (`2.1.228`).
- **Intervalo semiabierto** `>=LOW <HIGH` (`>=0.153.4 <0.154.0`): incluye `LOW`, excluye `HIGH`, y exige `LOW < HIGH`.

Cualquier otra cosa (`^`, `~`, `x`, `*`, `||`, `>`/`<=`, espacios extra, ceros a la izquierda, prerelease `-alpha.1` o build `+meta`) lanza `TypeError`: es un error de programación del manifest. Una versión instalada malformada o prerelease no coincide con ninguna entrada y degrada como cualquier versión desconocida.

Reglas de resolución (`findCompatibilityEntry`):

- Se filtra por proveedor + transporte; una entrada exacta gana sobre el intervalo que la contiene.
- Dos intervalos solapados, o dos exactas iguales, del mismo proveedor + transporte son un error de programación: `validateCompatibilityManifest` lo detecta y `tests/unit/compatibility-ranges.test.ts` valida el manifest publicado. Si aun así hubiera ambigüedad, la resolución lanza en vez de elegir.
- Sólo una entrada `evidence: 'live-contract'` convierte un flag visible en `supported`. Una entrada `help-probe` nunca declara `supported` (la validación lo rechaza) y sus features con flags presentes quedan `unverified`; sólo puede declarar límites conocidos (`partial`, `unsupported`).
- Una versión sin entrada degrada igual que antes: probe de `--help`, features `unverified`, evidencia `help-probe`, warning `HELP_PROBED_ONLY` y el known issue `CLI version is outside the exact tested manifest`. El único corte duro sigue siendo la falta de flags de `turns`.
- El probe de `--help` se ejecuta siempre contra el binario instalado: un flag ausente marca la feature `unsupported` aunque la entrada coincida.

### Codex CLI 0.153.x (`>=0.153.4 <0.154.0`, evidencia `help-probe`)

Evidencia, del 2026-11-14 en macOS, sin ningún turn ni login: `codex --version` → `codex-cli 0.153.4`, y las salidas de `codex --help`, `codex exec --help`, `codex exec resume --help` y `codex exec fork --help`, guardadas en `tests/fixtures/codex/help-0.153.4/`.

- Cada flag que emite el adapter exec está definido en la superficie donde el adapter lo coloca. Antes de `exec` (`codex --help`): `--model`, `--cd`, `--sandbox`, `--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--config`. Después de `exec`, `exec resume` y `exec fork`: `--json`, `--output-schema`, `--ignore-user-config`, `--ignore-rules`, `--disable`, `--ephemeral`, `--skip-git-repo-check`. El test lo comprueba construyendo el argv real.
- Los flags que exige la entrada 0.149.0 (`REQUIRED_FLAGS.codex`) están todos definidos.
- `--ask-for-approval` aparece sólo en `codex --help`, no en `codex exec --help`; el probe del adapter sólo lee `exec --help`, así que hoy no lo verifica. Queda como known issue de la entrada.
- No se conserva la salida de `--help` de 0.149.0, así que "superficie sin cambios" significa: todos los flags que el SDK usa siguen definidos, no que el `--help` completo sea idéntico.

La entrada del manifiesto conserva evidencia de ayuda. El benchmark público documenta aparte cuatro turnos exec con esquema nativo completados y verificados con Codex CLI 0.153.4, SDK beta.3 y macOS. [Corrida del benchmark](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/evidence/model-benchmark-structured.json)

En la entrada del manifiesto, `turns`, `resume`, `forkWithPrompt`, `structuredOutput` y `permissions` quedan `unverified`; `cleanContext` es `partial` y `tokenDeltas`/`forkWithoutPrompt` son `unsupported`, como en 0.149.0. Readiness y doctor siguen avisando `HELP_PROBED_ONLY`. Las observaciones en el cable con 0.153.4 que citan el adapter y `permissions.ts` (`developer_instructions`, `--ask-for-approval never`, `CODEX_API_KEY`) y los turns de control del 2026-09-24 no promueven esta entrada a `live-contract`. 0.153.0–0.153.3 no se observaron y quedan fuera del rango.

### Claude Code 2.1.228

El mismo día, `claude --version` → `2.1.228 (Claude Code)` y `claude --help` definen todos los flags que exige su entrada y la política `respond` (`--print`, `--output-format`, `--model`, `--session-id`, `--verbose`, `--resume`, `--fork-session`, `--json-schema`, `--include-partial-messages`, `--safe-mode`, `--permission-mode` con `dontAsk`, `--system-prompt`, `--tools`, `--allowed-tools`, `--strict-mcp-config`), además de `--append-system-prompt`, `--add-dir`, `--effort`, `--setting-sources`, `--settings`, `--mcp-config` y `--dangerously-skip-permissions`. La entrada sigue siendo exacta y conserva su evidencia `live-contract` del 2026-08-31; no se extendió a otras versiones.

## Validación macOS

- Host validado: macOS Darwin, Node 22.23.2.
- Resolución de binarios canonicaliza symlinks tipo Homebrew/npm y exige bit ejecutable.
- Abort/timeout crea un process group separado y mata parent + descendientes; existe un test Darwin con un nieto que ignora SIGTERM.
- Los schemas temporales de Codex se crean en directorio `0700`, archivo `0600`, y se eliminan al finalizar.
- En esta máquina, OAuth de Claude en Keychain necesita `HOME`, `USER` y `LOGNAME`; `minimal` los conserva sin heredar tokens de API.
- Los smoke tests de suscripción siguen opt-in mediante `npm run test:live`; no forman parte de `npm test`.
- El cambio explícito de modelo al reanudar fue probado en ambos CLIs; `SessionRef.model` permite emitir `SESSION_MODEL_CHANGED`. Los refs v1 antiguos sin ese campo siguen siendo aceptados.

## Pendiente para publicación o expansión de plataforma

- Windows nativo y Linux todavía no tienen la misma evidencia de process tree que Darwin.
- Terms of service, nombre npm, licencia y governance requieren decisión del owner antes de publicar.
- Los transports de control tienen handshakes y turns mínimos vivos históricos del 2026-09-24. Sus declaraciones globales siguen siendo `sdk-capability` y `generated-schema`: esa evidencia acotada no certifica todas las funciones. Ver la matriz y el informe actual para las extensiones de herramientas y schemas.
- Usage-limit tiene clasificación y fixtures, pero no una captura viva reproducible: depende del estado externo de la cuenta.


## Registros externos

Gemini CLI se distribuye en `hiveagents-runtime` y se registra con `new Runtime()`. El contrato del adaptador documenta versión, transporte, políticas y evidencia. La selección por prefijo y los aliases usan la instancia del runtime, incluidas las referencias a modelos de sesiones hijas.

`npm run verify:first-delivery` verifica el paquete instalado en una app externa con pruebas sin modelos. La comprobación viva de Gemini usa `tests/live/gemini-external.test.ts` y requiere ambos flags de ejecución viva, un modelo explícito y la ruta de esa app instalada. El supervisor cuenta como máximo cuatro lanzamientos con prompt.

En la validación del 2026-11-08 pasaron los fixtures y el consumidor instalado. El CLI Gemini 0.56.0 fue rechazado por Google con `UNSUPPORTED_CLIENT` usando el acceso OAuth local de Gemini Code Assist for individuals. No se confirmó ninguna de las cuatro comprobaciones vivas previstas. El adaptador conserva ese diagnóstico como `UNSUPPORTED_CLI_VERSION` con `rawCode: UNSUPPORTED_CLIENT`; doctor informa la configuración local sin afirmar que la cuenta pueda ejecutar modelos. Detalles en [el informe de validación](validation/providers.md#gemini).

El 23 de noviembre de 2026, Gemini CLI 0.56.0 completó turnos y reanudación entre procesos mediante Vertex AI usando `gemini/gemini-3.7-flash`. La autenticación se verificó por ejecución. [Receta de Vertex y clave API](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/labs/gemini.md) · [Evidencia](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/evidence/gemini-live.json)

## Antigravity CLI externo

El SDK registra `antigravity` y el transporte `antigravityExecV1`. El contrato inicial corresponde a CLI 1.5.3 en macOS. El adaptador de beta.4 agrega 1.5.15, con turnos y reanudación comprobados en macOS ARM64. [Evidencia de Antigravity](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/evidence/antigravity-live.json) El adaptador se distribuye en `hiveagents-runtime` junto con Claude Code, Codex y Gemini CLI.

La política inicial requiere `edit` explícito y conserva la configuración nativa de permisos con `request-review`. No aporta garantías `analyze`, sandbox, bloqueo de red ni aislamiento de startup/MCP. Contexto native/inherit es el único perfil implementado. Control, fork, schema, esfuerzo e instrucciones privilegiadas permanecen fuera del contrato inicial. Las restricciones incompatibles fallan antes de enviar prompts.

`session-send` en la app permite envío y reapertura desde otro proceso con `SessionRef` y cwd explícito. `scripts/verify-antigravity-live.mjs` verifica el contexto retenido con un nonce, contabiliza lanzamientos y vincula la prueba a los tarballs instalados. Sus límites y evidencia se registran por separado del proveedor Gemini.

## Lifecycle y composición de aplicaciones (2026-11-08)

`timeoutMs` y `signal` cubren readiness, pinning, autenticación y apertura además del turno. El contexto opcional `ExecProbeContext` permite a adaptadores externos cancelar probes; un adaptador legado sigue siendo compatible, aunque trabajo JavaScript no cooperativo no puede terminarse por fuerza.

`Session.startFork(input, options)` devuelve un hijo cuando el proveedor confirma su identidad y un `TurnHandle` vivo. `forkAndSend` y `forkAndStart` conservan su comportamiento asentado. `forkTurnObservability` distingue adaptadores streaming del fallback execute-only; no se fabrica una identidad ni se consume el canal de eventos del usuario para descubrirla. El hijo confirmado sobrevive a un fallo de su primer turno; un resultado incierto requiere reconciliación o reemplazo.

`AgentOptions.tools` declara herramientas de aplicación con JSON Schema, autorización explícita, callback y límites por herramienta. Requiere control registrado y sus gates; no hay fallback silencioso a exec. Codex control admite schema por turno; Claude conserva `structuredOutput: none` por ausencia de setter público por turno en su Query persistente. La validación de texto JSON de una app no modifica ese verdict.
