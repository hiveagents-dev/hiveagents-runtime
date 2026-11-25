# Módulos y evidencia

Para el primer turno alcanza con el core. Agregá orquestación cuando necesitás recuperar trabajo entre procesos y routing cuando tu aplicación tiene que elegir entre proveedores. Los demás módulos resuelven necesidades de integración específicas.

Para probar cada entrada con el paquete npm instalado y ver qué partes cuentan con evidencia en vivo, consultá el [mapa de laboratorios y cobertura](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/labs/README.md).

## Imports del SDK

| Import público | Qué te permite hacer | Evidencia y condición de uso |
| --- | --- | --- |
| `hiveagents-runtime` | Ejecutar un turno con `Agent`, mantener una conversación con `Session`, inspeccionar capacidades y registrar proveedores en `Runtime`. | Instalado y probado con fixtures. Claude Code y Codex por `exec` son la ruta inicial. Las sesiones, el streaming y JSON Schema dependen del transporte y la versión. Control requiere registro y opt-in. |
| `hiveagents-runtime/orchestration` | Guardar checkpoints con `WorkflowRunner`, compartir admisión local, registrar decisiones, comparar evaluaciones y entregar tareas con evidencia. | La app instalada ejercita pausa, reinicio, reutilización de pasos, evaluación y handoff con fixtures. Cada app define política, efectos y verificadores. |
| `hiveagents-runtime/orchestration/graph` | Ordenar un grafo por dependencias con `dependencyWaves` y detectar ciclos antes de ejecutar. | Primitiva pura y determinista. Usala para tu propio scheduler o como diagnóstico de un DAG. |
| `hiveagents-runtime/orchestration/memory` | Rankear documentos y conectar memoria opt-in con `memoryProviderFromPorts`. | Exporta ranking y puertos. El backend SQLite se importa desde `/orchestration`. La app elige alcance y política de captura. |
| `hiveagents-runtime/orchestration/dynamic` | Validar un plan JSON, ejecutar llamadas con límites y recuperar resultados terminados desde un journal. | Pruebas de fixtures sobre validación, detenciones, presupuestos y recuperación. Apto para trabajo supervisado e idempotente. La aplicación decide si aprueba el plan. |
| `hiveagents-runtime/orchestration/log` | Registrar el ciclo de vida de una ejecución y consultar evidencia durable en SQLite. | Ejercitado con bases temporales, consumidores externos y reinicios. El historial tiene un límite de escaneo compartido con la telemetría. |
| `hiveagents-runtime/memory-tools` | Exponer `memory_search` y propuestas de aprendizaje como herramientas de aplicación o por MCP. | Opt-in. La aplicación fija el alcance y decide qué propuestas promueve. El contenido recuperado sigue siendo entrada no confiable. |
| `hiveagents-runtime/routing` | Elegir un modelo mediante prioridades, tags y preflight. Obtener un recibo de la decisión. | Selector determinista verificado con fixtures. Decide antes del turno. El recibo registra la decisión de selección y el fallback se evalúa en esa etapa. |
| `hiveagents-runtime/routing/learning` | Evaluar candidatas en sombra, usar resultados verificados y promover o revertir políticas. | Ruta avanzada. El gate beta acreditó promoción, persistencia y rollback con fixtures. El efecto sobre calidad, costo o latencia debe medirse en cada carga. |
| `hiveagents-runtime/adapter-kit` | Construir otro adaptador con primitivas de procesos, descubrimiento y decodificación JSONL. | Usá estas primitivas con un `ProviderRegistration` para conectar otro CLI al mismo SDK. Cada adaptador tiene su propio contrato y pruebas. |
| `hiveagents-runtime/hosted` | Conectar un worker con un Host que registra los proveedores y media su ejecución. | Verificado con un protocolo simulado. Requiere el Host externo para autoridad de admisión y contención operativa. |

Contratos y ejemplos para profundizar. [Guía de integración](integration-guide.md) · [Orquestación y memoria](orchestration.md) · [Historial](orchestration-run-history.md) · [Evaluación, trazas y efectos](harness.md) · [Routing](../src/routing/README.md) · [Aprendizaje de routing](../src/routing/learning/README.md)

## Proveedores y extensiones

| Integración | Ruta recomendada | Qué está verificado |
| --- | --- | --- |
| Claude Code y Codex | Core por `exec` | Fixtures del paquete y pruebas vivas históricas en versiones concretas. Un `HELP_PROBED_ONLY` describe el resultado de inspeccionar ayuda, con el turno real pendiente de comprobar. |
| Claude y Codex Control | Registro por proveedor y `experimentalControl` | Superficie experimental con evidencia por capacidad. Claude y Codex ofrecen conjuntos diferentes de interacciones. Las herramientas dinámicas de Codex requieren además `experimentalApi`. |
| Gemini CLI | `hiveagents-runtime` | Gemini CLI 0.56.0 con Vertex AI y `gemini-3.7-flash` completó envío y reanudación entre procesos con beta.3. El informe histórico de OAuth describe un canal distinto. |
| Antigravity CLI | `hiveagents-runtime` | El contrato incluye fixtures para 1.5.3. La beta.4 con soporte explícito para 1.5.15 completó envío y reanudación reales y está disponible en las descargas del tutorial. Requiere `edit` y conserva la política nativa de revisión. |
| AgentDB y RuVector | Prototipo privado del repositorio | Backend experimental fuera de la distribución npm. La suite prueba puertos con backends inyectados. |

[Capacidades por proveedor y transporte](capability-matrix.md) · [Versiones exactas y rangos](compatibility.md) · [Evidencia de Gemini](validation/providers.md#gemini) · [Evidencia histórica de Claude y Codex](validation/providers.md#control)

## Qué demuestra cada prueba

- **Demo offline.** Demuestra que un workflow vuelve a abrir el estado y ejecuta pasos pendientes. Usa reglas locales y el contador de admisión del ejemplo. [Cómo reproducirla](../examples/README.md#document-triage-and-restart)
- **Instalación externa.** `npm run verify:first-delivery` construye e instala el tarball del SDK, compara el manifiesto, el código compilado y los tipos instalados con el tarball, compila con NodeNext y prueba la app con procesos simulados. Su recibo identifica el snapshot y el artefacto. [Procedimiento](release-checklist.md)
- **Compatibilidad viva.** Un turno real agrega evidencia para esa combinación de proveedor, CLI, transporte, configuración y fecha. Para diagnosticar un entorno nuevo, ejecutá `doctor` y comprobá los permisos efectivos antes de enviar un turno. Para Antigravity, usá `Agent.capabilities()` desde la API con el modo `edit` explícito. [Compatibilidad](compatibility.md)
- **Efectos y límites.** El checkpoint evita repetir pasos registrados como completos. Un paso en curso al caer el proceso puede quedar ambiguo. Para efectos externos, registrá intención, aplicá idempotencia cuando el destino la soporte y reconciliá el resultado antes de repetir. El presupuesto dinámico de tokens usa el uso reportado y puede superarse con llamadas en vuelo. [Recuperación](orchestration.md#recoverable-workflows) · [Límites dinámicos](orchestration.md#scripts-limits-and-resume)

[Validación del paquete](release-checklist.md)
