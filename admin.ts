// Recurso de panel "Pedidos": lista con filtros, detalle con líneas/envíos/reembolsos/historial y acciones.
import { and, count, desc, ilike, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminContext, AdminResource } from '../contracts/index.ts';
import { getDb } from '../db/index.ts';
import { addFulfillment, cancelOrder, getOrder, markPaid, type OrderDetail, OrderError, refundOrder } from './orders.ts';
import { orders } from './schema.ts';

async function need(ctx: AdminContext, perm: string) {
  if (!(await ctx.can(perm))) throw new OrderError('forbidden', `forbidden: ${perm}`);
}
const reload = async (id: string) => (await getOrder(id))!;

const Fulfill = z.object({ carrier: z.string().max(60).optional(), trackingNumber: z.string().max(100).optional(), trackingUrl: z.url().optional() });
const Refund = z.object({ amount: z.coerce.number().int().positive(), reason: z.string().max(300).optional(), restock: z.coerce.boolean().optional() });

export const ordersAdminResource: AdminResource<OrderDetail> = {
  name: 'orders',
  label: { singular: 'Order', plural: 'Orders' },
  group: 'Store',
  fields: [
    { name: 'number', label: 'Order', type: 'text', readOnly: true, list: true },
    { name: 'email', label: 'Customer', type: 'email', readOnly: true, list: true },
    { name: 'status', label: 'Payment', type: 'text', readOnly: true, list: true },
    { name: 'fulfillmentStatus', label: 'Fulfillment', type: 'text', readOnly: true, list: true },
    { name: 'total', label: 'Total', type: 'money', readOnly: true, list: true },
    { name: 'lines', label: 'Items', type: 'json', readOnly: true },
    { name: 'shippingAddress', label: 'Ship to', type: 'json', readOnly: true },
    { name: 'events', label: 'Timeline', type: 'json', readOnly: true },
    { name: 'createdAt', label: 'Date', type: 'datetime', readOnly: true, list: true },
  ],
  input: z.object({}),
  title: (o) => `#${o.number}`,
  async list(q, ctx) {
    await need(ctx, 'orders:read');
    const conds: SQL[] = [];
    if (q.filters?.status) conds.push(sql`${orders.status} = ${q.filters.status}`);
    if (q.filters?.fulfillment) conds.push(sql`${orders.fulfillmentStatus} = ${q.filters.fulfillment}`);
    if (q.search) {
      const like = `%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      conds.push(or(ilike(orders.number, like), ilike(orders.email, like))!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const [total] = await getDb().select({ n: count() }).from(orders).where(where);
    const rows = await getDb().select({ id: orders.id }).from(orders).where(where).orderBy(desc(orders.createdAt)).limit(q.pageSize).offset((Math.max(q.page, 1) - 1) * q.pageSize);
    return { rows: await Promise.all(rows.map((r) => reload(r.id))), total: total?.n ?? 0 };
  },
  async get(id, ctx) {
    await need(ctx, 'orders:read');
    return getOrder(id);
  },
  actions: [
    {
      name: 'mark-paid',
      label: 'Mark as paid (manual payment)',
      permission: 'orders:update',
      confirm: true,
      input: z.object({ reference: z.string().min(1).max(100) }),
      available: (o) => o.status === 'pending',
      async run(id, input, ctx) {
        await need(ctx, 'orders:update');
        await markPaid(id, { provider: 'manual', ref: z.object({ reference: z.string().min(1).max(100) }).parse(input).reference });
        return reload(id);
      },
    },
    {
      name: 'fulfill',
      label: 'Mark as shipped',
      permission: 'orders:fulfill',
      input: Fulfill,
      available: (o) => (o.status === 'paid' || o.status === 'partially_refunded') && o.fulfillmentStatus !== 'fulfilled' && o.fulfillmentStatus !== 'delivered',
      async run(id, input, ctx) {
        await need(ctx, 'orders:fulfill');
        await addFulfillment(id, { ...Fulfill.parse(input), actor: ctx.user.id });
        return reload(id);
      },
    },
    {
      name: 'refund',
      label: 'Refund',
      permission: 'orders:refund',
      confirm: true,
      input: Refund,
      available: (o) => (o.status === 'paid' || o.status === 'partially_refunded') && o.refundedTotal < o.total,
      async run(id, input, ctx) {
        await need(ctx, 'orders:refund');
        await refundOrder(id, { ...Refund.parse(input), actor: ctx.user.id });
        return reload(id);
      },
    },
    {
      name: 'cancel',
      label: 'Cancel order',
      permission: 'orders:update',
      confirm: true,
      available: (o) => o.status !== 'cancelled' && o.fulfillmentStatus === 'unfulfilled',
      async run(id, _input, ctx) {
        await need(ctx, 'orders:update');
        await cancelOrder(id, { actor: ctx.user.id });
        return reload(id);
      },
    },
  ],
};
