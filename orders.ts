// Pedidos: creación (con reserva de stock), pago, envíos, entrega, cancelación y reembolsos, con historial y eventos
// en segundo plano (@core/jobs) para que otros módulos reaccionen (emails, proveedores, píxeles).
import { asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { releaseStock, reserveStock } from '../catalog/index.ts';
import type { PaymentProvider } from '../contracts/index.ts';
import { type Executor, getDb, withTransaction } from '../db/index.ts';
import { defineJob } from '../jobs/index.ts';
import { money } from '../money/index.ts';
import {
  type Address,
  type Fulfillment,
  fulfillments,
  type Order,
  type OrderAdjustment,
  type OrderLine,
  orderEvents,
  orderLines,
  orders,
  type Refund,
  refunds,
} from './schema.ts';

export class OrderError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'invalid_transition' | 'forbidden' | 'no_provider' | 'too_much',
    message: string = code,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

export type NewOrderLine = {
  variantId: string | null;
  productId: string | null;
  sku: string | null;
  name: string;
  title: string;
  kind: 'physical' | 'digital';
  quantity: number;
  unitPrice: number;
  /** Descuento de pedido asignado a la línea. */
  discount: number;
};

export type NewOrder = {
  email: string;
  userId?: string | null;
  locale?: string | null;
  currency: string;
  lines: NewOrderLine[];
  discounts?: OrderAdjustment[];
  shipping?: { label: string; rateId?: string; amount: number } | null;
  taxTotal?: number;
  shippingAddress?: Address | null;
  billingAddress?: Address | null;
  customerNote?: string | null;
  cartId?: string | null;
  payment?: { provider: string; ref: string; status: 'pending' | 'paid' };
  /** Reservar stock de @core/catalog (por defecto sí). */
  reserve?: boolean;
};

const AddressSchema = z.object({
  name: z.string().min(1).max(120),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  postalCode: z.string().min(1).max(20),
  region: z.string().max(100).optional(),
  country: z.string().regex(/^[A-Z]{2}$/),
  phone: z.string().max(40).optional(),
  company: z.string().max(120).optional(),
  taxId: z.string().max(40).optional(),
});
export const parseAddress = (a: unknown): Address => AddressSchema.parse(a);

const prefix = () => process.env.ORDER_NUMBER_PREFIX ?? '';

/**
 * Crea el pedido en la transacción `tx` (o en una nueva): reserva stock, congela las líneas y registra el historial.
 * Idempotente por `cartId`: si ya existe un pedido de ese carrito, lo devuelve.
 */
export async function createOrder(input: NewOrder, db: Executor = getDb()): Promise<Order> {
  return tx(db, async (t) => {
    if (input.cartId) {
      const [existing] = await t.select().from(orders).where(eq(orders.cartId, input.cartId));
      if (existing) return existing;
    }
    if (!input.lines.length) throw new OrderError('invalid', 'order has no lines');
    z.email().parse(input.email);
    if (input.shippingAddress) parseAddress(input.shippingAddress);
    if (input.reserve !== false) for (const l of input.lines) if (l.variantId) await reserveStock(l.variantId, l.quantity, t);
    const lines = input.lines.map((l) => ({ ...l, subtotal: l.unitPrice * l.quantity, total: l.unitPrice * l.quantity - l.discount }));
    const subtotal = lines.reduce((a, l) => a + l.subtotal, 0);
    const discountTotal = lines.reduce((a, l) => a + l.discount, 0);
    const shippingTotal = input.shipping?.amount ?? 0;
    const taxTotal = input.taxTotal ?? 0;
    const n = await nextOrderNumber(t);
    const paid = input.payment?.status === 'paid';
    const [order] = await t
      .insert(orders)
      .values({
        number: `${prefix()}${n}`,
        status: paid ? 'paid' : 'pending',
        email: input.email.trim().toLowerCase(),
        userId: input.userId ?? null,
        locale: input.locale ?? null,
        currency: input.currency,
        subtotal,
        discountTotal,
        shippingTotal,
        taxTotal,
        total: subtotal - discountTotal + shippingTotal + taxTotal,
        discounts: input.discounts ?? [],
        shippingMethod: input.shipping ? { label: input.shipping.label, ...(input.shipping.rateId && { rateId: input.shipping.rateId }) } : null,
        shippingAddress: input.shippingAddress ?? null,
        billingAddress: input.billingAddress ?? null,
        customerNote: input.customerNote?.slice(0, 1000) ?? null,
        paymentProvider: input.payment?.provider ?? null,
        paymentRef: input.payment?.ref ?? null,
        cartId: input.cartId ?? null,
        paidAt: paid ? new Date() : null,
      })
      .returning();
    await t.insert(orderLines).values(lines.map((l, position) => ({ ...l, orderId: order!.id, position })));
    await event(t, order!.id, 'created', { total: order!.total });
    if (paid) await emit(t, order!.id, 'paid');
    return order!;
  });
}

/** Marca como pagado un pedido pendiente (webhook de pago, transferencia confirmada). */
export async function markPaid(orderId: string, payment: { provider: string; ref: string }, db: Executor = getDb()): Promise<Order> {
  return tx(db, async (t) => {
    const o = await lock(orderId, t);
    if (o.status === 'paid') return o;
    if (o.status !== 'pending') throw new OrderError('invalid_transition', `cannot mark ${o.status} order as paid`);
    const [row] = await t.update(orders).set({ status: 'paid', paidAt: new Date(), paymentProvider: payment.provider, paymentRef: payment.ref }).where(eq(orders.id, orderId)).returning();
    await emit(t, orderId, 'paid');
    return row!;
  });
}

/** Cancela un pedido sin envíos: devuelve el stock y, si estaba pagado, hay que reembolsar aparte. */
export async function cancelOrder(orderId: string, opts: { reason?: string; actor?: string; restock?: boolean } = {}, db: Executor = getDb()): Promise<Order> {
  return tx(db, async (t) => {
    const o = await lock(orderId, t);
    if (o.status === 'cancelled') return o;
    if (o.fulfillmentStatus !== 'unfulfilled') throw new OrderError('invalid_transition', 'shipped orders cannot be cancelled; refund instead');
    if (o.status === 'refunded' || o.status === 'partially_refunded') throw new OrderError('invalid_transition', 'refunded orders cannot be cancelled');
    if (opts.restock !== false) for (const l of await linesOf(orderId, t)) if (l.variantId) await releaseStock(l.variantId, l.quantity - l.refundedQuantity, t);
    const [row] = await t.update(orders).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(orders.id, orderId)).returning();
    await event(t, orderId, 'cancelled', { reason: opts.reason ?? null }, opts.actor);
    await emit(t, orderId, 'cancelled');
    return row!;
  });
}

/**
 * Registra un envío (todas las líneas pendientes o las indicadas). Exige pedido pagado. Actualiza el estado de envío
 * a `partial` o `fulfilled`.
 */
export async function addFulfillment(
  orderId: string,
  input: { lines?: Array<{ lineId: string; quantity: number }>; carrier?: string; trackingNumber?: string; trackingUrl?: string; source?: string; actor?: string },
  db: Executor = getDb(),
): Promise<Fulfillment> {
  return tx(db, async (t) => {
    const o = await lock(orderId, t);
    if (o.status !== 'paid' && o.status !== 'partially_refunded') throw new OrderError('invalid_transition', `cannot ship a ${o.status} order`);
    const ls = await linesOf(orderId, t);
    const pending = (l: OrderLine) => l.quantity - l.refundedQuantity - l.fulfilledQuantity;
    const items = input.lines ?? ls.filter((l) => pending(l) > 0).map((l) => ({ lineId: l.id, quantity: pending(l) }));
    if (!items.length) throw new OrderError('invalid', 'nothing left to ship');
    for (const it of items) {
      const l = ls.find((x) => x.id === it.lineId);
      if (!l || !Number.isInteger(it.quantity) || it.quantity <= 0 || it.quantity > pending(l)) throw new OrderError('too_much', `invalid quantity for line ${it.lineId}`);
      await t.update(orderLines).set({ fulfilledQuantity: l.fulfilledQuantity + it.quantity }).where(eq(orderLines.id, l.id));
    }
    if (input.trackingUrl && !/^https:\/\//.test(input.trackingUrl)) throw new OrderError('invalid', 'tracking URL must be https');
    const [f] = await t
      .insert(fulfillments)
      .values({ orderId, lines: items, carrier: input.carrier ?? null, trackingNumber: input.trackingNumber ?? null, trackingUrl: input.trackingUrl ?? null, source: input.source ?? 'manual' })
      .returning();
    const after = await linesOf(orderId, t);
    const done = after.every((l) => pending(l) === 0);
    await t.update(orders).set({ fulfillmentStatus: done ? 'fulfilled' : 'partial' }).where(eq(orders.id, orderId));
    await event(t, orderId, 'shipped', { fulfillmentId: f!.id, trackingNumber: f!.trackingNumber }, input.actor);
    await emit(t, orderId, 'shipped', { fulfillmentId: f!.id });
    return f!;
  });
}

/** Actualiza el seguimiento de un envío (p. ej. desde un proveedor) sin cambiar líneas. */
export async function updateTracking(fulfillmentId: string, data: { carrier?: string; trackingNumber?: string; trackingUrl?: string }, db: Executor = getDb()): Promise<Fulfillment> {
  if (data.trackingUrl && !/^https:\/\//.test(data.trackingUrl)) throw new OrderError('invalid', 'tracking URL must be https');
  const [f] = await db.update(fulfillments).set(data).where(eq(fulfillments.id, fulfillmentId)).returning();
  if (!f) throw new OrderError('not_found');
  return f;
}

export async function markDelivered(fulfillmentId: string, db: Executor = getDb()): Promise<Fulfillment> {
  return tx(db, async (t) => {
    const [f] = await t.update(fulfillments).set({ status: 'delivered', deliveredAt: new Date() }).where(eq(fulfillments.id, fulfillmentId)).returning();
    if (!f) throw new OrderError('not_found');
    const all = await t.select().from(fulfillments).where(eq(fulfillments.orderId, f.orderId));
    const [o] = await t.select().from(orders).where(eq(orders.id, f.orderId));
    if (o?.fulfillmentStatus === 'fulfilled' && all.every((x) => x.status === 'delivered')) {
      await t.update(orders).set({ fulfillmentStatus: 'delivered' }).where(eq(orders.id, f.orderId));
      await emit(t, f.orderId, 'delivered');
    }
    await event(t, f.orderId, 'delivered', { fulfillmentId });
    return f;
  });
}

const providers = new Map<string, PaymentProvider>();
/** La pasarela (p. ej. @core/checkout con Stripe) se registra para que el panel pueda reembolsar. */
export const registerPaymentProvider = (p: PaymentProvider) => void providers.set(p.name, p);
export const clearPaymentProviders = () => providers.clear();

/**
 * Reembolsa `amount` (≤ lo pendiente de reembolsar) a través de la pasarela del pedido. Con `lines` y `restock`
 * devuelve esas unidades al stock. Idempotente por número de reembolso.
 */
export async function refundOrder(
  orderId: string,
  input: { amount: number; reason?: string; lines?: Array<{ lineId: string; quantity: number }>; restock?: boolean; actor?: string },
  db: Executor = getDb(),
): Promise<Refund> {
  return tx(db, async (t) => {
    const o = await lock(orderId, t);
    if (o.status !== 'paid' && o.status !== 'partially_refunded') throw new OrderError('invalid_transition', `cannot refund a ${o.status} order`);
    if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > o.total - o.refundedTotal) throw new OrderError('too_much', 'invalid refund amount');
    const provider = o.paymentProvider ? providers.get(o.paymentProvider) : undefined;
    if (!provider || !o.paymentRef) throw new OrderError('no_provider', `no payment provider registered for ${o.paymentProvider ?? 'this order'}`);
    const ls = await linesOf(orderId, t);
    for (const it of input.lines ?? []) {
      const l = ls.find((x) => x.id === it.lineId);
      if (!l || it.quantity <= 0 || it.quantity > l.quantity - l.refundedQuantity) throw new OrderError('too_much', `invalid quantity for line ${it.lineId}`);
      await t.update(orderLines).set({ refundedQuantity: l.refundedQuantity + it.quantity }).where(eq(orderLines.id, l.id));
      if (input.restock && l.variantId) await releaseStock(l.variantId, it.quantity, t);
    }
    const [{ c } = { c: 0 }] = await t.select({ c: count() }).from(refunds).where(eq(refunds.orderId, orderId));
    const { refundRef } = await provider.refund(o.paymentRef, money(input.amount, o.currency), { idempotencyKey: `refund:${orderId}:${c + 1}`, reason: input.reason });
    const [r] = await t
      .insert(refunds)
      .values({ orderId, amount: input.amount, reason: input.reason ?? null, lines: input.lines ?? [], restocked: !!input.restock, providerRef: refundRef })
      .returning();
    const refundedTotal = o.refundedTotal + input.amount;
    await t.update(orders).set({ refundedTotal, status: refundedTotal >= o.total ? 'refunded' : 'partially_refunded' }).where(eq(orders.id, orderId));
    await event(t, orderId, 'refunded', { amount: input.amount, refundId: r!.id }, input.actor);
    await emit(t, orderId, 'refunded', { refundId: r!.id });
    return r!;
  });
}

export async function addNote(orderId: string, note: string, actor: string, db: Executor = getDb()): Promise<void> {
  await event(db, orderId, 'note', { note: note.slice(0, 2000) }, actor);
}

export type OrderDetail = Order & { lines: OrderLine[]; fulfillments: Fulfillment[]; refunds: Refund[]; events: Array<typeof orderEvents.$inferSelect> };

export async function getOrder(orderId: string, db: Executor = getDb()): Promise<OrderDetail | null> {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) return null;
  return {
    ...o,
    lines: await linesOf(orderId, db),
    fulfillments: await db.select().from(fulfillments).where(eq(fulfillments.orderId, orderId)).orderBy(asc(fulfillments.createdAt)),
    refunds: await db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.createdAt)),
    events: await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
  };
}

export async function listOrdersForUser(userId: string, opts: { page?: number; perPage?: number } = {}, db: Executor = getDb()): Promise<Order[]> {
  const perPage = Math.min(opts.perPage ?? 20, 100);
  return db.select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt)).limit(perPage).offset((Math.max(opts.page ?? 1, 1) - 1) * perPage);
}

// —— acceso del cliente (anti-IDOR): sesión del dueño o enlace firmado ——

const enc = new TextEncoder();
async function sign(data: string): Promise<string> {
  const s = process.env.ORDER_LINK_SECRET;
  if (!s || s.length < 32) throw new Error('ORDER_LINK_SECRET must be set (>= 32 chars)');
  const key = await crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Token del enlace de seguimiento para invitados (va en el email de confirmación). */
export const orderAccessToken = (o: Pick<Order, 'id' | 'number'>) => sign(`order:${o.id}:${o.number}`);

/**
 * Pedido por número si quien lo pide tiene acceso: su usuario es el dueño o trae el token del enlace. Si no, null
 * (no distingue "no existe" de "no es tuyo").
 */
export async function getOrderForCustomer(number: string, access: { userId?: string | null; token?: string | null }, db: Executor = getDb()): Promise<OrderDetail | null> {
  const [o] = await db.select().from(orders).where(eq(orders.number, number));
  if (!o) return null;
  const owner = !!access.userId && o.userId === access.userId;
  let byToken = false;
  if (!owner && access.token) {
    const expected = await orderAccessToken(o);
    let d = access.token.length ^ expected.length;
    for (let i = 0; i < expected.length; i++) d |= (access.token.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
    byToken = d === 0;
  }
  return owner || byToken ? getOrder(o.id, db) : null;
}

// —— eventos para otros módulos ——

export type OrderEventType = 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
type Handler = (order: OrderDetail, data: Record<string, unknown>) => Promise<void> | void;
const handlers = new Map<OrderEventType, Array<{ name: string; fn: Handler }>>();

/**
 * Reacciona a cambios del pedido fuera de la petición (emails, proveedor, píxeles). Cada manejador se ejecuta una
 * vez por evento (se registra en el historial) y se reintenta si falla.
 */
export function onOrderEvent(type: OrderEventType, name: string, fn: Handler): void {
  handlers.set(type, [...(handlers.get(type) ?? []).filter((h) => h.name !== name), { name, fn }]);
}
export const clearOrderHandlers = () => handlers.clear();

async function event(db: Executor, orderId: string, type: string, data: Record<string, unknown> = {}, actor?: string) {
  await db.insert(orderEvents).values({ orderId, type, data, actor: actor ?? null });
}

async function emit(db: Executor, orderId: string, type: OrderEventType, data: Record<string, unknown> = {}) {
  await orderEventJob.enqueue({ orderId, type, data }, { dedupeKey: `orders.${type}:${orderId}:${JSON.stringify(data)}` }, db);
}

export const orderEventJob = defineJob(
  'orders.event',
  z.object({ orderId: z.string(), type: z.enum(['paid', 'shipped', 'delivered', 'cancelled', 'refunded']), data: z.record(z.string(), z.unknown()).default({}) }),
  async ({ orderId, type, data }) => {
    const order = await getOrder(orderId);
    if (!order) return;
    for (const h of handlers.get(type) ?? []) {
      const marker = `handled:${type}:${h.name}:${JSON.stringify(data)}`;
      if (order.events.some((e) => e.type === marker)) continue; // ya hecho en un intento anterior
      await h.fn(order, data);
      await event(getDb(), orderId, marker);
    }
  },
);

async function nextOrderNumber(t: Executor): Promise<number> {
  const res = (await t.execute(sql`select nextval('order_number_seq') as n`)) as unknown as { rows?: Array<{ n: string | number }> } | Array<{ n: string | number }>;
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return Number(rows[0]?.n);
}

async function lock(orderId: string, t: Executor): Promise<Order> {
  const [o] = await t.select().from(orders).where(eq(orders.id, orderId)).for('update');
  if (!o) throw new OrderError('not_found');
  return o;
}

const linesOf = (orderId: string, db: Executor) => db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.position), asc(orderLines.id));

function tx<T>(db: Executor, fn: (t: Executor) => Promise<T>): Promise<T> {
  return 'rollback' in db ? fn(db) : withTransaction((t) => fn(t), db as Parameters<typeof withTransaction>[1]);
}

