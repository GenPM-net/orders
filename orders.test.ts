import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { upsertOAuthUser } from '../auth/index.ts';
import * as authSchema from '../auth/schema.ts';
import { createProduct, getProduct } from '../catalog/index.ts';
import * as catalogSchema from '../catalog/schema.ts';
import type { AdminContext, PaymentProvider } from '../contracts/index.ts';
import { testDb } from '../db/__fixtures__/pglite.ts';
import { type EmailMessage, setEmailProvider } from '../email/index.ts';
import { runDue } from '../jobs/index.ts';
import * as jobsSchema from '../jobs/schema.ts';
import { orderRoutes } from './adapters/hono.ts';
import * as schema from './schema.ts';
import {
  addFulfillment,
  cancelOrder,
  clearPaymentProviders,
  createOrder,
  getOrder,
  getOrderForCustomer,
  markDelivered,
  markPaid,
  type NewOrder,
  OrderError,
  onOrderEvent,
  orderAccessToken,
  ordersAdminResource,
  refundOrder,
  registerPaymentProvider,
} from './index.ts';

const sent: EmailMessage[] = [];
const refundsCalled: Array<{ ref: string; amount: number; key: string }> = [];
let red: string;
let blue: string;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof OrderError || (e && typeof e === 'object' && 'code' in e) ? (e as { code: string }).code : Promise.reject(e)));
const fakeStripe: PaymentProvider = {
  name: 'stripe',
  getPayment: async () => null,
  refund: async (ref, amount, opts) => {
    refundsCalled.push({ ref, amount: amount.amount, key: opts.idempotencyKey });
    return { refundRef: `re_${refundsCalled.length}` };
  },
};
const address = { name: 'Ana', line1: 'Calle Mayor 1', city: 'Valencia', postalCode: '46001', country: 'ES' };
const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  email: 'Ana@X.test',
  currency: 'EUR',
  lines: [
    { variantId: red, productId: null, sku: 'MUG-R', name: 'Mug', title: 'Red', kind: 'physical', quantity: 2, unitPrice: 1000, discount: 200 },
    { variantId: blue, productId: null, sku: 'MUG-B', name: 'Mug', title: 'Blue', kind: 'physical', quantity: 1, unitPrice: 1500, discount: 0 },
  ],
  discounts: [{ source: 'discounts', label: '10%', amount: 200, code: 'TEN' }],
  shipping: { label: 'Standard', amount: 499 },
  shippingAddress: address,
  payment: { provider: 'stripe', ref: 'pi_1', status: 'paid' },
  ...over,
});

beforeEach(async () => {
  await testDb(authSchema, catalogSchema, jobsSchema, schema);
  Object.assign(process.env, { STORE_CURRENCY: 'EUR', ORDER_LINK_SECRET: 'o'.repeat(40), SITE_URL: 'https://shop.test', EMAIL_FROM: 'Shop <s@shop.test>', AUTH_SECRET: 'a'.repeat(40) });
  sent.length = 0;
  refundsCalled.length = 0;
  setEmailProvider({ name: 't', send: async (m) => (sent.push(m), { id: null }) });
  clearPaymentProviders();
  registerPaymentProvider(fakeStripe);
  await createProduct({
    slug: 'mug', name: 'Mug', status: 'active', options: [{ name: 'Color', values: ['Red', 'Blue'] }],
    variants: [{ options: { Color: 'Red' }, price: 1000, stock: 2 }, { options: { Color: 'Blue' }, price: 1500, stock: 5 }],
  });
  const p = (await getProduct('mug'))!;
  red = p.variants[0]!.id;
  blue = p.variants[1]!.id;
});

const stock = async () => (await getProduct('mug'))!.variants.map((v) => v.stock);

describe('creating orders', () => {
  it('freezes lines, computes totals, numbers sequentially and reserves stock', async () => {
    const o = await createOrder(order());
    expect(o).toMatchObject({ number: '1001', status: 'paid', email: 'ana@x.test', subtotal: 3500, discountTotal: 200, shippingTotal: 499, total: 3799 });
    expect(await stock()).toEqual([0, 4]);
    const d = (await getOrder(o.id))!;
    expect(d.lines.map((l) => [l.title, l.quantity, l.total])).toEqual([['Red', 2, 1800], ['Blue', 1, 1500]]);
    expect(d.events.map((e) => e.type)).toEqual(['created']);
    expect((await createOrder(order({ lines: [order().lines[1]!] }))).number).toBe('1002');
  });

  it('is idempotent per cart and rolls back when stock runs out', async () => {
    const a = await createOrder(order({ cartId: 'crt_1' }));
    expect((await createOrder(order({ cartId: 'crt_1' }))).id).toBe(a.id);
    expect(await code(createOrder(order({ cartId: 'crt_2' })))).toBe('out_of_stock');
    expect(await stock()).toEqual([0, 4]); // la segunda no reservó nada
    expect(await code(createOrder(order({ lines: [] })))).toBe('invalid');
  });

  it('sends the confirmation email once, with a signed guest link', async () => {
    const o = await createOrder(order({ payment: { provider: 'stripe', ref: 'pi_1', status: 'pending' } }));
    await runDue();
    expect(sent).toHaveLength(0);
    await markPaid(o.id, { provider: 'stripe', ref: 'pi_1' });
    await markPaid(o.id, { provider: 'stripe', ref: 'pi_1' });
    await runDue();
    await runDue();
    expect(sent.map((m) => m.subject)).toEqual([`Order ${o.number} confirmed`]);
    expect(sent[0]!.text).toContain(`https://shop.test/orders/${o.number}?token=${await orderAccessToken(o)}`);
    expect(sent[0]!.text).toMatch(/Total: €37\.99/);
  });

  it('runs custom handlers once even if a later handler fails and the job retries', async () => {
    let calls = 0;
    let failOnce = true;
    onOrderEvent('paid', 'a-counter', () => void calls++);
    onOrderEvent('paid', 'b-flaky', () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('supplier down');
      }
    });
    await createOrder(order());
    expect((await runDue()).retried).toBe(1);
    await runDue({ now: new Date(Date.now() + 60_000) });
    expect(calls).toBe(1);
  });
});

describe('fulfillment, cancel and refunds', () => {
  it('partial then full shipment, delivery and shipped email with tracking', async () => {
    const o = await createOrder(order());
    const d = (await getOrder(o.id))!;
    await addFulfillment(o.id, { lines: [{ lineId: d.lines[0]!.id, quantity: 1 }], trackingNumber: 'TRK1' });
    expect((await getOrder(o.id))!.fulfillmentStatus).toBe('partial');
    expect(await code(addFulfillment(o.id, { lines: [{ lineId: d.lines[0]!.id, quantity: 5 }] }))).toBe('too_much');
    expect(await code(addFulfillment(o.id, { trackingUrl: 'http://x' }))).toBe('invalid');
    const f2 = await addFulfillment(o.id, { carrier: 'Correos', trackingUrl: 'https://track.test/2' });
    const after = (await getOrder(o.id))!;
    expect(after.fulfillmentStatus).toBe('fulfilled');
    expect(after.lines.map((l) => l.fulfilledQuantity)).toEqual([2, 1]);
    await markDelivered(after.fulfillments[0]!.id);
    expect((await getOrder(o.id))!.fulfillmentStatus).toBe('fulfilled');
    await markDelivered(f2.id);
    expect((await getOrder(o.id))!.fulfillmentStatus).toBe('delivered');
    await runDue();
    expect(sent.filter((m) => m.subject.includes('on its way')).map((m) => m.text.includes('https://track.test/2'))).toEqual([false, true]);
    expect(await code(cancelOrder(o.id))).toBe('invalid_transition');
  });

  it('cancel releases stock; shipping a cancelled or unpaid order is refused', async () => {
    const o = await createOrder(order());
    await cancelOrder(o.id, { reason: 'customer' });
    expect(await stock()).toEqual([2, 5]);
    expect(await code(addFulfillment(o.id, {}))).toBe('invalid_transition');
    const pending = await createOrder(order({ payment: { provider: 'stripe', ref: 'pi_2', status: 'pending' } }));
    expect(await code(addFulfillment(pending.id, {}))).toBe('invalid_transition');
  });

  it('refunds through the registered provider with idempotency keys, partial then full, with restock', async () => {
    const o = await createOrder(order());
    const d = (await getOrder(o.id))!;
    await refundOrder(o.id, { amount: 1000, reason: 'damaged', lines: [{ lineId: d.lines[0]!.id, quantity: 1 }], restock: true });
    expect((await getOrder(o.id))!).toMatchObject({ status: 'partially_refunded', refundedTotal: 1000 });
    expect(await stock()).toEqual([1, 4]);
    expect(await code(refundOrder(o.id, { amount: 5000 }))).toBe('too_much');
    await refundOrder(o.id, { amount: 2799 });
    expect((await getOrder(o.id))!.status).toBe('refunded');
    expect(refundsCalled).toEqual([
      { ref: 'pi_1', amount: 1000, key: `refund:${o.id}:1` },
      { ref: 'pi_1', amount: 2799, key: `refund:${o.id}:2` },
    ]);
    await runDue();
    expect(sent.filter((m) => m.subject.startsWith('Refund')).length).toBe(2);
    const manual = await createOrder(order({ lines: [order().lines[1]!], payment: { provider: 'cash', ref: 'x', status: 'paid' } }));
    expect(await code(refundOrder(manual.id, { amount: 100 }))).toBe('no_provider');
  });
});

describe('customer access (anti-IDOR) and admin', () => {
  it('owner or signed link only; same 404 for missing and foreign orders', async () => {
    const owner = await upsertOAuthUser('github', { id: '1', email: null, emailVerified: false, name: 'O', avatarUrl: null });
    const other = await upsertOAuthUser('github', { id: '2', email: null, emailVerified: false, name: 'X', avatarUrl: null });
    const o = await createOrder(order({ userId: owner.id }));
    expect(await getOrderForCustomer(o.number, { userId: owner.id })).not.toBeNull();
    expect(await getOrderForCustomer(o.number, { userId: other.id })).toBeNull();
    expect(await getOrderForCustomer(o.number, { token: await orderAccessToken(o) })).not.toBeNull();
    expect(await getOrderForCustomer(o.number, { token: 'forged' })).toBeNull();
    const app = new Hono().route('/api/orders', orderRoutes({ currentUserId: async () => null }));
    const res = await app.request(`/api/orders/${o.number}?token=${await orderAccessToken(o)}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ number: o.number, total: 3799 });
    expect(body).not.toHaveProperty('paymentRef');
    expect(body).not.toHaveProperty('events');
    expect((await app.request(`/api/orders/${o.number}`)).status).toBe(404);
    expect((await app.request('/api/orders/99999')).status).toBe(404);
  });

  it('admin actions need specific permissions', async () => {
    const o = await createOrder(order());
    const ctx = (perms: string[]): AdminContext => ({ user: { id: 'usr_staff', email: null, name: null }, can: async (p) => perms.includes(p) });
    const support = ctx(['orders:read', 'orders:fulfill']);
    expect((await ordersAdminResource.list({ page: 1, pageSize: 10, search: 'ana@' }, support)).total).toBe(1);
    const fulfill = ordersAdminResource.actions!.find((a) => a.name === 'fulfill')!;
    expect((await fulfill.run(o.id, { trackingNumber: 'T1' }, support)).fulfillmentStatus).toBe('fulfilled');
    const refund = ordersAdminResource.actions!.find((a) => a.name === 'refund')!;
    expect(await code(refund.run(o.id, { amount: 100 }, support))).toBe('forbidden');
    expect((await refund.run(o.id, { amount: '100' }, ctx(['orders:refund']))).refundedTotal).toBe(100);
    const events = (await getOrder(o.id))!.events;
    expect(events.find((e) => e.type === 'shipped')?.actor).toBe('usr_staff');
  });
});
