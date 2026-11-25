import { describe, expect, test } from 'vitest';
import {
  escapeInboxHtml, inboxCardFields, inboxCardLines, inboxCardTitle, inboxClock, inboxDecisionSentence, inboxDisplayValue,
  inboxHeadline, inboxNotice, inboxOutcomeLine, renderInbox,
} from '../../src/orchestration/inbox/index.js';
import type { InboxCard, InboxOutcome, InboxView } from '../../src/orchestration/inbox/index.js';

const NOW = 1_800_000_000_000;
/** A clock that does not depend on the machine's time zone: minutes since `NOW`. */
const clock = (at: number) => {
  const minutes = Math.round((at - NOW) / 60_000);
  return minutes < 0 ? `${minutes}min` : `+${minutes}min`;
};
const names = { systems: { grow: 'Grow', marketing: 'Marketing' }, actions: { 'email.send': 'enviar un email' } };

function card(overrides: Partial<InboxCard> = {}): InboxCard {
  return {
    requestId: 'req-1',
    systemId: 'grow',
    actionKind: 'email.send',
    actionHash: 'a'.repeat(64),
    requestedAt: NOW - 120_000,
    requestedBy: 'grow:run-1',
    expiresAt: null,
    fields: [{ label: 'Para', value: 'ana@example.com' }, { label: 'Asunto', value: 'Propuesta' }],
    hiddenFields: 0,
    cutFields: 0,
    ...overrides,
  };
}

function outcome(status: InboxOutcome['status'], overrides: Partial<InboxOutcome> = {}): InboxOutcome {
  const wasApproved = status === 'approved' || status === 'consumed';
  return { ...card(), status, at: NOW - 60_000, by: 'owner', wasApproved, approvalExpiresAt: wasApproved ? NOW + 3_540_000 : null, ...overrides };
}

function view(pending: InboxCard[], recent: InboxOutcome[] = [], pendingTotal = pending.length): Extract<InboxView, { ok: true }> {
  return { ok: true, readAt: NOW, pending, pendingTotal, recent, damaged: 0 };
}

describe('card values are data', () => {
  test('each kind of value reads plainly', () => {
    expect(inboxDisplayValue('ana@example.com')).toBe('ana@example.com');
    expect(inboxDisplayValue(1500)).toBe('1500');
    expect(inboxDisplayValue(true)).toBe('sí');
    expect(inboxDisplayValue(false)).toBe('no');
    expect(inboxDisplayValue(null)).toBe('(vacío)');
    expect(inboxDisplayValue('   ')).toBe('(vacío)');
    expect(inboxDisplayValue(['a', 'b'])).toBe('["a","b"]');
    expect(inboxDisplayValue({ plan: 'pro' })).toBe('{"plan":"pro"}');
  });

  test('line breaks, control characters and invisible direction marks cannot reshape a card', () => {
    expect(inboxDisplayValue('Hola\n\nAPROBADO POR EL DUEÑO\t\x00fin')).toBe('Hola APROBADO POR EL DUEÑO fin');
    expect(inboxDisplayValue('factura\u202efdp.exe')).toBe('facturafdp.exe');
    expect(inboxDisplayValue('a\u200bb\u2066c')).toBe('abc');
    // Letters that draw as blank space, and the soft hyphen, cannot pad or split a value either.
    expect(inboxDisplayValue('a\u3164\u3164b\u00adc\u2800d')).toBe('abcd');
    expect(inboxDisplayValue('\u3164\u115f')).toBe('(vacío)');
  });

  test('a long value is cut and says so', () => {
    const shown = inboxDisplayValue('x'.repeat(1_000));
    expect(shown).toHaveLength(240);
    expect(shown.endsWith('…')).toBe(true);
  });

  test('values come from the payload at the named place; the rest is counted, not shown', () => {
    const payload = { to: 'ana@example.com', attachments: [{ name: 'propuesta.pdf' }], body: 'texto largo', internal: 7 };
    const built = inboxCardFields(payload, [{ label: 'Para', path: ['to'] }, { label: 'Adjunto', path: ['attachments', '0', 'name'] }]);
    expect(built.fields).toEqual([{ label: 'Para', value: 'ana@example.com' }, { label: 'Adjunto', value: 'propuesta.pdf' }]);
    expect(built.hiddenFields).toBe(2);
  });

  test('a line that points inside a nested value shows only that value: everything beside it is counted as hidden', () => {
    const cc = Array.from({ length: 500 }, (_unused, index) => `cc${index}@example.com`);
    const recipients = Array.from({ length: 901 }, (_unused, index) => (index === 0 ? 'ana@example.com' : `r${index}@example.com`));
    const payload = { message: { to: 'ana@example.com', cc, body: 'Hola' }, recipients };
    const built = inboxCardFields(payload, [{ label: 'Para', path: ['message', 'to'] }, { label: 'Destinatario', path: ['recipients', '0'] }]);
    expect(built.fields).toEqual([{ label: 'Para', value: 'ana@example.com' }, { label: 'Destinatario', value: 'ana@example.com' }]);
    // 500 copies, the body and the other 900 recipients are part of what gets approved.
    expect(built.hiddenFields).toBe(1_401);
    expect(inboxCardLines(card({ ...built }), NOW, clock)).toContain('Esta acción lleva 1401 datos más que no se muestran acá.');
  });

  test('hidden values are counted once however the lines overlap, and empty lists or groups count as one value', () => {
    const payload = { message: { to: 'a', cc: ['b', 'c'] }, tags: [], options: {}, note: null };
    expect(inboxCardFields(payload, [{ label: 'Mensaje', path: ['message'] }, { label: 'Para', path: ['message', 'to'] }]).hiddenFields).toBe(3);
    expect(inboxCardFields(payload, [{ label: 'Copia', path: ['message', 'cc', '1'] }]).hiddenFields).toBe(5);
    expect(inboxCardFields(payload, [{ label: 'Etiquetas', path: ['tags'] }, { label: 'Opciones', path: ['options'] }, { label: 'Nota', path: ['note'] }]).hiddenFields).toBe(3);
  });

  test('a value too long to show in full is marked as cut, and the card says how many are', () => {
    const recipients = Array.from({ length: 901 }, (_unused, index) => `r${index}@example.com`);
    const built = inboxCardFields({ recipients, to: 'ana@example.com' }, [{ label: 'Destinatarios', path: ['recipients'] }, { label: 'Para', path: ['to'] }]);
    expect(built.fields[0]).toMatchObject({ label: 'Destinatarios', cut: true });
    expect(built.fields[1]).toEqual({ label: 'Para', value: 'ana@example.com' });
    expect(built.hiddenFields).toBe(0);
    expect(built.cutFields).toBe(1);
    expect(inboxCardLines(card({ ...built }), NOW, clock)).toContain('1 de los datos que ves está cortado: es más largo de lo que entra acá.');
    expect(inboxCardLines(card({ cutFields: 2 }), NOW, clock)).toContain('2 de los datos que ves están cortados: son más largos de lo que entra acá.');
  });
});

describe('sentences for the person', () => {
  test('the headline counts what waits and from how many systems', () => {
    expect(inboxHeadline(view([]))).toBe('Nada espera tu decisión');
    expect(inboxHeadline(view([card()]))).toBe('1 decisión espera tu respuesta');
    expect(inboxHeadline(view([card(), card({ requestId: 'req-2' })]))).toBe('2 decisiones esperan tu respuesta');
    expect(inboxHeadline(view([card(), card({ requestId: 'req-2', systemId: 'marketing' })]))).toBe('2 decisiones esperan tu respuesta, de 2 sistemas');
    expect(inboxHeadline(view([card()], [], 7))).toBe('7 decisiones esperan tu respuesta');
  });

  test('a card is titled with the system and the action, in known names when there are any', () => {
    expect(inboxCardTitle(card(), names)).toBe('Grow quiere enviar un email');
    expect(inboxCardTitle(card({ systemId: 'crm', actionKind: 'invoice.issue' }), names)).toBe('crm quiere hacer esto: invoice.issue');
    expect(inboxCardTitle(card())).toBe('grow quiere hacer esto: email.send');
  });

  test('a card says when it was asked, when it expires and what it does not show', () => {
    expect(inboxCardLines(card(), NOW, clock)).toEqual(['Lo pidió a las -2min.']);
    expect(inboxCardLines(card({ expiresAt: NOW + 600_000, hiddenFields: 1 }), NOW, clock)).toEqual([
      'Lo pidió a las -2min.',
      'Si no respondés antes de las +10min, vence sola y no se hace.',
      'Esta acción lleva 1 dato más que no se muestra acá.',
    ]);
    expect(inboxCardLines(card({ hiddenFields: 3 }), NOW, clock).at(-1)).toBe('Esta acción lleva 3 datos más que no se muestran acá.');
  });

  test('each outcome says what happened and when', () => {
    expect(inboxOutcomeLine(outcome('approved'), clock)).toBe('Aprobada a las -1min. Todavía no se usó; si no se usa antes de las +59min, vence sola.');
    expect(inboxOutcomeLine(outcome('consumed', { by: 'grow:run-1' }), clock)).toBe('Usada a las -1min. Esa aprobación ya no sirve para otra vez.');
    expect(inboxOutcomeLine(outcome('rejected'), clock)).toBe('Rechazada a las -1min.');
    expect(inboxOutcomeLine(outcome('rejected', { note: 'Todavía\nno' }), clock)).toBe('Rechazada a las -1min. Motivo: «Todavía no».');
    expect(inboxOutcomeLine(outcome('expired', { by: 'inbox:clock' }), clock)).toBe('Venció a las -1min sin hacerse.');
    expect(inboxOutcomeLine(outcome('withdrawn', { by: 'grow:run-1' }), clock)).toBe('El sistema la retiró a las -1min.');
  });

  test('an approval that was taken back or ran out reads differently from a request that was never approved', () => {
    const approvedBefore = { wasApproved: true, approvalExpiresAt: NOW + 3_540_000 };
    expect(inboxOutcomeLine(outcome('rejected', approvedBefore), clock)).toBe('Retiraste la aprobación a las -1min, antes de que se usara.');
    expect(inboxOutcomeLine(outcome('rejected', { ...approvedBefore, note: 'Me arrepentí' }), clock))
      .toBe('Retiraste la aprobación a las -1min, antes de que se usara. Motivo: «Me arrepentí».');
    expect(inboxOutcomeLine(outcome('expired', { ...approvedBefore, by: 'inbox:clock' }), clock)).toBe('La aprobación venció a las -1min sin usarse.');
  });

  test('an inbox that cannot be shown says why, in plain words', () => {
    expect(inboxNotice('absent')).toBe('Todavía ningún sistema pidió una decisión en esta Mac.');
    expect(inboxNotice('unrecognized')).toBe('El archivo de la bandeja no es el esperado, así que no se muestra nada de él.');
    expect(inboxNotice('unavailable')).toBe('No se pudo leer la bandeja en este momento.');
  });

  test('the answer to an approval or a rejection is said back to the person', () => {
    expect(inboxDecisionSentence({ ok: true, status: 'approved', approvalExpiresAt: NOW + 3_600_000 }, clock))
      .toBe('Aprobada. Vale una sola vez, solo para esa acción exacta y hasta las +60min.');
    expect(inboxDecisionSentence({ ok: true, status: 'rejected', wasApproved: false })).toBe('Rechazada. El sistema no va a hacerla.');
    expect(inboxDecisionSentence({ ok: true, status: 'rejected', wasApproved: true })).toBe('Aprobación retirada. El sistema ya no puede usarla.');
    expect(inboxDecisionSentence({ ok: false, reason: 'already-used' })).toBe('Esa aprobación ya se había usado: el sistema ya empezó a hacer la acción.');
    expect(inboxDecisionSentence({ ok: false, reason: 'expired' })).toBe('Ya había vencido. No se aprobó nada.');
    expect(inboxDecisionSentence({ ok: false, reason: 'not-pending' })).toBe('Ya no estaba pendiente: alguien la respondió antes o el sistema la retiró.');
    expect(inboxDecisionSentence({ ok: false, reason: 'action-changed' })).toBe('La acción guardada no es la que estabas viendo. No se aprobó nada: volvé a abrir la bandeja.');
    expect(inboxDecisionSentence({ ok: false, reason: 'integrity' })).toBe('El pedido guardado está dañado y no se puede responder.');
    expect(inboxDecisionSentence({ ok: false, reason: 'unknown-request' })).toBe('Ese pedido ya no está en la bandeja.');
    expect(inboxDecisionSentence({ ok: false, reason: 'storage-unavailable' })).toBe('No se pudo guardar tu respuesta. Probá de nuevo.');
  });

  test('the default clock shows the hour, and the day too when it is not today', () => {
    const local = inboxClock(NOW);
    expect(local(NOW)).toMatch(/^\d{2}:\d{2}$/);
    expect(local(NOW - 3 * 86_400_000)).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  });
});

describe('the inbox as markup', () => {
  test('one list of cards with the buttons bound to the request and the hash that was shown', () => {
    const html = renderInbox(view([card(), card({ requestId: 'req-2', systemId: 'marketing', actionKind: 'post.publish', actionHash: 'b'.repeat(64) })]), NOW, { clock, names });
    expect(html).toContain('<h2>2 decisiones esperan tu respuesta, de 2 sistemas</h2>');
    expect(html.match(/<article class="card"/g)).toHaveLength(2);
    expect(html).toContain('<h3>Grow quiere enviar un email</h3>');
    expect(html).toContain('<dt>Para</dt><dd>ana@example.com</dd>');
    expect(html).toContain(`<button type="button" data-inbox-approve="req-1" data-action-hash="${'a'.repeat(64)}">Aprobar</button>`);
    expect(html).toContain('<button type="button" data-inbox-reject="req-1">Rechazar</button>');
    expect(html).toContain(`data-inbox-approve="req-2" data-action-hash="${'b'.repeat(64)}"`);
    expect(html.indexOf('req-1')).toBeLessThan(html.indexOf('req-2'));
    expect(html).toContain('Cada aprobación vale una sola vez, solo para la acción exacta que ves y por tiempo limitado.');
  });

  test('everything that comes from a system is escaped', () => {
    const hostile = card({
      requestId: 'req"><script>',
      systemId: '<b>grow</b>',
      actionKind: 'email.send"onclick="x',
      fields: [{ label: '<i>Para</i>', value: '<img src=x onerror=alert(1)> & "comillas" \'simples\'' }],
    });
    const html = renderInbox(view([hostile], [outcome('rejected', { note: '<script>alert(1)</script>' })]), NOW, { clock });
    expect(html).not.toMatch(/<script|<img|<b>|<i>|onclick="x/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;comillas&quot; &#39;simples&#39;');
    expect(html).toContain('data-inbox-reject="req&quot;&gt;&lt;script&gt;"');
  });

  test('an empty inbox, a cut list and the recent outcomes', () => {
    expect(renderInbox(view([]), NOW, { clock })).toBe('<h2>Nada espera tu decisión</h2>');
    const cut = renderInbox(view([card()], [], 4), NOW, { clock });
    expect(cut).toContain('<p class="notice">Se muestran 1 de 4. Las demás aparecen a medida que respondés.</p>');
    const withRecent = renderInbox(view([], [outcome('consumed', { by: 'grow:run-1' })]), NOW, { clock, names });
    expect(withRecent).toContain('<h3>Últimas respuestas</h3>');
    expect(withRecent).toContain('<li data-status="consumed"><strong>Grow quiere enviar un email</strong> Para: ana@example.com · Asunto: Propuesta. Usada a las -1min. Esa aprobación ya no sirve para otra vez.</li>');
  });

  test('an approval that is not used yet can be taken back from the list of outcomes', () => {
    const html = renderInbox(view([], [outcome('approved'), outcome('consumed', { requestId: 'req-2' })]), NOW, { clock, names });
    expect(html).toContain('Todavía no se usó; si no se usa antes de las +59min, vence sola. <button type="button" data-inbox-reject="req-1">Retirar aprobación</button></li>');
    expect(html.match(/data-inbox-reject/g)).toHaveLength(1);
  });

  test('an inbox that cannot be read renders its notice and nothing else', () => {
    expect(renderInbox({ ok: false, reason: 'absent' }, NOW)).toBe('<h2>Decisiones</h2><p class="notice">Todavía ningún sistema pidió una decisión en esta Mac.</p>');
  });

  test('damaged requests are mentioned, not hidden', () => {
    const html = renderInbox({ ...view([card()]), damaged: 2 }, NOW, { clock });
    expect(html).toContain('<p class="notice">2 pedidos guardados están dañados y no se muestran.</p>');
  });

  test('escapeInboxHtml covers the five characters', () => {
    expect(escapeInboxHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
