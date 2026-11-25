import type { ValidateFunction } from 'ajv';
import { compileOutputSchema } from '../core/schema.js';
import { UnsupportedCapabilityError } from '../public/errors.js';
import type { TurnOptions } from '../public/types.js';
import { validateSettlementOption } from '../control/exec-settlement.js';
import type { SessionConfig } from './config.js';
import { requireExecFeature } from './exec-turn.js';

export function structuredOutputValidator(config: SessionConfig, options: TurnOptions): ValidateFunction | undefined {
  validateSettlementOption(options.awaitSettlement);
  if (options.awaitSettlement && config.control) throw new UnsupportedCapabilityError(
    { provider: config.adapter.id, transport: 'control', retryable: false },
    'awaitSettlement is supported only for exec turns',
  );
  if (!options.outputSchema) return undefined;
  if (config.control && config.negotiated?.structuredOutput?.support !== 'full') {
    throw new UnsupportedCapabilityError(
      { provider: config.adapter.id, transport: 'control', retryable: false },
      'This control transport has no verified structured-output channel',
    );
  }
  if (!config.control) requireExecFeature(config, 'structuredOutput');
  return compileOutputSchema(options.outputSchema);
}
