# Publishing the template repositories

This repository is the source factory for two GitHub templates: `d1-r2-starter-openai` and `d1-r2-starter-wrangler`. Make changes in the factory, regenerate the templates, and publish the generated outputs. Do not edit the template repositories directly because the next publication replaces their working trees from the factory output.

## How publication works

From a clean `main` branch, run the publisher without a variant to process both templates:

```bash
npm run template:publish
```

Pass `openai` or `wrangler` when you want to limit the run to one template:

```bash
npm run template:publish -- openai
```

The publisher performs the following work in clearly labeled phases:

1. Confirms that the factory worktree is clean and that `HEAD` matches `origin/main`
2. Runs the factory tooling tests and generates both templates once, even when both repositories are selected
3. Compares every selected generated tree with its GitHub template repository in a disposable checkout
4. Shows the complete staged diff only for templates that changed
5. Prompts for an update commit message when none was supplied, then asks you to type the repository name before continuing
6. Commits the exact changed paths, publishes `main`, confirms the remote commit, and verifies that GitHub recognizes the repository as a template
7. Prints a compact summary showing whether each selected template was unchanged, created, updated, or cancelled

If a generated tree already matches its existing template repository, the publisher does not ask for a message or confirmation and does not create a commit or push.

## First publication

When a selected GitHub repository does not exist, the publisher creates it as a public repository, pushes an initial commit, and enables the GitHub template setting. The initial commit message defaults to `Initial commit`, so no message is required for this first publication:

```bash
npm run template:publish -- openai
```

## Updating an existing template

When a repository already exists, the publisher clones it and creates a normal update commit from the newly generated tree. It does not run `gh repo create` again and it does not rewrite published history. If the generated tree changed and you did not pass `--message`, the publisher shows the diff and asks for a commit message.

You can provide the message in the command instead:

```bash
npm run template:publish -- openai --message "Add portable authorization boundary"
```

Without a variant, one supplied message is used for every changed template selected by the run:

```bash
npm run template:publish -- --message "Refresh generated templates"
```

Omit `--message` when the templates need different commit messages; the publisher prompts for each changed repository separately.

The template repository retains its maintainer history. Repositories created from a GitHub template still start with a single commit, so preserving that history does not add factory commits to downstream projects. See [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

## Non-interactive publication

Pass `--yes` to skip typing each changed repository name. The full staged diff is still printed before the commit. A changed existing repository also requires `--message` in this mode because an interactive message prompt is unavailable. Use this only when the command invocation itself is the publication approval, such as a controlled release job:

```bash
npm run template:publish -- wrangler --message "Refresh Worker dependencies" --yes
```

## Pre-publish checklist

- [ ] Shared core changes are complete and committed on `main`
- [ ] The Wrangler tree has been verified under its own toolchain with typecheck, migration application, and a `wrangler dev` smoke test
- [ ] The OpenAI Sites artifact has been confirmed with `npm run test:build` or through the Sites save-version workflow
- [ ] `dist/openai/.openai/hosting.json` has no `project_id`, allowing Sites to provision a new project from the reusable template
- [ ] Each generated tree contains the MIT license and matching package metadata
- [ ] The generated Wrangler tree contains no OpenAI, ChatGPT, Next.js, React, or Vinext residue

The publisher enforces the clean factory state, factory tooling tests, generation gates, emitted manifest project-linkage guard, residue rules, generated tests, explicit changed-path commit, and remote verification. The runtime-specific smoke checks remain manual because they require provisioned Cloudflare or Sites environments.
