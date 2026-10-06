// Tablas de @core/orders. Las recoge drizzle-kit vía src/lib/db/drizzle.config.ts.
import { boolean, index, integer, jsonb, pgSequence, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from '../auth/index.ts';
import { primaryId, timestamps } from '../db/index.ts';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export type Address = {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  region?: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  phone?: string;
  company?: string;
  taxId?: string;
};

export type OrderAdjustment = { source: string; label: string; amount: number; code?: string };

/** Número de pedido legible y secuencial (no revela el id interno). */
export const orderNumberSeq = pgSequence('order_number_seq', { startWith: 1001 });

export const orders = pgTable(
  'orders',
  {
    id: primaryId('ord'),
    number: text('number').notNull().unique(),
    /** Ciclo del pago: pending → paid → (partially_)refunded; o cancelled. */
    status: text('status', { enum: ['pending', 'paid', 'cancelled', 'refunded', 'partially_refunded'] }).notNull().default('pending'),
    /** Ciclo del envío, independiente del pago. */
    fulfillmentStatus: text('fulfillment_status', { enum: ['unfulfilled', 'partial', 'fulfilled', 'delivered'] }).notNull().default('unfulfilled'),
    email: text('email').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    locale: text('locale'),
    currency: text('currency').notNull(),
    subtotal: integer('subtotal').notNull(),
    discountTotal: integer('discount_total').notNull().default(0),
    shippingTotal: integer('shipping_total').notNull().default(0),
    taxTotal: integer('tax_total').notNull().default(0),
    total: integer('total').notNull(),
    refundedTotal: integer('refunded_total').notNull().default(0),
    discounts: jsonb('discounts').$type<OrderAdjustment[]>().notNull().default([]),
    shippingMethod: jsonb('shipping_method').$type<{ label: string; rateId?: string } | null>(),
    shippingAddress: jsonb('shipping_address').$type<Address | null>(),
    billingAddress: jsonb('billing_address').$type<Address | null>(),
    customerNote: text('customer_note'),
    paymentProvider: text('payment_provider'),
    paymentRef: text('payment_ref'),
    /** Carrito de origen: hace idempotente la creación desde un webhook repetido. */
    cartId: text('cart_id').unique(),
    paidAt: ts('paid_at'),
    cancelledAt: ts('cancelled_at'),
    ...timestamps,
  },
  (t) => [index('orders_user_idx').on(t.userId), index('orders_status_idx').on(t.status, t.createdAt), index('orders_email_idx').on(t.email)],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: primaryId('oli'),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    variantId: text('variant_id'),
    productId: text('product_id'),
    /** Copia de lo comprado: el pedido no cambia si luego cambia el producto. */
    sku: text('sku'),
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    kind: text('kind', { enum: ['physical', 'digital'] }).notNull().default('physical'),
    quantity: integer('quantity').notNull(),
    unitPrice: integer('unit_price').notNull(),
    subtotal: integer('subtotal').notNull(),
    discount: integer('discount').notNull().default(0),
    total: integer('total').notNull(),
    fulfilledQuantity: integer('fulfilled_quantity').notNull().default(0),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    /** Orden de las líneas tal como estaban en el carrito. */
    position: integer('position').notNull().default(0),
  },
  (t) => [index('order_lines_order_idx').on(t.orderId)],
);

export const fulfillments = pgTable(
  'order_fulfillments',
  {
    id: primaryId('ful'),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lines: jsonb('lines').$type<Array<{ lineId: string; quantity: number }>>().notNull(),
    status: text('status', { enum: ['shipped', 'delivered', 'failed'] }).notNull().default('shipped'),
    carrier: text('carrier'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    /** Quién lo envía: `manual`, o el proveedor de dropshipping. */
    source: text('source').notNull().default('manual'),
    deliveredAt: ts('delivered_at'),
    ...timestamps,
  },
  (t) => [index('order_fulfillments_order_idx').on(t.orderId)],
);

export const refunds = pgTable('order_refunds', {
  id: primaryId('rfd'),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  reason: text('reason'),
  lines: jsonb('lines').$type<Array<{ lineId: string; quantity: number }>>().notNull().default([]),
  restocked: boolean('restocked').notNull().default(false),
  providerRef: text('provider_ref'),
  ...timestamps,
});

/** Historial del pedido (línea de tiempo del panel) y registro de avisos ya enviados. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: primaryId('oev'),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actor: text('actor'),
    ...timestamps,
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

export type Order = typeof orders.$inferSelect;
export type OrderLine = typeof orderLines.$inferSelect;
export type Fulfillment = typeof fulfillments.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
