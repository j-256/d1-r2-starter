# D1 + R2 starter for Cloudflare Workers

Start with a working D1 + R2 feature you can understand, run, and reshape.

This TypeScript starter pairs queryable metadata in [Cloudflare D1](https://developers.cloudflare.com/d1/) with binary file content in [Cloudflare R2](https://developers.cloudflare.com/r2/). Its document library is a thin but real example: upload, search, download, and delete files through one tested feature boundary, then keep it or replace it with your own data model. Built with [Hono](https://hono.dev) and deployed with Wrangler.

The platform shell is data-model-neutral. `features/documents/` is the deliberately concrete example that shows how D1 and R2 work together.

Prefer a managed hosting workflow? The [ChatGPT Sites edition](https://github.com/j-256/d1-r2-starter-openai) is maintained as a first-class peer with the same application core.

## What you get

- **A useful vertical slice.** D1 stores searchable document metadata while R2 stores the original binary bytes and content type.
- **A replaceable feature, not a prescribed schema.** Routes and persistence live behind `DocumentService`, `DocumentRepository`, and `ObjectStore` contracts.
- **Two first-class runtime editions.** This Wrangler/Hono edition and the ChatGPT Sites edition use the same feature, validation, persistence, HTTP semantics, migrations, and tests. Only runtime composition, routing glue, authorization policy, and UI are edition-specific.
- **Auth that fails closed.** Every `/api` request requires the configured bearer secret. A missing secret denies every request.
- **Deterministic setup and buildless tests.** The lockfile supports `npm ci`, while the shared core suite can also run directly with Node without installing framework dependencies.

## Quickstart

```bash
npm ci
npx wrangler d1 create d1-r2-starter
npx wrangler r2 bucket create d1-r2-starter
```

Paste the D1 command's `database_id` into `wrangler.jsonc`, then finish setup and deploy:

```bash
npx wrangler d1 migrations apply d1-r2-starter --remote
npx wrangler secret put SHARED_SECRET
npm run deploy
```

Every document API request must include `Authorization: Bearer <SHARED_SECRET>`.

## Local development

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply d1-r2-starter --local
npm run dev
```

Set `SHARED_SECRET` in the ignored `.dev.vars` file before starting the Worker.

## Document API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/documents?q=<name>` | List recent documents, optionally filtering by filename |
| `POST` | `/api/documents` | Upload multipart field `file` with optional text field `description` |
| `GET` | `/api/documents/:id` | Download the original binary content |
| `DELETE` | `/api/documents/:id` | Delete the object and metadata; repeated deletes still succeed |

Uploads are bounded by the example's named limits in `features/documents/contracts.ts`. Adjust those limits as part of adapting the feature to your product.

## Architecture

```text
Hono route
    |
    v
shared Web Request/Response handlers
    |
    v
DocumentService
   |             |
   v             v
D1 metadata    ObjectStore -> R2 bytes
```

- `features/documents/` owns the document contracts, validation, HTTP behavior, D1 repository, schema, and coordination service.
- `platform/` owns the narrow runtime-facing contracts for Cloudflare bindings, object storage, authorization, and request context.
- `app-context.ts` and `app-services.ts` carry app-specific request state and compose the example feature with D1 and R2, leaving the lower-level platform modules independent of the document model.
- `src/worker.ts` is the thin Hono composition root. It supplies bindings and the bearer-secret authorizer, then delegates to the shared handlers.
- `db/schema.ts` exports feature schemas, and `drizzle/` contains the migration history applied before application code depends on it.
- `tests/` exercises the shared feature against fakes and an in-memory SQLite database, including binary data that is not valid UTF-8.

The shared handlers use standard `Request` and `Response` objects, so feature behavior is not coupled to Hono context objects or Next.js route helpers.

## Cross-store consistency

D1 and R2 do not share a transaction, so `DefaultDocumentService` makes the policy explicit:

- Create writes the R2 object first, then inserts D1 metadata. If the D1 insert fails, it attempts to remove the new object.
- Delete removes the R2 object first, then deletes D1 metadata. If the metadata delete fails, retrying repeats the object deletion and attempts the remaining metadata cleanup again.
- Download treats D1 metadata whose R2 object is missing as a consistency error, not a successful empty file.

These choices fit this small example. Revisit them if your product needs background repair, versioning, large streaming uploads, audit history, or a stronger delivery guarantee.

## Change the data model

You do not need to reshape your product into `DocumentMetadata`. Treat the document library as a worked feature module:

1. Add or replace a directory under `features/` with your domain types, service, validation, persistence, and shared HTTP handlers.
2. Export its Drizzle tables from `db/schema.ts`, then run `npm run db:generate -- --name <descriptive-name>` and inspect the SQL.
3. Compose the feature's repository and storage dependencies in `app-services.ts`.
4. Keep `src/worker.ts` thin by delegating standard `Request` objects to the shared handlers.
5. Replace or extend `public/index.html` with the interface your feature needs.

If the document model fits but the provider does not, implement `DocumentRepository` or `ObjectStore` and change only the composition in `app-services.ts`. If your app needs several domain features, add them beside `features/documents/` and expose each service through `AppServices`.

## Authorization

Every document handler calls an injected `Authorizer` before parsing a request or touching storage. `src/worker.ts` injects `sharedSecretAuthorizer(env.SHARED_SECRET)`, which fails closed when no secret is configured and compares equal-length candidates without an early exit.

The static page itself is public. Do not place sensitive data in `public/`; the shared secret protects only `/api/*`. Replace the authorizer at the composition seam when your product needs per-user identity, roles, signed sessions, or another access policy.

## Schema changes

`drizzle/0000_create-documents.sql` creates the document metadata table and indexes. Treat committed migrations as immutable history. Change a feature schema, run `npm run db:generate -- --name <descriptive-name>`, inspect the generated SQL, and apply the new migration before deploying code that depends on it.

```bash
npx wrangler d1 migrations apply d1-r2-starter --local
npx wrangler d1 migrations apply d1-r2-starter --remote
```

## Commands

- `npm run dev`: start the Worker locally with Wrangler
- `npm run deploy`: deploy the Worker with Wrangler
- `npm test`: run the shared buildless feature suite
- `npm run typecheck`: check project TypeScript without emitting files
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Prerequisites

- Node.js `>=22.13.0`
- A Cloudflare account with D1 and R2 available

## License

MIT. See `LICENSE`.
