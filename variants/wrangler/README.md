# Cloudflare D1 + R2 starter (self-hosted)

Ship a Cloudflare Worker backed by [D1](https://developers.cloudflare.com/d1/) (SQL) and [R2](https://developers.cloudflare.com/r2/) (object storage) to your own account, with the parts that are easy to get wrong already done right: fail-closed auth, migration-owned schema, and a storage core you can point at a different database or object store without rewriting your API. Built on [Hono](https://hono.dev) and deployed with `wrangler deploy`.

## Why start here

- **Swappable storage core.** Your routes talk to one provider-neutral `TextStore` contract, never to D1 or R2 directly. Swap adapters at a single seam (`storage/create-services.ts`) to target another SQLite-compatible database or object store, and the API and UI stay the same.
- **Auth that fails closed.** Every `/api` request runs a required authorizer; there is no allow-all default. It ships a constant-time shared-secret check, so a deployment that forgets to set a secret denies every request instead of exposing your data.
- **Schema truth lives in migrations.** Drizzle owns the schema; the adapters never `CREATE TABLE` at runtime, so the database can't drift from the code. A worked migration (`0001`) shows how to evolve it with a backwards-compatible column.
- **Tests run with zero install.** The core suite is buildless: no `node_modules`, no build step, so you can verify the storage contract before you deploy anything.

## Quickstart

```bash
npm install
wrangler d1 create d1-r2-starter          # paste the printed database_id into wrangler.jsonc
wrangler r2 bucket create d1-r2-starter
wrangler d1 migrations apply d1-r2-starter --remote
wrangler secret put SHARED_SECRET          # the bearer secret clients must send
wrangler deploy
```

Clients then send `Authorization: Bearer <SHARED_SECRET>` on every request to `/api/d1` and `/api/r2`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # edit SHARED_SECRET
wrangler d1 migrations apply d1-r2-starter --local
wrangler dev
```

Open the printed local URL for the console. It prompts for the shared secret and sends it as a bearer token on every request.

## Architecture

```text
static console (public/index.html)
        |  fetch /api/d1, /api/r2  (Authorization: Bearer <SHARED_SECRET>)
        v
Hono worker (src/worker.ts) -> shared route factory (routes/) -> D1 / R2 adapter -> binding
```

`src/worker.ts` is the only Cloudflare-specific code: it builds services from the `DB`/`BUCKET` bindings, injects a `sharedSecretAuthorizer`, and mounts the shared route factory. Everything under `storage/`, `db/`, `drizzle/`, and `routes/` imports no platform APIs, which is what lets the core run unchanged on another runtime.

## Authorization

Every `/api` request must send `Authorization: Bearer <SHARED_SECRET>`. The worker injects `sharedSecretAuthorizer(env.SHARED_SECRET)`, which compares in constant time and fails closed when no secret is configured. There is no allow-all path, so an unconfigured or misconfigured deployment denies requests rather than leaking storage.

## Schema changes

Edit `db/schema.ts`, run `npm run db:generate`, inspect the generated SQL under `drizzle/`, then `wrangler d1 migrations apply`. Treat committed migrations as immutable history.

## Tests

The buildless core suite needs no dependencies and no build step:

```bash
node --experimental-sqlite --experimental-strip-types --test tests/*.test.ts
```

## License

MIT. See `LICENSE`.
