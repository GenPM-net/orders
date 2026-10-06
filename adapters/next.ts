// Adaptador Next.js: `app/api/orders/[number]/route.ts` → `export const { GET } = orderRoute(currentUserId);`
// En una página de servidor usa `getOrderForCustomer(number, { userId, token })` y `publicOrder`.
import { type CurrentUserId, handleCustomerOrder } from './http.js';

export { publicOrder } from './http.js';

export const orderRoute = (currentUserId: CurrentUserId) => ({
  GET: async (req: Request, ctx: { params: Promise<{ number: string }> }) => handleCustomerOrder(req, (await ctx.params).number, currentUserId),
});
