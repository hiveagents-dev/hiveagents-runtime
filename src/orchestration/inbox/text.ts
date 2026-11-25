import { inboxPlainText } from './card.js';
import type { InboxCard, InboxOutcome, InboxResult, InboxView } from './types.js';

/**
 * Every sentence the decision inbox shows, in the words of the person who answers it.
 * Pure functions: data in, text out. Nothing here is written by a model, and text that came from
 * a system is only ever placed as a value, after `inboxPlainText`.
 */

/** Turns an instant into the short text shown for it. */
export type InboxClock = (at: number) => string;

/** Display names the console knows. Anything missing is shown by its identifier. */
export interface InboxNames {
  /** System id to the name the person knows it by. */
  systems?: Readonly<Record<string, string>>;
  /** Action kind to a verb phrase that completes "X quiere …", for example "enviar un email". */
  actions?: Readonly<Record<string, string>>;
}

/** The hour and minute, with day and month when the instant is not on the same day as `now`. */
export function inboxClock(now: number = Date.now()): InboxClock {
  const time = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'numeric' });
  const today = day.format(now);
  return (at) => (day.format(at) === today ? time.format(at) : `${day.format(at)} ${time.format(at)}`);
}

function known(names: Readonly<Record<string, string>> | undefined, key: string): string | undefined {
  return names !== undefined && Object.hasOwn(names, key) ? names[key] : undefined;
}

export function inboxSystemName(systemId: string, names: InboxNames = {}): string {
  return known(names.systems, systemId) ?? inboxPlainText(systemId);
}

/** "Grow quiere enviar un email", or the plain identifiers when no name is known. */
export function inboxCardTitle(card: Pick<InboxCard, 'systemId' | 'actionKind'>, names: InboxNames = {}): string {
  const system = inboxSystemName(card.systemId, names);
  const action = known(names.actions, card.actionKind);
  return action === undefined ? `${system} quiere hacer esto: ${inboxPlainText(card.actionKind)}` : `${system} quiere ${action}`;
}

export function inboxHeadline(view: Extract<InboxView, { ok: true }>): string {
  const waiting = view.pendingTotal;
  if (waiting === 0) return 'Nada espera tu decisión';
  const systems = new Set(view.pending.map((card) => card.systemId)).size;
  const count = waiting === 1 ? '1 decisión espera tu respuesta' : `${waiting} decisiones esperan tu respuesta`;
  return systems > 1 ? `${count}, de ${systems} sistemas` : count;
}

/** The lines under a card's values: when it was asked, when it expires, what is hidden or cut. */
export function inboxCardLines(card: InboxCard, now: number, clock: InboxClock = inboxClock(now)): string[] {
  const lines = [`Lo pidió a las ${clock(card.requestedAt)}.`];
  if (card.expiresAt !== null) lines.push(`Si no respondés antes de las ${clock(card.expiresAt)}, vence sola y no se hace.`);
  if (card.hiddenFields === 1) lines.push('Esta acción lleva 1 dato más que no se muestra acá.');
  if (card.hiddenFields > 1) lines.push(`Esta acción lleva ${card.hiddenFields} datos más que no se muestran acá.`);
  if (card.cutFields === 1) lines.push('1 de los datos que ves está cortado: es más largo de lo que entra acá.');
  if (card.cutFields > 1) lines.push(`${card.cutFields} de los datos que ves están cortados: son más largos de lo que entra acá.`);
  return lines;
}

export function inboxOutcomeLine(outcome: InboxOutcome, clock: InboxClock = inboxClock()): string {
  const at = clock(outcome.at);
  switch (outcome.status) {
    case 'approved':
      return outcome.approvalExpiresAt === null
        ? `Aprobada a las ${at}. Todavía no se usó.`
        : `Aprobada a las ${at}. Todavía no se usó; si no se usa antes de las ${clock(outcome.approvalExpiresAt)}, vence sola.`;
    case 'consumed':
      return `Usada a las ${at}. Esa aprobación ya no sirve para otra vez.`;
    case 'rejected': {
      const what = outcome.wasApproved ? `Retiraste la aprobación a las ${at}, antes de que se usara.` : `Rechazada a las ${at}.`;
      return outcome.note === undefined ? what : `${what} Motivo: «${inboxPlainText(outcome.note)}».`;
    }
    case 'expired':
      return outcome.wasApproved ? `La aprobación venció a las ${at} sin usarse.` : `Venció a las ${at} sin hacerse.`;
    case 'withdrawn':
      return `El sistema la retiró a las ${at}.`;
  }
}

/** Why the inbox cannot be shown. */
export function inboxNotice(reason: Extract<InboxView, { ok: false }>['reason']): string {
  if (reason === 'absent') return 'Todavía ningún sistema pidió una decisión en esta Mac.';
  if (reason === 'unrecognized') return 'El archivo de la bandeja no es el esperado, así que no se muestra nada de él.';
  return 'No se pudo leer la bandeja en este momento.';
}

/** What to tell the person right after they approved, rejected or took an approval back. */
export function inboxDecisionSentence(
  result: InboxResult<{ status: 'approved' | 'rejected'; approvalExpiresAt?: number | null; wasApproved?: boolean }>,
  clock: InboxClock = inboxClock(),
): string {
  if (result.ok) {
    if (result.status === 'rejected') {
      return result.wasApproved ? 'Aprobación retirada. El sistema ya no puede usarla.' : 'Rechazada. El sistema no va a hacerla.';
    }
    return typeof result.approvalExpiresAt === 'number'
      ? `Aprobada. Vale una sola vez, solo para esa acción exacta y hasta las ${clock(result.approvalExpiresAt)}.`
      : 'Aprobada. Vale una sola vez y solo para esa acción exacta.';
  }
  switch (result.reason) {
    case 'already-used':
      return 'Esa aprobación ya se había usado: el sistema ya empezó a hacer la acción.';
    case 'expired':
      return 'Ya había vencido. No se aprobó nada.';
    case 'not-pending':
      return 'Ya no estaba pendiente: alguien la respondió antes o el sistema la retiró.';
    case 'action-changed':
      return 'La acción guardada no es la que estabas viendo. No se aprobó nada: volvé a abrir la bandeja.';
    case 'integrity':
      return 'El pedido guardado está dañado y no se puede responder.';
    case 'unknown-request':
      return 'Ese pedido ya no está en la bandeja.';
    default:
      return 'No se pudo guardar tu respuesta. Probá de nuevo.';
  }
}
