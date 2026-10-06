// Emails transaccionales del pedido (confirmación con enlace de seguimiento, enviado, reembolso), enviados una vez
// por evento a través de @core/email. Textos sustituibles por idioma con `setOrderMessages`.
import { getEmailProvider } from '../email/index.js';
import { format, money } from '../money/index.js';
import { type OrderDetail, onOrderEvent, orderAccessToken } from './orders.js';

export type OrderMessages = {
  confirmationSubject: (number: string) => string;
  confirmationIntro: string;
  shippedSubject: (number: string) => string;
  shippedIntro: string;
  refundSubject: (number: string) => string;
  refundIntro: (amount: string) => string;
  viewOrder: string;
  tracking: string;
  total: string;
};

const EN: OrderMessages = {
  confirmationSubject: (n) => `Order ${n} confirmed`,
  confirmationIntro: 'Thanks for your order. Here is a summary:',
  shippedSubject: (n) => `Order ${n} is on its way`,
  shippedIntro: 'Good news: your order has shipped.',
  refundSubject: (n) => `Refund for order ${n}`,
  refundIntro: (a) => `We have refunded ${a} to your original payment method.`,
  viewOrder: 'View your order',
  tracking: 'Tracking',
  total: 'Total',
};

let messagesFor: (locale: string | null) => OrderMessages = () => EN;
export const setOrderMessages = (fn: (locale: string | null) => Partial<OrderMessages>) => {
  messagesFor = (l) => ({ ...EN, ...fn(l) });
};

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** URL pública del pedido para el cliente (con token si es invitado). */
export async function orderUrl(o: Pick<OrderDetail, 'id' | 'number'>): Promise<string> {
  const site = process.env.SITE_URL;
  if (!site) throw new Error('SITE_URL is not set');
  return new URL(`/orders/${encodeURIComponent(o.number)}?token=${await orderAccessToken(o)}`, site).toString();
}

async function send(o: OrderDetail, subject: string, paragraphs: string[], extra: Array<[string, string]> = []) {
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is not set');
  const m = messagesFor(o.locale);
  const link = await orderUrl(o);
  const fmt = (n: number) => format(money(n, o.currency), o.locale ?? 'en');
  const rows = o.lines.map((l) => [`${l.name}${l.title ? ` (${l.title})` : ''} × ${l.quantity}`, fmt(l.total)] as [string, string]);
  rows.push([m.total, fmt(o.total)]);
  const text = [...paragraphs, '', ...rows.map(([a, b]) => `${a}: ${b}`), ...extra.map(([a, b]) => `${a}: ${b}`), '', `${m.viewOrder}: ${link}`].join('\n');
  const html = `${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}<table>${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td align="right">${esc(b)}</td></tr>`).join('')}</table>${extra.map(([a, b]) => `<p>${esc(a)}: ${b.startsWith('https://') ? `<a href="${esc(b)}">${esc(b)}</a>` : esc(b)}</p>`).join('')}<p><a href="${esc(link)}">${esc(m.viewOrder)}</a></p>`;
  await getEmailProvider().send({ from, to: o.email, subject, text, html });
}

/** Registra los tres emails. Llamado al importar el módulo; `onOrderEvent` con el mismo nombre los sustituye. */
export function registerOrderEmails(): void {
  onOrderEvent('paid', 'email.confirmation', (o) => send(o, messagesFor(o.locale).confirmationSubject(o.number), [messagesFor(o.locale).confirmationIntro]));
  onOrderEvent('shipped', 'email.shipped', (o, data) => {
    const f = o.fulfillments.find((x) => x.id === data.fulfillmentId);
    const m = messagesFor(o.locale);
    const tracking = f?.trackingUrl ?? f?.trackingNumber;
    return send(o, m.shippedSubject(o.number), [m.shippedIntro], tracking ? [[m.tracking, tracking]] : []);
  });
  onOrderEvent('refunded', 'email.refunded', (o, data) => {
    const r = o.refunds.find((x) => x.id === data.refundId);
    const m = messagesFor(o.locale);
    return send(o, m.refundSubject(o.number), [m.refundIntro(format(money(r?.amount ?? 0, o.currency), o.locale ?? 'en'))]);
  });
}

registerOrderEmails();
