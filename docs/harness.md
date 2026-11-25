# Evaluaciones, trazas y handoff de tareas

Estas APIs son opcionales y se importan de `hiveagents-runtime/orchestration`.
El import principal conserva su API de agentes y proveedores. No se añaden dependencias,
servicios de observabilidad remotos ni un selector automático de modelos.

## Evaluar resultados

`runEvaluation` recibe un corpus JSON versionado, un perfil con digest de sus fuentes,
callbacks de ejecución y scorers independientes. Los scorers evalúan lo que la tarea
produjo; una respuesta del modelo que diga «terminé» no equivale a un resultado correcto.
El runner no conoce categorías ni políticas de negocio.

Los intentos son secuenciales. `repetitions` expresa repeticiones deliberadas y no retries
ocultos. El deadline incluye admisión, escritura de trazas, ejecución y verificación.
Una señal pide cancelación cooperativa. El trabajo que la ignore conserva su reserva;
no se inicia el próximo intento ni se libera ownership como si hubiera terminado.
Para componer un `Agent` o `Session` exec con el runner, pasá `awaitSettlement: true`
en las opciones del turno. La app independiente lo activa: espera readiness, autenticación,
pinning, trabajo del adaptador y cleanup reales antes de devolver el callback. El modo por
defecto mantiene la respuesta acotada anterior. Control rechaza este opt-in antes de ejecutar.
Un callback no cooperativo puede mantener la promesa y su reserva pendientes indefinidamente.
Un fallo de persistencia es fatal y queda visible fuera de los errores del proveedor.

El informe conserva digests, estados, scores y códigos acotados. No guarda inputs ni
outputs raw por defecto. Informa éxito inicial, éxito por repetición, consistencia de
outputs, p50/p95 observados y admisiones/denegaciones. Admisión no equivale a un
lanzamiento nativo: la aplicación debe medir ese límite si desea afirmarlo.
Usage faltante sigue desconocida, con cobertura por campo; los buckets de costo con
distinto `costMeaning` no se suman como si fueran cargos equivalentes.

`compareEvaluations` valida los informes y exige corpus, scorers y repeticiones
compatibles. Cada perfil conserva su fuente. Sin intentos, los percentiles en 0 indican ausencia de muestras; revisá `metrics.total`. La app rechaza comparaciones incompletas. Comparar scores de un corpus de demostración
no acredita una mejora general de modelos ni un ahorro marginal en suscripciones.

## Trazas locales durables

`openTraceEpisode(store, identity)` abre un recorder exclusivo. La identidad liga tarea,
fuente y perfil a versiones y SHA256. `append` acepta metadata explícita y acotada;
`observe` proyecta eventos públicos del agente a metadata segura. Prompts, deltas de
texto, argumentos/resultados de herramientas, errores y eventos nativos raw quedan fuera.
`finish` sella el episodio; `close` espera las escrituras pendientes y libera el lease.
`readTraceEpisode` permite inspección después de reiniciar otro proceso.

`WorkflowTraceStore(new FileWorkflowStore(directory))` reutiliza exclusión y reemplazo
durable existentes. El namespace es independiente del workflow y de las decisiones.
Los checksums detectan corrupción; no son firmas contra un escritor autorizado del store.
El store es local, con directorio privado: no ofrece fencing distribuido ni recuperación
por TTL. Una caída con lock retenido requiere la recuperación explícita del store cuando
el owner y su trabajo hayan terminado. No usar una traza como autorización.

## Handoff recuperable

`createTaskHandoff` captura objetivo, requisitos, contexto seleccionado, fuente,
destinatario, evidencias, artefactos, pendientes y efectos inciertos. `sourceSession`
es provenance opcional. Las referencias a artefactos son inertes: el helper no las lee,
descarga o ejecuta. La app decide qué contexto conservar; no debe incluir credenciales.

`WorkflowHandoffStore` guarda el paquete inmutable. El mismo ID con otro contenido se
rechaza. `runHandoff` verifica destinatario, fuente y efectos pendientes, y compone
`DecisionRunner`: autorización fresca, `isCurrent` antes del efecto, intent durable,
resultado y verificación con evidencia. El authorizer es código confiable de la app.
Si execute espera otra operación antes del efecto, debe revalidar autoridad en ese límite.

Un intent recuperado o efecto ambiguo requiere reconciliación del owner. Un resultado
ya despachado puede verificarse de nuevo; un resultado verificado se reutiliza sin repetir
el efecto. El handoff no reanuda automáticamente una sesión de otro proveedor. El receptor
puede crear un Agent explícito y una nueva sesión con el contexto seleccionado.
`readHandoffDecision` inspecciona el registro validado y su vínculo con el paquete, sin
autorizar ni ejecutar efectos. El productor de la app admite repetir el mismo envío y
recuperar su identidad durable después de perder la respuesta.

## Consumidor independiente

La app `apps/document-triage` instala SDK, Gemini y Antigravity desde tarballs. Sus comandos
`evaluate`, `evaluation-compare` y `trace-inspect` ejercitan 30 casos etiquetados con oracles
separados y dos clasificadores locales. `handoff-produce`, `handoff-consume` y
`handoff-status` muestran entrega entre procesos y un único efecto verificado.

Todo funciona sin modelos por defecto. Para evaluar un proveedor deben indicarse modelo,
casos y un `--max-launches` que cubra los turnos solicitados; la suite rechaza presupuestos
insuficientes antes de ejecutar. El perfil incluye las fuentes instaladas del SDK y una huella de configuración
del ejecutable, argumentos, cwd y política. La huella conserva digests, sin guardar rutas,
argumentos ni credenciales. Las ejecuciones de modelos y fixtures llevan la etiqueta
`transport-observation`; un Runtime custom queda explícitamente sin atestación. Ver el README de la app para comandos completos.

Si el timeout o la cancelación llega durante la escritura del terminal de un intento,
el runner añade y espera `evaluation.attempt.corrected`. El último evento completed o
corrected de ese phaseId es el estado autoritativo y coincide con el informe. Las reservas
se conservan hasta que termine esa escritura. `budgetDenied:true` conserva la causa de
una denegación aunque el estado final cambie por el timeout; no se reanudan admisiones.
