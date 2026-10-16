# @core/orders

[![genpm](https://api.genpm.net/v1/badge/@core/orders.svg)](https://genpm.net/p/@core/orders) ![license](https://img.shields.io/badge/license-MIT-blue)

> Orders: frozen lines, stock reservation, payment and shipping states, partial shipments, refunds, emails and events

A [GenPM](https://genpm.net) module: **source code + AI rules + MCP config**, injected into your project instead of hidden in `node_modules`. The code lands in `src/lib/orders`, pinned to a verified commit, and you own it.

## Install

```bash
genpm add @core/orders
```

No genpm yet? `curl -fsSL https://genpm.net/install.sh | sh` (macOS/Linux), `irm https://genpm.net/install.ps1 | iex` (Windows), or one-off with `npx @genpm-net/cli add @core/orders`.

Or let your AI agent do it: run `genpm mcp setup` once, then ask *"add @core/orders with genpm"* in Claude Code, Cursor, VS Code, Windsurf, Codex or Gemini CLI. It shows you a dry-run plan before writing anything.

## What it does

Orders after payment: lines frozen at purchase time (name, price, discount), stock reserved in the same transaction
(@core/catalog), sequential order numbers, two independent states — payment (`pending → paid → partially_refunded/refunded`,
or `cancelled`) and fulfillment (`unfulfilled → partial → fulfilled → delivered`) — partial shipments with tracking,
refunds through the registered `PaymentProvider`, a timeline, customer access by owner session or signed link, and
background events (`onOrderEvent`) with built-in emails (confirmation, shipped, refund). Payment itself is @core/checkout.

## Setup

After `genpm add`, follow these steps (your AI agent finds the same steps in `src/lib/orders/AGENTS.md` and can do them for you):

1. Env: `ORDER_LINK_SECRET` (≥ 32 chars), `SITE_URL`, `EMAIL_FROM`, optional `ORDER_NUMBER_PREFIX`. Migrations as in `src/lib/db/AGENTS.md`; the @core/jobs cron must run.
2. Orders are created by @core/checkout from the paid cart; for manual flows call `createOrder({ … })`. To test the
   paid flow without a payment provider: `createOrder({ …, payment: { provider: 'manual', ref: 'test', status: 'pending' } })`,
   then `markPaid(order.id, { provider: 'manual', ref: 'test' })`; the `paid` handlers (emails, @core/suppliers) run as
   @core/jobs jobs, so call `runDue()` (or wait for `/api/cron`).
3. Customer page `/orders/[number]`: `getOrderForCustomer(number, { userId, token })` (404 when null) rendered with `publicOrder`.
4. React to events in a module imported at startup: `onOrderEvent('paid', 'my-crm', async (order) => …)`.
   Translate emails with `setOrderMessages((locale) => ({ … }))`. For bookkeeping that must be atomic with the payment
   (e.g. counting coupon uses) use `onOrderPaidTx(name, async (order, tx) => …)`: it runs inside the order transaction,
   must be fast and must not throw for business rules (a throw aborts the order).
5. Add `ordersAdminResource` to `src/genpm/admin.ts` (permissions `orders:read|update|fulfill|refund`).
6. Verify: create a paid order, ship it from the admin with a tracking URL, the customer gets both emails.

## What's inside

Paths are relative to `src/lib/orders`.

- `index.ts` — public API: `createOrder`, `markPaid`, `addFulfillment`, `markDelivered`, `cancelOrder`, `refundOrder`, `getOrder`, `getOrderForCustomer`, `onOrderEvent`, `onOrderPaidTx`, `registerPaymentProvider`, `ordersAdminResource`, `setOrderMessages`.
- `orders.ts` — logic and the `orders.event` job. `emails.ts` — default emails. `admin.ts` — admin. `schema.ts` — tables.
- `adapters/hono.ts` — `orderRoutes({ currentUserId })`. `adapters/next.ts` — `orderRoute`, `publicOrder`.

## At a glance

- **GenPM dependencies** (installed with it): [@core/db](https://genpm.net/p/@core/db), [@core/auth](https://genpm.net/p/@core/auth), [@core/catalog](https://genpm.net/p/@core/catalog), [@core/email](https://genpm.net/p/@core/email), [@core/jobs](https://genpm.net/p/@core/jobs), [@core/money](https://genpm.net/p/@core/money), [@core/contracts](https://genpm.net/p/@core/contracts)
- **npm dependencies** (proposed, never installed without asking): `zod`
- **Environment variables** (added to `.env.example`): `ORDER_LINK_SECRET`, `ORDER_NUMBER_PREFIX`, `SITE_URL`
- **AI rules**: [`AGENTS.md`](AGENTS.md), loaded by your agent only when it works in `src/lib/orders`

## Security

GenPM installs a 40-character commit SHA (never a branch), verifies an Ed25519-signed manifest, never runs install scripts and scans AI rules for prompt injection. Details: [genpm.net/docs/security](https://genpm.net/docs/security).

## License

MIT — see [LICENSE](LICENSE). Browse the full catalog at [genpm.net](https://genpm.net).
