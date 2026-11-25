# Pruebas con proveedores

## Control

El 24 de septiembre de 2026, en macOS con Node 22.23.2, se comprobaron la inicialización, el cierre y dos turnos con continuidad de sesión en Claude Code 2.1.228 con Claude Agent SDK 0.3.252 y Codex CLI 0.153.4. La prueba usó credenciales de suscripción y directorios temporales. Se probaron sin inferencia la apertura del transporte y su cierre. Los turnos de conversación son evidencia de esas versiones y operaciones.

El tutorial documenta recorridos posteriores de herramientas de aplicación y decisiones nativas con Claude y Codex. Consultá el detalle de cada capacidad antes de habilitarla. [Aprobaciones nativas](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/labs/native-approval.md) · [Matriz de capacidades](../capability-matrix.md)

## Gemini

El 8 de noviembre de 2026, Gemini CLI 0.56.0 devolvió `UNSUPPORTED_CLIENT` al intentar usar Gemini Code Assist vía OAuth local. Se lanzaron cuatro intentos y quedaron pendientes las comprobaciones vivas de ese perfil.

El 23 de noviembre se verificó otro perfil con Vertex AI. Gemini CLI 0.56.0 y `gemini-3.7-flash` completaron envío y reanudación entre procesos con la beta.3. El canario esperado permaneció ausente durante la corrida. [Receta de Gemini](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/labs/gemini.md) · [Evidencia de Vertex AI](https://github.com/hiveagents-dev/kanban-tutorial/blob/v1.5.0/evidence/gemini-live.json)
