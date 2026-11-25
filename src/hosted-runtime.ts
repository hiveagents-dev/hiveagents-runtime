/** Worker-side semantic proxies. This module creates no process or Host authority. */
export type * from './hosted/types.js';
export { hostedDigest } from './hosted/json.js';
export { captureHostedDescriptor, captureHostedRequest, captureHostedReply } from './hosted/validation.js';
export { createHostedRuntime, createHostedRunRuntime } from './hosted/runtime.js';
/** The matcher a hosted worker runs before a turn leaves it; public so a Host can check the recipes it issues. */
export { createRecipeMatcher } from './hosted/recipes.js';

export { withHostedTurnIntent } from './hosted/intent.js';
