import type { LogProjectionOptions } from './projection-types.js';
import { createLogProjector } from './projection.js';
export function createLogAuditProjector(options: LogProjectionOptions) { return createLogProjector('audit', options); }
