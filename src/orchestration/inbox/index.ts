/**
 * The machine's one decision inbox: every system files what needs a person here, the person
 * answers once, and each approval serves exactly one use of the exact action it was given for.
 */
export { SystemInbox, OwnerInbox, hostInboxPath, inboxBellPath } from './inbox.js';
export { inboxActionHash } from './action.js';
export { readInboxView, readInboxItem } from './view.js';
export { inboxCard, inboxCardFields, inboxDisplayValue, inboxPlainText } from './card.js';
export { inboxClock, inboxSystemName, inboxCardTitle, inboxHeadline, inboxCardLines, inboxOutcomeLine, inboxNotice, inboxDecisionSentence } from './text.js';
export type { InboxClock, InboxNames } from './text.js';
export { renderInbox, escapeInboxHtml } from './render.js';
export type { InboxRenderOptions } from './render.js';
export type * from './types.js';
