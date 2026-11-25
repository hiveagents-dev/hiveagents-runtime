# Selección que aprende con resultados verificados

`hiveagents-runtime/routing/learning` es un módulo opcional para Node >=22.16.
No llama a un servicio de ruteo ni requiere otro modelo para decidir.
Cada proveedor sigue ejecutándose con su adaptador, autenticación y permisos.

Una definición puede fijar `model: 'codex/gpt-5.6-sol'` o declarar candidatos:

```ts
import type { LearningDefinition } from 'hiveagents-runtime/routing/learning';

const definition: LearningDefinition = {
  model: {
    mode: 'auto',
    candidates: [
      { id: 'sol', model: 'codex/gpt-5.6-sol', effort: 'low' },
      { id: 'sonnet', model: 'claude/claude-sonnet-5', effort: 'low' },
    ],
    allowUnverifiedModels: true,
  },
  transport: 'exec',
  requireAuth: 'subscription',
  permissions: { mode: 'analyze' },
};
```

Los IDs son ejemplos; la disponibilidad efectiva depende del CLI y la cuenta.
`allowUnverifiedModels` permite un ID sin catálogo verificado, pero no evita las
comprobaciones de instalación, autenticación, capacidades, permisos e identidad.
Un cambio de modelo, esfuerzo, ejecución o definición exige evidencia compatible.

## Perfiles por candidato y salida estructurada

La aplicación puede declarar perfiles por proveedor. Los candidatos sólo nombran
perfiles existentes de su propio proveedor. Los perfiles admiten contexto, permisos
y opciones de ese proveedor. Los campos compartidos de la definición conservan
su autoridad. Si un perfil intenta reemplazar contexto, permisos u opciones de
proveedor declarados en la definición, el SDK rechaza el pedido.

```ts
const definition: LearningDefinition = {
  model: {
    mode: 'auto',
    candidates: [
      { id: 'sol', model: 'codex/gpt-5.6-sol', profile: 'codex' },
      { id: 'sonnet', model: 'claude/claude-sonnet-5', profile: 'claude' },
    ],
    allowUnverifiedModels: true,
  },
  profiles: {
    codex: {
      provider: 'codex',
      permissions: { mode: 'analyze', minimumEnforcement: 'sandbox' },
      context: { profile: 'native', memory: 'off' },
      providerOptions: { codex: {
        skipGitRepoCheck: true, ignoreRules: true, ignoreUserConfig: true, ephemeral: true,
      } },
    },
    claude: {
      provider: 'claude',
      permissions: { mode: 'respond' },
      context: { profile: 'clean', memory: 'off' },
      providerOptions: { claude: { systemPromptMode: 'replace', tools: [] } },
    },
  },
  transport: 'exec',
  requireAuth: 'subscription',
  environment: { mode: 'minimal' },
  instructions: 'Extraé el resultado solicitado en el formato indicado.',
  outputSchema: {
    type: 'object',
    properties: { result: { type: 'string' } },
    required: ['result'],
    additionalProperties: false,
  },
};
```

Usá la misma definición para preflight, entrenamiento y evaluación. El SDK liga
el esquema a la identidad de la selección y a cada candidato medido. Un contrato
distinto separa las observaciones y requiere su propia evaluación. `router.run`
entrega al verificador un `turn.output` que pasó el esquema nativo. El verificador
comprueba el contenido según los criterios de la tarea. `createAgent` devuelve
un agente ordinario y un recibo de selección.

Si la selección se abstiene, el error público `LearningSelectionError` incluye el
recibo. Para decidir un fallback, exigí `code === 'NO_ROUTE'`,
`receipt.reason === 'NO_ROUTE'`, candidato ausente y
`receipt.nativeDispatches === 0`. Un fallo después de despachar pertenece al
turno y la aplicación debe reconciliarlo antes de volver a ejecutar.

## Integración

```ts
import { LearningRouter, SqliteLearningStore, inputDigest,
  type LearningDomain, type LearningTask } from 'hiveagents-runtime/routing/learning';
import type { Runtime } from 'hiveagents-runtime';
import type { ObservedTaskBudget } from 'hiveagents-runtime/orchestration';

function application(runtime: Runtime, domain: LearningDomain, budget: ObservedTaskBudget) {
  const store = new SqliteLearningStore('/absolute/private/state/evidence.sqlite');
  const router = new LearningRouter({ store, domain, policy: { objective: 'quality' } });

  return {
    async execute(text: string, id: string,
      verify: (output: string) => { value: number; passed: boolean }) {
      const task: LearningTask = { id, version: '1', text, inputDigest: inputDigest(text) };
      return router.run(definition, { runtime, task, input: text, budget,
        timeoutMs: 60_000, verify: turn => verify(turn.text) });
    },
    close: () => store.close(),
  };
}
```

La app aporta `domain.sourceDigest`, `scorerDigest` y `protocolDigest`: hashes
SHA-256 de su build, verificador y protocolo de medición. Cambiarlos separa la
evidencia. El verificador debe ser independiente de la respuesta del agente:
tests ejecutables, etiquetas humanas o comprobaciones contra un resultado conocido.
`value` debe estar en [0,1]; `passed` indica si satisface el criterio de aceptación.
La app aporta también el presupuesto; cada intento obtiene una reserva antes de
ejecutar y la libera tras el cierre real del proveedor.
Un ciclo que congela candidatos puede pasar `expectedBinding` a `router.run`.
Contiene `definitionDigest`, acciones/fallback y esquema/dimensiones de features
congelados desde su preflight. El SDK lo captura antes de esperar y lo compara
con el universo preparado después de adquirir presupuesto, antes de crear el
intento durable o enviar un turno. Así, una actualización del CLI o una pérdida
de disponibilidad durante la admisión no ejecuta trabajo bajo otra identidad.

## Qué aprende y cuándo cambia

1. Los filtros eliminan candidatos que no puedan ejecutar la solicitud. Sin
   política aprobada se usa el primer candidato elegible, o el fallback declarado.
2. Cada ejecución guarda primero un intento durable y luego un resultado terminal
   con calidad verificada, latencia, uso disponible e identidad de ejecución.
   Un fallo, interrupción o identidad incompatible conserva calidad desconocida.
3. Las observaciones de entrenamiento actualizan una propuesta inmutable
   (`shadow`). El estimador usa similitud local del contexto, resultados por
   candidato y antigüedad. Repetir el mismo texto no aumenta el soporte independiente.
4. La propuesta sólo pasa a ser activa al superar un gate sobre una matriz
   prospectiva completa de tareas de regresión y tareas nuevas: todos los brazos
   configurados se ejecutan realmente. Los conjuntos protegidos no entrenan.
5. La promoción exige mejora medida, suficientes tareas nuevas, prueba de signos
   y ausencia de regresión por tarea. El cambio es transaccional y condicionado a
   la generación esperada. Si no alcanza la evidencia conserva el incumbente.
   Un rollback usa el mismo protocolo, incluida nueva evidencia.

El objetivo puede ser `quality`, `latency` o `cost`. Velocidad y costo sólo se
comparan cuando la calidad supera el piso y la métrica es conocida y comparable.
No se convierte costo desconocido en cero ni se mezclan importes de significados
distintos. Los límites de confianza por vecinos son heurísticas conservadoras;
no son probabilidades calibradas ni una garantía de optimalidad.

Las features por defecto son n-gramas de texto con hashing, calculadas localmente.
Se pueden aportar vectores propios con `task.features: { schema, values }`;
su esquema y dimensiones quedan vinculados a la política. No se usa el nombre
comercial del modelo como evidencia de que resuelve mejor una tarea.

## Ciclo continuo y evidencia

`run` acumula feedback y genera shadow automáticamente. La app puede pasar un
hook `maintenance` que reserve nuevos episodios, recolecte sus matrices y llame
`router.improve({ id, freshEpisodeId })`. Se ejecuta después de liberar la reserva
del turno y nunca recursivamente desde las matrices. Todo trabajo adicional debe
usar un presupuesto explícito de la app. El fallo del mantenimiento se informa
por separado sin convertir una respuesta ya verificada en un fallo del proveedor.
El hook recibe `{ signal }` y tiene un plazo propio mediante
`maintenanceTimeoutMs` (30 segundos por defecto). Debe propagar esa señal a sus
operaciones y terminar su limpieza; el router espera su finalización real. La
cancelación explícita del llamador continúa deteniendo el ciclo.

`router.inspect()` y los registros de SQLite sobreviven a reinicios. Una llamada
a `createAgent` produce un recibo de selección y no entrena por sí sola. Un
intento pendiente tras un crash no es un resultado ni se reejecuta silenciosamente.
La evidencia persiste hashes, features y métricas, sin guardar el texto original.
La base debe quedar bajo control de la aplicación; el ledger no concede permisos.

Para un CLI que delega, como un esfuerzo Ultra, un brazo puede declarar
`evidenceScope: 'requested-system'`. Se evalúa entonces el sistema solicitado
completo, conservando los modelos observados. La evidencia de ese brazo queda
separada de la de un modelo individual (`'model'`, valor por defecto). No se
atribuye a un solo modelo un resultado producido por otros modelos.

La [app independiente](../../../apps/document-triage/README.md) implementa el ciclo,
los presupuestos, los oráculos y los episodios completos. `npm run verify:learning`
valida promoción, selección contextual, reinicio y rollback con fixtures desde
el SDK instalado fuera del checkout. Esa prueba valida la mecánica;
una comparación real de modelos requiere ejecutar y publicar sus propias medidas.
