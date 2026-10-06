// Adaptador Hono: `app.route('/api/orders', orderRoutes({ currentUserId }))` → GET /api/orders/:number?token=…
import { Hono } from 'hono';
import { type CurrentUserId, handleCustomerOrder } from './http.js';

export function orderRoutes(opts: { currentUserId: CurrentUserId }) {
  return new Hono().get('/:number', (c) => handleCustomerOrder(c.req.raw, c.req.param('number'), opts.currentUserId));
}
