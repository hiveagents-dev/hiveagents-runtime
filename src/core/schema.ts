import Ajv, { type ValidateFunction } from 'ajv';

import { StructuredOutputError } from '../public/errors.js';
import type { Usage } from '../public/types.js';

export function compileOutputSchema(schema: Record<string, unknown>): ValidateFunction {
  try {
    // A fresh compiler per schema: a shared one registers every `$id` it sees process-wide, so a later turn
    // whose schema reuses that `$id` (another object, same id) would fail to compile.
    return new Ajv({ allErrors: true, strict: true }).compile(schema);
  } catch (cause) {
    throw new StructuredOutputError(
      {
        retryable: false,
        sanitizedDiagnostics: {
          schemaError: cause instanceof Error ? cause.message : String(cause),
        },
      },
      'Invalid JSON Schema',
    );
  }
}

export function validateOutput(validate: ValidateFunction, output: unknown, observedUsage?: Usage): void {
  if (validate(output)) return;
  throw new StructuredOutputError(
    {
      retryable: false,
      ...(observedUsage === undefined ? {} : { observedUsage: structuredClone(observedUsage) }),
      sanitizedDiagnostics: {
        validationErrors: validate.errors,
        originalResponse: output,
      },
    },
    'Provider response did not match the requested JSON Schema',
  );
}
