import { inboxCardLines, inboxCardTitle, inboxClock, inboxHeadline, inboxNotice, inboxOutcomeLine, type InboxClock, type InboxNames } from './text.js';
import type { InboxCard, InboxOutcome, InboxView } from './types.js';

/**
 * The decision inbox as markup, as one string. Every value that comes from outside this file
 * goes through `escapeInboxHtml`, in text and in attributes alike.
 *
 * The buttons carry what the main process needs to answer: `data-inbox-approve` holds the request
 * id together with `data-action-hash`, the hash of the action shown on that card, and
 * `data-inbox-reject` holds the request id. An approval that was not used yet keeps a
 * `data-inbox-reject` button in the list of outcomes, so the person can take it back.
 */

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeInboxHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export interface InboxRenderOptions {
  clock?: InboxClock;
  names?: InboxNames;
}

function renderCard(card: InboxCard, now: number, clock: InboxClock, names: InboxNames): string {
  const id = escapeInboxHtml(card.requestId);
  const values = card.fields.map((field) => `<dt>${escapeInboxHtml(field.label)}</dt><dd>${escapeInboxHtml(field.value)}</dd>`).join('');
  const lines = inboxCardLines(card, now, clock).map((line) => `<p class="detail">${escapeInboxHtml(line)}</p>`).join('');
  return `<article class="card" data-request="${id}" data-system="${escapeInboxHtml(card.systemId)}">`
    + `<h3>${escapeInboxHtml(inboxCardTitle(card, names))}</h3>`
    + `<dl>${values}</dl>${lines}`
    + '<p class="actions">'
    + `<button type="button" data-inbox-approve="${id}" data-action-hash="${escapeInboxHtml(card.actionHash)}">Aprobar</button>`
    + `<button type="button" data-inbox-reject="${id}">Rechazar</button>`
    + '</p></article>';
}

function renderOutcome(outcome: InboxOutcome, clock: InboxClock, names: InboxNames): string {
  const values = outcome.fields.map((field) => `${field.label}: ${field.value}`).join(' · ');
  const summary = values.length === 0 ? '' : ` ${escapeInboxHtml(values)}.`;
  const takeBack = outcome.status === 'approved'
    ? ` <button type="button" data-inbox-reject="${escapeInboxHtml(outcome.requestId)}">Retirar aprobación</button>`
    : '';
  return `<li data-status="${escapeInboxHtml(outcome.status)}"><strong>${escapeInboxHtml(inboxCardTitle(outcome, names))}</strong>`
    + `${summary} ${escapeInboxHtml(inboxOutcomeLine(outcome, clock))}${takeBack}</li>`;
}

function notice(text: string): string {
  return `<p class="notice">${escapeInboxHtml(text)}</p>`;
}

/** The whole inbox: what waits for the person, in one list, and the latest outcomes below it. */
export function renderInbox(view: InboxView, now: number, options: InboxRenderOptions = {}): string {
  if (!view.ok) return `<h2>Decisiones</h2>${notice(inboxNotice(view.reason))}`;
  const clock = options.clock ?? inboxClock(now);
  const names = options.names ?? {};
  const parts = [`<h2>${escapeInboxHtml(inboxHeadline(view))}</h2>`];
  if (view.pendingTotal > view.pending.length) {
    parts.push(notice(`Se muestran ${view.pending.length} de ${view.pendingTotal}. Las demás aparecen a medida que respondés.`));
  }
  if (view.damaged === 1) parts.push(notice('1 pedido guardado está dañado y no se muestra.'));
  if (view.damaged > 1) parts.push(notice(`${view.damaged} pedidos guardados están dañados y no se muestran.`));
  if (view.pending.length > 0) {
    parts.push(`<div class="cards">${view.pending.map((card) => renderCard(card, now, clock, names)).join('')}</div>`);
    parts.push('<p class="hint">Cada aprobación vale una sola vez, solo para la acción exacta que ves y por tiempo limitado.</p>');
  }
  if (view.recent.length > 0) {
    parts.push(`<h3>Últimas respuestas</h3><ul class="outcomes">${view.recent.map((outcome) => renderOutcome(outcome, clock, names)).join('')}</ul>`);
  }
  return parts.join('');
}
