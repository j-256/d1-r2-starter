# Repository guidance

Read [README.md](README.md) before changing this repository. Before changing generation, replay, backup, or publication behavior, also read [docs/PUBLISH.md](docs/PUBLISH.md).

## Canonical source model

This factory is the canonical source for both generated template repositories. Fix shared or edition-specific defects here and publish regenerated outputs; do not repair `d1-r2-starter-openai` or `d1-r2-starter-wrangler` directly. Treat findings from either downstream repository as reports against the corresponding generated product.

Keep shared feature contracts, persistence, migrations, and tests under `features/`, `platform/`, `db/`, `drizzle/`, and `test/`. The repository root owns the executable ChatGPT Sites shell, `variants/openai/` owns its template-only replacements, and `variants/wrangler/` owns the Hono/Wrangler shell. Do not leak runtime-specific dependencies or framework assumptions into shared code.

`dist/openai/` and `dist/wrangler/` are disposable generated trees. Never edit or commit them. Change the factory source or the appropriate overlay, regenerate both editions, and preserve the residue guards. Factory-only maintainer guidance, publication tooling, local hosting linkage, and recovery state must not ship in either template.

Treat committed Drizzle migrations as immutable history. Change the schema source, generate a descriptively named migration with `npm run db:generate -- --name <name>`, inspect the SQL, and add explicit backfills when required.

## Verification

Install with `npm ci`. Run focused tests while iterating, then run the complete release gate before considering a factory change complete:

```bash
npm run release:check
```

That gate covers unit and documentation checks, generator and publisher tests, generation of both templates, residue checks, lint, and the Sites production build. Inspect generated output when changing copy lists, overlays, package filtering, workflows, migrations, or public documentation. Do not weaken an allowlist, residue scan, generated-tree test, or artifact check merely to admit unintended output.

## Publication and release boundary

`npm run template:publish` is a maintainer publication workflow that can commit and push downstream histories, advance factory cursors, create recovery mirrors, or replace history. Run it only with explicit approval for the selected templates and history mode, and let it own diffs, commits, leases, backups, verification, and cursor updates. Never reproduce those mutations manually.

`npm version` runs the complete release gate and its lifecycle pushes `main` and the tag. Do not invoke it without explicit release and push approval.
