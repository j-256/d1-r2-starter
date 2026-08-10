# Cloudflare D1 + R2 starter (OpenAI Sites)

A D1 (SQL) and R2 (object storage) control plane that deploys on OpenAI Sites (which runs on Cloudflare), with the parts that are easy to get wrong already done right: explicit auth with no allow-all default, migration-owned schema, and a storage core you can point at a different database or object store without rewriting your API. Written in strict TypeScript on [Vinext](https://github.com/cloudflare/vinext).

## Why start here

- **Swappable storage core.** Your routes talk to one provider-neutral `TextStore` contract, never to D1 or R2 directly. Swap adapters at a single seam (`storage/create-services.ts`) to target another SQLite-compatible database or object store, and the API and UI stay the same.
- **Auth is always explicit.** The core ships no allow-all default: the composition root must supply a concrete `Authorizer`, so the auth decision is never implicit. This hosted variant trusts the Sites access policy via `platformTrustAuthorizer`; a self-hosted deployment swaps in a real check at the same seam.
- **Schema truth lives in migrations.** Drizzle owns the schema; the adapters never `CREATE TABLE` at runtime, so the database can't drift from the code. A worked migration (`0001`) shows how to evolve it with a backwards-compatible column.
- **Tests run with zero install.** The core suite is buildless: no `node_modules`, no build step, so you can verify the storage contract before you deploy anything.

## Quickstart

This starter is already wired for OpenAI Sites. Edit the source under `app/`, then checkpoint when a milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit, and the migrations under `drizzle/` are applied by the platform before the new Worker version runs, so there is no manual install, build, or migrate step in the normal flow.

For local iteration:

```bash
npm run dev          # start the Vite/Vinext dev server
npm test             # run the buildless core suite (no node_modules needed)
```

## Architecture

The core application depends on the provider-neutral `TextStore` interface in
`storage/contracts.ts`, not on Cloudflare bindings:

```text
HTTP route -> TextStore -> D1 or R2 adapter -> runtime binding
```

- `routes/text-store-route.ts` owns request parsing, validation, the
  authorization gate, and the stable HTTP response shape used by both resources.
  `app/api/d1/route.ts` and `app/api/r2/route.ts` are thin delegators that
  re-export it.
- `storage/contracts.ts` also defines an optional `contentType` on stored items;
  both adapters persist and return it (D1 in a column, R2 in object HTTP
  metadata), defaulting to `text/plain; charset=utf-8`.
- `storage/adapters/` contains the only D1- and R2-specific persistence logic.
- `storage/create-services.ts` is the composition seam. Swap the adapters here
  to target another SQLite-compatible database or object store without changing
  the API routes or UI.
- `storage/authorizer.ts` defines the provider-neutral `Authorizer` boundary
  (see Authorization below).
- `runtime/storage-context.ts` isolates the request-context bridge that passes
  the storage services and the request authorizer into Vinext route handlers.
- `worker/index.ts` is the platform composition root; application and storage
  contract modules do not import Cloudflare runtime APIs.
- `db/schema.ts` is the sole schema source of truth. The adapters do NOT create
  tables at runtime; the generated migrations under `drizzle/` own the schema and
  must be applied before first use (see D1 migrations).
- `.openai/hosting.json` declares the logical D1 and R2 binding names managed by
  Sites.

The core under `storage/`, `db/`, and `drizzle/` imports no platform APIs, so
the same product logic runs unchanged on another runtime; this repository wires
it to the hosted OpenAI Sites platform.

## Authorization

Every storage route calls an injected `Authorizer` (`storage/authorizer.ts`)
before touching D1 or R2. The core ships no allow-all default: the composition
root must supply a concrete authorizer, so the auth decision is always explicit.

This hosted variant injects `platformTrustAuthorizer` in `worker/index.ts`,
which trusts the Sites access policy in front of the Worker and allows every
request that reaches it. A self-hosted deployment MUST replace this with a real
check (for example a shared-secret or bearer-token authorizer reading from an
env binding) before exposing the routes.

## D1 migrations

The checked-in migration history intentionally includes one minimal evolution
example:

- `0000_complex_thena.sql` creates `d1_values`.
- `0001_add-content-type-demo.sql` adds a non-null `content_type` column with a
  backwards-compatible default, then inserts one idempotent `demo:migration`
  row so the applied migration is visible in the D1 explorer. The `content_type`
  column is real: it is part of the `TextStore` contract and is stored and
  returned by both adapters.

Timestamps are stored as ISO-8601 UTC (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` as
the column default, matching the adapter's `new Date().toISOString()`), so
lexical ordering of `updated_at` equals chronological ordering.

Treat committed migration files as immutable history. Change `db/schema.ts`,
run `npm run db:generate -- --name <descriptive-name>`, inspect the generated
SQL, and add explicit data backfills only when the schema change requires them.
The production build packages the full migration history under
`dist/.openai/drizzle/` for Sites to apply before the new Worker version runs.

If you self-host instead of using Sites, apply the migrations to your own D1
database before the first run so the `d1_values` table exists:

```bash
wrangler d1 migrations apply <DATABASE>
```

The compiler enables strict mode plus unchecked-index, exact-optional-property,
unused-code, implicit-return, fallthrough, and casing checks. Library declaration
files remain skipped because Vinext, Next.js, and Cloudflare own those external
types; all project TypeScript is still checked.

## Prerequisites

- Node.js `>=22.13.0`
- Linux with `flock`, `curl`, and GNU `timeout` (for the Sites build helpers)

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. `build` applies a short timeout and then validates the Sites artifact. These helpers target Linux and use GNU `timeout`; they are not native macOS scripts.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. The `dev` and `start` scripts honor the caller's runtime environment and keep Wrangler logs inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Diagnostic Commands

- `npm run install:ci`: perform the one bounded lockfile install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: type-check, build, and validate the deployable Sites artifact
- `npm run start`: start the built Vinext application
- `npm run typecheck`: run the strict TypeScript compiler without emitting files
- `npm test`: run the buildless core test suite (storage adapters, migrations, and the route authorization gate) with no build step
- `npm run test:build`: run the full Sites build and artifact validation (Linux only; needs GNU `timeout`)
- `npm run validate:artifact`: recheck an existing artifact's manifest and ESM `default.fetch` export
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use build and validation commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
