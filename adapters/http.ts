// Vista del pedido para el cliente: JSON sin datos internos (sin costes, refs de pago ni historial interno).
import { getOrderForCustomer, type OrderDetail } from '../index.ts';

export type CurrentUserId = (req: Request) => Promise<string | null>;

export function publicOrder(o: OrderDetail) {
  return {
    number: o.number,
    status: o.status,
    fulfillmentStatus: o.fulfillmentStatus,
    currency: o.currency,
    subtotal: o.subtotal,
    discountTotal: o.discountTotal,
    shippingTotal: o.shippingTotal,
    taxTotal: o.taxTotal,
    total: o.total,
    refundedTotal: o.refundedTotal,
    shippingMethod: o.shippingMethod,
    shippingAddress: o.shippingAddress,
    createdAt: o.createdAt,
    lines: o.lines.map((l) => ({ name: l.name, title: l.title, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total })),
    fulfillments: o.fulfillments.map((f) => ({ status: f.status, carrier: f.carrier, trackingNumber: f.trackingNumber, trackingUrl: f.trackingUrl, createdAt: f.createdAt, deliveredAt: f.deliveredAt })),
  };
}

export async function handleCustomerOrder(req: Request, number: string, currentUserId: CurrentUserId): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token');
  const order = await getOrderForCustomer(number, { userId: await currentUserId(req), token });
  // 404 tanto si no existe como si no es tuyo.
  return order ? Response.json(publicOrder(order), { headers: { 'cache-control': 'private, no-store' } }) : Response.json({ error: 'not_found' }, { status: 404 });
}
