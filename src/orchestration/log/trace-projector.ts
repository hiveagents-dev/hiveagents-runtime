import type { LogProjectionOptions } from './projection-types.js';
import { createLogProjector } from './projection.js';
export function createLogTraceProjector(options: LogProjectionOptions) { return createLogProjector('trace', options); }
