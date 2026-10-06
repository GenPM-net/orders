# @core/orders — rules for AI agents

## Purpose
Orders after payment: lines frozen at purchase time (name, price, discount), stock reserved in the same transaction
(@core/catalog), sequential order numbers, two independent states — payment (`pending → paid → partially_refunded/refunded`,
or `cancelled`) and fulfillment (`unfulfilled → partial → fulfilled → delivered`) — partial shipments with tracking,
refunds through the registered `PaymentProvider`, a timeline, customer access by owner session or signed link, and
background events (`onOrderEvent`) with built-in emails (confirmation, shipped, refund). Payment itself is @core/checkout.

## Map
- `index.ts` — public API: `createOrder`, `markPaid`, `addFulfillment`, `markDelivered`, `cancelOrder`, `refundOrder`, `getOrder`, `getOrderForCustomer`, `onOrderEvent`, `onOrderPaidTx`, `registerPaymentProvider`, `ordersAdminResource`, `setOrderMessages`.
- `orders.ts` — logic and the `orders.event` job. `emails.ts` — default emails. `admin.ts` — admin. `schema.ts` — tables.
- `adapters/hono.ts` — `orderRoutes({ currentUserId })`. `adapters/next.ts` — `orderRoute`, `publicOrder`.

## Integration
1. Env: `ORDER_LINK_SECRET` (≥ 32 chars), `SITE_URL`, `EMAIL_FROM`, optional `ORDER_NUMBER_PREFIX`. Migrations as in `src/lib/db/AGENTS.md`; the @core/jobs cron must run.
2. Orders are created by @core/checkout from the paid cart; for manual flows call `createOrder({ … })`.
3. Customer page `/orders/[number]`: `getOrderForCustomer(number, { userId, token })` (404 when null) rendered with `publicOrder`.
4. React to events in a module imported at startup: `onOrderEvent('paid', 'my-crm', async (order) => …)`.
   Translate emails with `setOrderMessages((locale) => ({ … }))`. For bookkeeping that must be atomic with the payment
   (e.g. counting coupon uses) use `onOrderPaidTx(name, async (order, tx) => …)`: it runs inside the order transaction,
   must be fast and must not throw for business rules (a throw aborts the order).
5. Add `ordersAdminResource` to `src/genpm/admin.ts` (permissions `orders:read|update|fulfill|refund`).
6. Verify: create a paid order, ship it from the admin with a tracking URL, the customer gets both emails.

## Conventions
- Change states only with these functions; they lock the order row and validate transitions.
- Cancel only unfulfilled orders; after shipping, refund instead (optionally restocking returned lines).
- A paid order that was cancelled is refunded with `refundOrder` (up to `total - refundedTotal`, no `restock`: the
  stock was returned when cancelling); it stays `cancelled`.
- Event handlers must be idempotent; each runs once per event and retries if it fails.

## Don't
- Don't delete orders or edit their lines/totals after creation (legal and accounting record).
- Don't expose orders by id or number without the owner check or the signed token.
- Don't mark orders paid from the browser's success redirect; only from the payment webhook or the admin.
