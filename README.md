# Starter storage control plane

A small, private D1 and R2 control plane running on
[Vinext](https://github.com/cloudflare/vinext). The application is written in
strict TypeScript and keeps provider-specific storage behavior behind a shared
text-storage contract.

## Prerequisites

- Node.js `>=22.13.0`
- Linux with `flock`, `curl`, and GNU `timeout`

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. `build` applies a short timeout and then validates the Sites artifact. These helpers target Linux and use GNU `timeout`; they are not native macOS scripts.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. The `dev` and `start` scripts honor the caller's runtime environment and keep Wrangler logs inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Architecture

The core application depends on the provider-neutral `TextStore` interface in
`storage/contracts.ts`, not on Cloudflare bindings:

```text
HTTP route -> TextStore -> D1 or R2 adapter -> runtime binding
```

- `app/api/_shared/text-store-route.ts` owns request parsing, validation, and
  the stable HTTP response shape used by both resources.
- `storage/adapters/` contains the only D1- and R2-specific persistence logic.
- `storage/create-services.ts` is the composition seam. Swap the adapters here
  to target another SQLite-compatible database or object store without changing
  the API routes or UI.
- `runtime/storage-context.ts` isolates the request-context bridge required to
  pass Worker bindings into Vinext route handlers.
- `worker/index.ts` is the platform composition root; application and storage
  contract modules do not import Cloudflare runtime APIs.
- `db/schema.ts` remains the migration source of truth, and generated SQL stays
  under `drizzle/`.
- `.openai/hosting.json` declares the logical D1 and R2 binding names managed by
  Sites.

## D1 migrations

The checked-in migration history intentionally includes one minimal evolution
example:

- `0000_complex_thena.sql` creates `d1_values`.
- `0001_add-content-type-demo.sql` adds a non-null `content_type` column with a
  backwards-compatible default, then inserts one idempotent `demo:migration`
  row so the applied migration is visible in the D1 explorer.

Treat committed migration files as immutable history. Change `db/schema.ts`,
run `npm run db:generate -- --name <descriptive-name>`, inspect the generated
SQL, and add explicit data backfills only when the schema change requires them.
The production build packages the full migration history under
`dist/.openai/drizzle/` for Sites to apply before the new Worker version runs.

The compiler enables strict mode plus unchecked-index, exact-optional-property,
unused-code, implicit-return, fallthrough, and casing checks. Library declaration
files remain skipped because Vinext, Next.js, and Cloudflare own those external
types; all project TypeScript is still checked.

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
- `npm test`: type-check, build, validate, and verify the rendered development-preview metadata
- `npm run validate:artifact`: recheck an existing artifact's manifest and ESM `default.fetch` export
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use build and validation commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
