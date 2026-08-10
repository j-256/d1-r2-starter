# Publishing the template repos

This repo is the private factory. The two public template repos are generated, never edited directly.

## Regenerate

```bash
npm run generate
```

This writes `dist/openai/` and `dist/wrangler/`, each gated by a residue scan and an in-tree buildless test run. A non-zero exit means a gate failed; fix the source under `variants/` or the shared core and re-run.

## Publish a template (per variant)

Publishing is a fresh, single-commit history (satisfies "one clean commit"):

```bash
cd dist/<variant>            # openai or wrangler
git init -b main
git add -A
git commit -m "Initial commit"      # one clean commit; no factory history
```

Then create the GitHub repo and push. NOTE: creating/pushing is a deliberate, explicitly-authorized act - do not push without a direct request.

```bash
# names are locked: d1-r2-starter-openai / d1-r2-starter-wrangler
gh repo create d1-r2-starter-<variant> --public --source=. --remote=origin --push
```

After the first push, mark the repo as a template (Settings -> Template repository, or `gh repo edit --template`).

## Pre-publish checklist

- [ ] `npm run generate` exits 0 (both guards + both in-tree suites green)
- [ ] wrangler tree verified under its toolchain (typecheck, migrations apply, `wrangler dev` smoke)
- [ ] openai Sites build confirmed (`npm run test:build`) or delegated to the remote Sites builder (recorded)
- [ ] `dist/openai/.openai/hosting.json` `project_id` is the placeholder, not the real id
- [ ] each tree has a `LICENSE` (MIT) and `"license": "MIT"` in `package.json`
- [ ] wrangler tree has no `next`/`react`/`vinext` deps and no `oai-`/`chatgpt`/`vinext` tokens (guard enforces)
