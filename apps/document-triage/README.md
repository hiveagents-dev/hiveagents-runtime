# Independent document triage

This application uses one dependency, `hiveagents-runtime`. It configures the four included providers in one runtime. Each result records the observed authentication source. The application validates model output against its own schema.

Use Node >=22.16.0 on macOS. From the repository root, build the SDK with `npm run verify:first-delivery`. From the application directory, place the verified SDK tarball at `vendor/core.tgz` and install it. If you already have the matching tarball from this checkout, you can use `npm ci` instead.

```sh
mkdir -p vendor
cp ../../.artifacts/first-delivery/core.tgz vendor/core.tgz
npm install --no-audit --no-fund ./vendor/core.tgz
npm run typecheck
npm run build
```

`node dist/main.js doctor` checks the installed CLIs without sending prompts. The offline example works without a provider CLI.

The app declares its own TypeScript and Node types. It compiles with NodeNext
resolution and `skipLibCheck: false`. The repository's
`scripts/verify-external-consumer.mjs` copies this directory to a temporary
directory outside the checkout, installs the SDK tarball with npm, audits
module resolution and dependencies, and runs these same checks.

Create `documents.json` containing `[ { "id": "vpn", "text": "VPN access notes" } ]`.
The local rules mode consumes no provider turns:

```sh
state_dir=$(mktemp -d)
node dist/main.js triage --input documents.json --state-dir "$state_dir" --stop-after-intake
node dist/main.js triage --input documents.json --state-dir "$state_dir"
node dist/main.js triage --input documents.json --state-dir "$state_dir"
```

The first process stores intake and pauses, the second completes network and
backup branches, and the third returns the cached report. Changing documents,
model, or canonical working directory produces a separate workflow identity. Inspect `executedSteps` to see what ran in each process.
The local launch budget is demonstration policy, not a provider quota.

Choosing a model explicitly consumes provider capacity. Start with a Claude or Codex model that your local account can use. The Gemini commands below show the adapter interface. OAuth was blocked in the documented environment with Gemini CLI 0.56.0, so use them only when you have working authentication. [Gemini validation](../../docs/validation/2026-11-08-gemini-external-provider.md)

 `triage --model
gemini/gemini-2.5-flash` runs two branches. `classify-one` requires exactly one
document and calls `Agent.run` exactly once:

```sh
node dist/main.js classify-one --input documents.json --model gemini/gemini-2.5-flash --cwd /absolute/project --ref-out session.json
node dist/main.js resume-session --ref session.json --model gemini/gemini-2.5-flash --cwd /absolute/project
```

Resume requires an explicit working directory matching the saved reference.
SIGINT and SIGTERM request cooperative cancellation. Cached successful branches
are reused after a restart. A malformed classification fails its branch rather
than being saved as a successful report.

`session-send` sends an arbitrary UTF-8 prompt file through one `Session.send`
and writes the exported provider reference. It requires `--cwd` and `--ref-out`
for every invocation, canonicalizes the working directory, and uses a 60 second
turn deadline. Prompt files must be regular files containing 1 to 65,536 bytes,
with non-whitespace text and no NUL. Text is passed literally; this command does
not apply classification schema validation. A second process can resume the
same conversation with the saved reference:

```sh
node dist/main.js session-send --prompt-file first.txt --model antigravity/gemini-3.8-flash-low --cwd /absolute/project --ref-out session.json
node dist/main.js session-send --prompt-file next.txt --model antigravity/gemini-3.8-flash-low --cwd /absolute/project --ref-out session.json --ref session.json
```

Each invocation opens or resumes one session, sends once, then closes it even
on failure. A successful result includes `text`, `status`, `session`, observed
`auth`, available `usage`, warnings and effective permission enforcement.
`toolEvents` counts observable tool events without exposing tool arguments.
An unsuccessful turn exits with an error and does not write a new reference.
Antigravity resume keeps its native UUID; cumulative native usage is not
presented as new-turn token usage or a fabricated cost.

Antigravity explicitly uses `edit` with native `request-review` permissions and
slash commands disabled. Its classification and workflow outputs report this
policy. Analyze mode has no proven read-only contract for this adapter and is
rejected before prompting. Native review is not a filesystem sandbox or a
network denial guarantee. Claude, Codex and Gemini continue to use `analyze`.

Tests always use the included fake Gemini and Antigravity subprocesses, never the installed model
CLI. `OAR_GEMINI_COMMAND` can select an absolute executable path, with an optional
JSON array in `OAR_GEMINI_ARGS_JSON` for its argument prefix (for example, Node
and the fixture script). This configuration is passed to the provider factory
and preserved by executable pinning. Tests verify durable resume/cache,
streaming, session export/resume and rejection of a required absent capability
before a turn launches.
`OAR_ANTIGRAVITY_COMMAND` and `OAR_ANTIGRAVITY_ARGS_JSON` configure Antigravity in
the same way. Its fake fixture persists a nonce in the test working directory;
two independent app processes prove that the exported UUID resumes that native
state. Doctor performs version/help probes and passive checks without prompts.

## Herramientas comunes y decisiones durables

Después de `npm install` y `npm run build`:

```bash
node dist/main.js tool-demo
node dist/main.js triage-decision --input ./documents.json --state-dir ./state --authority-file ./authority.json
```

`tool-demo` usa el binding público real con un transporte mock, sin modelos.
Lee un documento temporal y escribe una sola síntesis mediante dos herramientas
con schema, authorizer y límites. `--mode codex --model codex/<id>` y
`--mode claude --model claude/<id>` usan autenticación local y consumen capacidad.
Claude necesita los peers opcionales Agent SDK y MCP instalados. En Claude la
app valida JSON final; no se declara structured output nativo por turno.
Ambos modos reales habilitan explícitamente `experimentalControl` y
`experimentalApi`. Claude usa `edit` explícito para evitar que el modo nativo
plan solicite una transición de permisos; otras herramientas nativas siguen
requiriendo el broker de aprobaciones. Sólo las dos herramientas declaradas
entran por sus authorizers de aplicación.

`triage-decision` ejecuta reglas locales y protege el dispatch con una decisión
durable. El archivo de autoridad es del operador, fuera de la autoridad de las
herramientas del modelo; se relee antes de ejecutar. Su formato es
`{"id":"operator","version":"1","decision":"allow","reason":"Reviewed","expiresAt":<epoch-ms>}`.
También admite `wait`/`deny`, y `nextAt` opcional. El vencimiento debe ser futuro.
El comando no acepta `--model`; la API programática conserva ese modo para apps
que proveen una política confiable. Un intent de resultado incierto se reconcilia
por el owner y no se reproduce automáticamente. Los checkpoints originales del
workflow mantienen su formato.

## Evaluaciones y trazas locales

Con los paquetes instalados y `npm run build`:

```bash
node dist/main.js evaluate --state-dir ./harness-state --profile baseline --repetitions 2
node dist/main.js evaluate --state-dir ./harness-state --profile candidate --repetitions 2
node dist/main.js trace-inspect --state-dir ./harness-state --episode <episodeId>
node dist/main.js evaluation-compare --baseline <baseline-report.json> --candidate <candidate-report.json>
```

Cada ejecución imprime el path del informe, episodeId, métricas y cobertura de usage.
Para comparar deben coincidir corpus, scorers y número de repeticiones: ejecutá ambos
perfiles con las mismas opciones. Los30documentos tienen etiquetas y anchors manuales,
separados de los clasificadores; cubren español/inglés, fallos de red, recuperación,
otros temas y contenido con una instrucción que debe tratarse como dato. El baseline
reconoce pocos términos; el candidate aplica reglas bilingües. Es una demo de evaluación,
no evidencia de superioridad de un modelo o generalización fuera de ese corpus.

La traza y el informe conservan digests, metadata y scores; no guardan textos, prompts,
argumentos o resultados raw. Usage ausente permanece desconocida. El informe distingue
admisiones de intentos y lanzamientos nativos; el modo local registra0modelos.

Un ensayo opt-in de un solo caso puede ejecutarse así:

```bash
node dist/main.js evaluate --state-dir ./harness-state --model gemini/<id> --case-id vpn --max-launches 1
```

Ese comando consume capacidad cuando el proveedor está operativo. Un presupuesto
insuficiente para casos×repeticiones falla antes del turno. No hay retries automáticos;
las condiciones de autenticación, permisos y capacidades siguen perteneciendo al runtime.
El acceso OAuth retirado de Gemini0.56 no se arregla habilitando esta opción.

Los ensayos con `--model`, incluidos los fixtures, se etiquetan siempre como
`transport-observation`: el fingerprint no acredita autenticación ni calidad de
proveedor. La fuente incluye los bytes JS instalados del único paquete SDK
externos, resueltos por sus entrypoints públicos. El perfil liga también digests de
command/scripts, argumentos, cwd y política. No imprime rutas, argumentos ni claves;
el fingerprint no lee credenciales ni lanza probes nativos. Para targets por defecto
liga todos los candidatos PATH, sin afirmar cuál pasó un probe. Un Runtime
programático ajeno a la factory queda `custom-runtime-unattested` y recibe identidad
de ejecución no reutilizable. La comparación local conserva `local-classifier-demo`.

El evaluador pasa `awaitSettlement: true` al starter exec del SDK. El deadline aborta
la señal, pero conserva la reserva hasta que terminen las promesas reales del adapter
y su cleanup, incluso si ignoran la señal. Un adapter no cooperativo puede mantener
pendiente la evaluación indefinidamente. El comportamiento por defecto del SDK sigue
siendo acotado y los turnos control rechazan esta opción antes de inferencia.

## Handoff entre procesos

```bash
node dist/main.js handoff-produce --input ./documents.json --state-dir ./harness-state --id review
node dist/main.js handoff-consume --state-dir ./harness-state --id review --authority-file ./authority.json
node dist/main.js handoff-status --state-dir ./harness-state --id review
```

El archivo de autoridad tiene el formato de `triage-decision` descrito antes y debe
estar bajo control del operador. El receiver por defecto es `document-reviewer`; se
puede fijar `--target` en productor y consumidor. Se revalida autoridad inmediatamente
antes de escribir un artefacto privado. Su contenido y digest se verifican antes del recibo.
Una segunda llamada consume reutiliza ese recibo y no vuelve a escribir el efecto.
Repetir `handoff-produce` con los mismos inputs, fuente y destino devuelve la misma
identidad durable, incluso si se perdió el stdout anterior. Un trace producer aún
running se reconcilia con el bundle ya guardado; un draft diferente rechaza.
`handoff-status` valida el registro completo y su binding al bundle antes de mostrar
verified; no ejecuta el runner ni escribe una decisión al consultar.

El contexto del handoff incluye los documentos seleccionados de forma explícita y se
guarda en el store privado. No contiene una aprobación. Fuente cambiada, destinatario
incorrecto o efectos inciertos impiden el dispatch. Una referencia de sesión sería
provenance; este recorrido local no hace resume nativo ni cambia de proveedor.

Los directorios `traces`, `handoffs`, `decisions`, `effects` y `reports` pertenecen a la
app. Los stores locales no ofrecen fencing distribuido ni roban locks activos por edad.

## Selección local de modelo

La app importa exclusivamente `hiveagents-runtime/routing` del paquete instalado.
Guardá una definición declarativa en `agent.json`:

```json
{
  "model": {
    "mode": "auto",
    "candidates": ["codex/gpt-5.6-sol", "claude/claude-sonnet-5"],
    "allowUnverifiedModels": true,
    "fallback": "claude/claude-sonnet-5"
  },
  "transport": "exec",
  "requireAuth": "any",
  "permissions": { "mode": "analyze" }
}
```

Para fijarlo reemplazá `model` por un string calificado, por ejemplo
`"codex/gpt-5.6-sol"`. El mismo mecanismo admite cualquier registro externo.
Un catálogo estático no confirma acceso al modelo; el opt-in `allowUnverifiedModels`
permite intentar esos IDs, sin inventar disponibilidad. Por defecto, automático
excluye autenticación desconocida. `allowUnknownAuth: true` sólo acepta esa falta de
evidencia; nunca acepta una autenticación explícitamente negativa.

```bash
node dist/main.js route-select --config ./agent.json --state-dir ./routing-state --id selection-1
node dist/main.js route-inspect --state-dir ./routing-state --id selection-1
node dist/main.js route-classify --config ./agent.json --input ./one-document.json --state-dir ./routing-state --max-launches 1
```

`route-select` sólo comprueba preparación: cero prompts y cero APIs de ruteo.
`route-classify` valida un único documento, selecciona, guarda el recibo y solicita
un único turno exec con el tiempo restante. Rechaza un resultado control antes de
abrir la sesión. Un fallo de ejecución no dispara fallback ni retry. El proveedor
puede consumir capacidad; `modelLaunches: null` evita confundir un turno solicitado
con el número de procesos/turnos nativos internos del CLI.

La selección respeta `providers` como allowlist y reglas `rules` de primer match:
`{"id":"review","allTags":["review"],"models":["claude/claude-sonnet-5"]}`.
Los tags se pasan con `--tags review`; son metadata declarada por la aplicación,
sin clasificación semántica oculta. El fallback es el último recurso, debe estar
en `candidates` y superar los mismos filtros. Sin candidatos explícitos se utilizan
sólo los catálogos configurados; Gemini requiere IDs explícitos si su catálogo está vacío.
Permisos de la definición se conservan: Antigravity exige `edit` explícito y no se
habilita para sortear una restricción `analyze`.

`--timeout-ms` limita el intento completo, incluido guardado y clasificación;
SIGINT/SIGTERM cancela la misma operación. Los probes y turnos exec se esperan hasta
su terminación real. Un adaptador que ignore la señal puede mantener pendiente el
cleanup. `--cwd` tiene prioridad sobre `cwd` de la definición y el directorio actual.
La app controla el entorno y la configuración nativa de los subprocesses: rechaza
`environment` y los bloques `providerOptions.claude`, `.codex` y `.external` en el JSON,
incluidos settings como objeto, string JSON o path a un archivo. En `providerOptions`
sólo acepta los booleanos `experimentalControl` y `experimentalApi`, que habilitan
explícitamente las APIs control. El framework conserva sus APIs de configuración
nativa para aplicaciones que definan su propia política.

Los recibos viven en `routing` y se verifican desde un proceso nuevo. Guardan una
propuesta, nunca autoridad ni evidencia de calidad o éxito de ejecución. Cada intento
usa un ID nuevo: repetir uno existente falla incluso si su contenido coincide. Un
vencimiento durante un guardado ya iniciado puede dejar una propuesta seleccionada,
pero la factory no devuelve el agente. La app liga `sourceDigest` a sus JS compilados
y el SDK instalado. Los IDs de intento y regla deben ser opacos y no
contener secretos. No se guardan textos de documentos, prompts ni credenciales.

La prueba reproducible es `OAR_CONSUMER_KEEP=1 npm run verify:first-delivery` y luego
`OAR_ARTIFACT_DIR=.artifacts/first-delivery npm run verify:routing`, desde el repositorio.

## Aprendizaje local multiproveedor

`learn-cycle` utiliza el paquete público opcional `hiveagents-runtime/routing/learning`.
La configuración es JSON: `model` puede ser un string fijo o `{ "mode": "auto",
"candidates": [{ "id": "sol", "model": "codex/gpt-5.6-sol", "effort": "low" },
{ "id": "sonnet", "model": "claude/claude-sonnet-5", "effort": "low" }],
"allowUnverifiedModels": true }`. Agregar `transport: "exec"`,
`requireAuth: "subscription"` y `permissions: { "mode": "analyze" }`.
Se aplican los mismos filtros del framework antes de ejecutar cada candidato.

```bash
node dist/main.js learn-cycle --config ./agent.json --state-dir ./learning-state --suite document --objective latency --max-launches 32 --total-launches 32
node dist/main.js learn-status --config ./agent.json --state-dir ./learning-state --suite document --objective latency
node dist/main.js learn-run --config ./agent.json --state-dir ./learning-state --suite document --objective latency --input ./task.json --max-launches 1
```

`task.json` contiene `{ "kind": "classification", "seed": 811 }` o
`{ "kind": "arithmetic", "seed": 811 }`. Son tareas de demostración con
oráculos exactos independientes. El framework admite el input y verificador
propios de cualquier app. `learn-status` no ejecuta modelos y debe usar el mismo
objetivo, suite y timeout del ciclo. Cambiar de suite crea un dominio separado.

Con dos candidatos, `--suite document` solicita como máximo 32 turnos:
9 tareas de entrenamiento (3 por categoría), 1 de regresión y 6 nuevas
(2 por categoría), cada una en ambos modelos.
La suite `mixed` requiere 72 turnos para aprender especialización entre
clasificación y aritmética. El presupuesto se comprueba completo antes de empezar;
`--max-launches` limita cada comando y `--total-launches` establece además el
límite persistente por hora y día. Un intento fallido consume su admisión.
Estas llamadas usan los proveedores configurados; no hay API paga de ruteo.

`learn-run --auto-improve` actualiza evidencia y ejecuta mantenimiento con el
mismo presupuesto explícito, después de liberar la reserva del turno principal.
El mantenimiento tiene su propio plazo de 20 minutos y recibe la cancelación del
comando; cada turno conserva su timeout individual.
Para la suite `mixed` y dos modelos exige al menos 73 admisiones. El corpus demo
tiene tres bancos de tareas nuevas y rechaza su agotamiento; cambiar IDs no crea
evidencia nueva. Una aplicación continua debe aportar nuevas tareas verificables.
`learn-cycle --operation rollback` compara la política anterior usando nuevas
mediciones; no realiza un cambio sin evidencia. `learn-matrix` es un alias de
`learn-cycle`.

SQLite conserva intentos, resultados, propuestas, episodios, gates y cambios de
política. Los fallos y métricas desconocidas no se convierten en éxitos. El gate
puede conservar la política anterior aun cuando toda la matriz termine: eso
significa que no demostró una mejora suficiente. Ver el [contrato del módulo](../../src/routing/learning/README.md).
Una política activa conserva su configuración e identidad de ejecución. Si se
cambian candidatos, esfuerzo, workspace o CLI, un ciclo o mantenimiento automático
rechaza la incompatibilidad antes de gastar turnos. Usar otro `--state-dir` para
crear esa nueva historia, conservando el estado anterior para consulta y rollback.
`OAR_ARTIFACT_DIR=.artifacts/first-delivery npm run verify:learning` demuestra
especialización, promoción, persistencia y rollback con proveedores simulados;
no representa un benchmark de calidad de modelos reales.

## Corpus propios y ciclos continuos

La app acepta tareas propias mediante `study-cycle`, `study-run` y `study-status`.
Los ejemplos portables están en `config/study-agent.json` y
`config/supplied-corpus.json`. Las llamadas a modelos consumen capacidad de los
proveedores autenticados; el selector no usa una API de ruteo.

```bash
node dist/main.js study-cycle --config ./config/study-agent.json --corpus ./config/supplied-corpus.json --state-dir ./study-state --objective latency --max-launches 4 --batch-id fresh-one
node dist/main.js study-cycle --config ./config/study-agent.json --corpus ./config/supplied-corpus.json --state-dir ./study-state --objective latency --max-launches 56 --batch-id fresh-one
node dist/main.js study-status --config ./config/study-agent.json --corpus ./config/supplied-corpus.json --state-dir ./study-state --objective latency
```

Cada tarea contiene `id`, `text` y `expected`: el JSON completo esperado, no texto
de un juez LLM. El verificador acepta exactamente sus claves, tipos y valores;
el orden de claves de objetos no importa y el de arrays sí. Rechaza claves JSON
duplicadas, contenido fuera del JSON y valores no finitos. Al leer JSON también rechaza números cuyo valor decimal se redondearía o convertiría en cero; usá strings para valores que necesiten más precisión. Los números JS ya construidos conservan la precisión de `Number`, sin acceso al literal original. Los datos están
limitados a 8MiB, profundidad512 y100000 valores; cada prompt es no vacío y tiene
como máximo32768 bytes UTF8. Los CLIs reciben sólo `text`, nunca `expected`.

El corpus declara `train`, `fixed` y `freshBatches`, además de
`study: {maxCycles,maxLaunches,minNewTasks}` y `evaluation: {repetitions}`.
Los IDs y los hashes del texto no pueden repetirse entre sus tareas. La base de
entrenamiento/regresión, oráculo y límites queda vinculada al protocolo. Se pueden
agregar nuevos batches al final sin cambiar de dominio ni perder la política;
modificar, reordenar o borrar batches registrados falla antes de otro turno.
Un texto usado en producción tampoco puede incorporarse luego como holdout.

`--max-launches` limita las nuevas admisiones de cada comando: al alcanzarlo,
devuelve `paused` después de esperar el cierre real del turno. El siguiente
proceso retoma ese mismo ciclo. El límite del corpus es acumulado y durable;
reiniciar no lo repone. Cada intento de adquirir presupuesto consume una admisión,
incluso si falla antes de lanzar el modelo. Las tareas de calibración terminadas
se reutilizan. Un intento iniciado sin resultado bloquea el ciclo y aparece en
status: nunca se reenvía automáticamente.

`--batch-id` también permite recuperar un informe ya terminado con cero llamadas,
por ejemplo si se perdió stdout. Sin ese selector se retoma el ciclo incompleto
o se elige el siguiente batch disponible. Las decisiones, episodios y gates se
reconcilian con el mismo identificador después de un reinicio.

Para producción, `study-run --input ./task.json --max-launches 1` toma una tarea
con `{id,text,expected}`. Su ID identifica la solicitud: repetirla recupera el
recibo sin ejecutar otra vez; el texto de una respuesta previa no se guarda en el
journal y no se inventa al recuperarla. Un mismo texto con otro ID puede volver
a solicitarse, pero no cuenta como soporte independiente.

Con `--auto-improve` y presupuesto adicional, el mantenimiento espera al menos
`minNewTasks` inputs distintos nuevos, o devuelve `deferred` sin gastar en otra
matriz. Usa su propio plazo y la señal de cancelación del comando. La selección
de producción y el registro de nuevos holdouts comparten la exclusión del estudio.
No se ejecutan comandos arbitrarios como verificadores.

La política sigue pasando los mismos filtros y gates. El estudio distribuye el
umbral total0,05 entre su número máximo de ciclos, sin renovarlo en cada proceso.
Las repeticiones promedian mediciones de una tarea; no aumentan sus votos
independientes. Cada batch se consume una vez y una evaluación puede decidir KEEP.
El estado queda ligado al build, configuración e identidad de ejecución: cambiar
esa historia requiere un estudio/directorio nuevo, no una migración silenciosa.
Los comandos de estudio requieren disponibles todos sus candidatos declarados,
también al admitir producción: protegen una comparación con identidad estable.
La selección entre esos brazos conserva el ranking normal; las APIs generales
del SDK y los comandos `learn-*` mantienen su comportamiento de filtros/fallback.

`npm run verify:continuous` audita las pruebas guardadas del consumidor instalado:
cuatro batches agregados, una sola calibración, chunk/resume entre procesos,
cadencia, replay de informes, promoción y rollback. No vuelve a lanzar sus
fixtures ni presenta esas respuestas simuladas como calidad real de modelos.
Verifica tarballs npm en una app fuera del checkout, selección sin prompts, reglas,
filtros, fallback, recibos entre procesos y un turno de fixtures externos. Los fixtures
validan transporte e integración; no miden calidad de los modelos reales.
