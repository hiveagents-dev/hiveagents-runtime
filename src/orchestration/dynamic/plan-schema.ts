import { freeze } from '../../shared/json.js';

/** Hard bounds of a plan, whatever the limits say. */
export const PLAN_BOUNDS = Object.freeze({
  steps: 256,
  phases: 32,
  promptBytes: 32 * 1024,
  schemaBytes: 64 * 1024,
  nameChars: 128,
  descriptionChars: 2000,
  overChars: 256,
});

const STEP_ID_PATTERN = '^[a-z][a-z0-9_-]{0,63}$';

const commonStepProperties = {
  id: { type: 'string', pattern: STEP_ID_PATTERN, description: 'Unique step id; templates name it as steps.<id>.' },
  prompt: {
    type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.promptBytes,
    description: 'The agent instruction. Placeholders: {{args.<path>}}, {{steps.<id>}}, {{steps.<id>.<path>}}; '
      + 'in a map step also {{item}}, {{item.<path>}} and {{index}}. Nothing else may appear inside {{ }}.',
  },
  phase: { type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.nameChars, description: 'One of meta.phases[].title (required when phases are declared).' },
  schema: {
    type: 'object',
    description: 'JSON Schema (draft-07) of the structured result; its root type is object, array, string, number or integer. '
      + 'The keywords pattern, patternProperties and format are refused anywhere in it (use enum, const, minLength, maxLength). '
      + 'Without it the result is the agent text.',
  },
  model: { type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.nameChars, description: 'Only a model the limits allow; omit for the default.' },
  effort: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
  permissions: { type: 'string', enum: ['analyze', 'edit'], description: 'At most the run ceiling; default analyze.' },
  isolation: { type: 'string', enum: ['none', 'worktree'] },
  timeoutMs: { type: 'integer', minimum: 1, description: 'At most the per-agent timeout limit.' },
} as const;

/** JSON Schema of a `DynamicWorkflowPlan`, for a planner's structured output. `validatePlan` is the authority. */
export const DYNAMIC_PLAN_JSON_SCHEMA: Readonly<Record<string, unknown>> = freeze({
  type: 'object',
  additionalProperties: false,
  required: ['format', 'meta', 'steps'],
  properties: {
    format: { type: 'integer', const: 1 },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.nameChars },
        description: { type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.descriptionChars },
        phases: {
          type: 'array', minItems: 1, maxItems: PLAN_BOUNDS.phases,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title'],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.nameChars },
              detail: { type: 'string', maxLength: PLAN_BOUNDS.descriptionChars },
            },
          },
        },
      },
    },
    steps: {
      type: 'array', minItems: 1, maxItems: PLAN_BOUNDS.steps,
      description: 'A step runs once every step its templates (and over) reference has finished; independent steps run concurrently.',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id', 'prompt'],
            properties: { kind: { type: 'string', const: 'agent' }, ...commonStepProperties },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id', 'over', 'prompt'],
            properties: {
              kind: { type: 'string', const: 'map' },
              ...commonStepProperties,
              over: {
                type: 'string', minLength: 1, maxLength: PLAN_BOUNDS.overChars,
                description: 'args.<path>, steps.<id> or steps.<id>.<path>, resolving to an array; one agent runs per item.',
              },
              maxItems: { type: 'integer', minimum: 1, description: 'Refuse (never truncate) more items than this.' },
            },
          },
        ],
      },
    },
    result: { type: 'string', pattern: STEP_ID_PATTERN, description: 'The step whose output is the result; default the last step.' },
  },
});
