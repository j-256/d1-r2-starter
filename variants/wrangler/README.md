# D1 + R2 starter (Wrangler)

A minimal, self-hosted Cloudflare Worker that drives [D1](https://developers.cloudflare.com/d1/) (SQL) and [R2](https://developers.cloudflare.com/r2/) (object storage) behind one provider-neutral `TextStore` contract. Built on [Hono](https://hono.dev) and deployed with `wrangler deploy`. The storage core (`storage/`, `db/`, `drizzle/`, `routes/`) is platform-neutral and verified by a buildless Node test suite.

## Architecture

```text
static console (public/index.html)
        |  fetch /api/d1, /api/r2  (Authorization: Bearer <SHARED_SECRET>)
        v
Hono worker (src/worker.ts) -> shared route factory (routes/) -> D1 / R2 adapter -> binding
```

`src/worker.ts` is the only Cloudflare-specific code: it builds services from the `DB`/`BUCKET` bindings, injects a `sharedSecretAuthorizer`, and mounts the shared route factory. Everything under `storage/`, `db/`, `drizzle/`, `routes/` imports no platform APIs.

## Authorization

Every `/api` request must send `Authorization: Bearer <SHARED_SECRET>`. The worker injects `sharedSecretAuthorizer(env.SHARED_SECRET)`, which fails closed if no secret is configured. There is no allow-all default.

## Setup and deploy

```bash
npm install

# 1. Create the D1 database, then paste the printed database_id into wrangler.jsonc
wrangler d1 create d1-r2-starter

# 2. Create the R2 bucket
wrangler r2 bucket create d1-r2-starter

# 3. Apply the Drizzle migrations to D1 (creates the d1_values table)
wrangler d1 migrations apply d1-r2-starter --remote

# 4. Set the production shared secret
wrangler secret put SHARED_SECRET

# 5. Deploy
wrangler deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # edit SHARED_SECRET
wrangler d1 migrations apply d1-r2-starter --local
wrangler dev
```

Open the printed local URL for the console. It prompts for the shared secret and sends it as a bearer token on every request.

## Tests

The buildless core suite needs no dependencies and no build step:

```bash
node --experimental-sqlite --experimental-strip-types --test tests/*.test.ts
```

## Schema changes

Edit `db/schema.ts`, run `npm run db:generate`, inspect the generated SQL under `drizzle/`, then `wrangler d1 migrations apply`. Treat committed migrations as immutable history.

## License

MIT. See `LICENSE`.
