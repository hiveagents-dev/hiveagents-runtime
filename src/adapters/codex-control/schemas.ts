import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

import envelopeSchema from './schemas/JSONRPCMessage.json';
import serverRequestExperimentalSchema from './schemas/ServerRequest.experimental.json';
import serverRequestStableSchema from './schemas/ServerRequest.stable.json';

export type CodexSchemaVariant = 'stable' | 'experimental';

export const PINNED_CODEX_CLI_VERSION = '0.149.0';

export interface FrameValidation {
  valid: boolean;
  errors?: ErrorObject[];
}

// The pinned schemas are generated draft-07 artifacts that use non-standard
// formats such as int64/uint32, which Ajv strict mode rejects.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

const validateEnvelopeFn: ValidateFunction = ajv.compile(envelopeSchema);
const serverRequestValidators: Record<CodexSchemaVariant, ValidateFunction> = {
  stable: ajv.compile(serverRequestStableSchema),
  experimental: ajv.compile(serverRequestExperimentalSchema),
};

function extractServerRequestMethods(schema: Record<string, unknown>): ReadonlySet<string> {
  const methods = new Set<string>();
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  for (const variant of variants) {
    const properties = (variant as { properties?: { method?: { const?: unknown; enum?: unknown[] } } }).properties;
    const method = properties?.method;
    if (typeof method?.const === 'string') methods.add(method.const);
    for (const value of method?.enum ?? []) {
      if (typeof value === 'string') methods.add(value);
    }
  }
  return methods;
}

const serverRequestMethodSets: Record<CodexSchemaVariant, ReadonlySet<string>> = {
  stable: extractServerRequestMethods(serverRequestStableSchema),
  experimental: extractServerRequestMethods(serverRequestExperimentalSchema),
};

export function serverRequestMethods(variant: CodexSchemaVariant): ReadonlySet<string> {
  return serverRequestMethodSets[variant];
}

export function isServerRequestMethod(method: string, variant: CodexSchemaVariant): boolean {
  return serverRequestMethodSets[variant].has(method);
}

export function validateEnvelope(frame: unknown): FrameValidation {
  if (validateEnvelopeFn(frame)) return { valid: true };
  return { valid: false, errors: validateEnvelopeFn.errors ?? [] };
}

export function validateServerRequestFrame(frame: unknown, variant: CodexSchemaVariant): FrameValidation {
  const validate = serverRequestValidators[variant];
  if (validate(frame)) return { valid: true };
  return { valid: false, errors: validate.errors ?? [] };
}
