# HiveAgents Runtime

**Un SDK TypeScript para ejecutar los CLI de IA que ya usás.** HiveAgents Runtime conecta Claude Code, Codex, Gemini CLI y Antigravity CLI desde un paquete. Tu aplicación define el trabajo, los permisos y los criterios que debe cumplir. El SDK selecciona un candidato, ejecuta el turno y devuelve evidencia para inspeccionar el resultado.

Beta para proyectos ESM con Node.js 22.16 o superior. macOS es la plataforma de referencia. Los turnos comerciales usan la autenticación y el servicio de tu CLI. [Notas de la beta](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/releases/0.1.0-beta.5.md)

## Primer turno sin credenciales

```sh
mkdir hiveagents-quickstart
cd hiveagents-quickstart
npm init -y
npm install hiveagents-runtime@beta
node node_modules/hiveagents-runtime/docs/examples/quickstart-offline.mjs
```

El SDK ejecuta un contador local y verifica la salida. Deberías ver `{"status":"completed","words":3,"model":"local-counter/words"}`. [Ejemplo ejecutable](docs/examples/quickstart-offline.mjs)

## Usá tu CLI

Ejecutá `npx --no-install hiveagents-runtime doctor --share` para consultar instalación, autenticación y transportes. Si tenés Claude Code autenticado, guardá este archivo como `run.mjs`.

```js
import { Agent } from 'hiveagents-runtime';

const agent = new Agent({
  model: 'opus-5',
  transport: 'exec',
  context: { profile: 'clean', memory: 'off' },
  permissions: { mode: 'respond' },
  environment: { mode: 'minimal' },
  instructions: 'Contestá en una oración.',
  providerOptions: { claude: { systemPromptMode: 'replace', tools: [] } },
});

try {
  const turn = await agent.run('Definí un tablero Kanban.', { timeoutMs: 60_000, awaitSettlement: true });
  console.log(turn.status, turn.text);
} finally {
  await agent.close();
}
```

Ejecutá `node run.mjs`. Para otros proveedores elegí un perfil que corresponda al transporte y los permisos del CLI. El diagnóstico inspecciona la configuración. Un turno real verifica la combinación de proveedor, CLI, cuenta y modelo. [Guía de integración](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/integration-guide.md) · [Matriz de capacidades](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/capability-matrix.md)

## Selección, memoria y recuperación

- **Selección automática.** Pedí `model: { mode: 'auto' }` a `createAgent` para seleccionar desde los catálogos registrados. Los filtros de instalación, autenticación, permisos y política se aplican antes de ejecutar. Cada decisión incluye un recibo. [Routing](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/src/routing/README.md)
- **Aprendizaje.** Configurá `LearningRouter` con observaciones verificadas y casos reservados. Cada perfil conserva su contrato de permisos y la promoción exige una mejora medida. [Aprendizaje de modelos](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/src/routing/learning/README.md)
- **Memoria y workflows.** Recuperá contexto por ámbito, guardá checkpoints, compará evaluaciones y coordiná trabajo con cupos. [Orquestación y memoria](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/orchestration.md)
- **Tutorial de escritorio.** Seguí a un planificador, un redactor y un revisor desde un tablero Electron. El tutorial incluye un asistente de tablero, memoria local y laboratorios para las once entradas públicas. [Kanban y laboratorios](https://github.com/hiveagents-dev/kanban-tutorial)

## Proyecto

- [Arquitectura](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/architecture.md)
- [Módulos y evidencia](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/modules.md)
- [Versiones de CLI comprobadas](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/compatibility.md)
- [Límites de ejecución](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/runtime-execution-boundaries.md)
- [Contribuir](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/.github/CONTRIBUTING.md) · [Reportar seguridad](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/.github/SECURITY.md)

Apache-2.0. [Licencia](LICENSE)
