# Publishing the template repositories

This repository is the source factory for two GitHub templates: `d1-r2-starter-openai` and `d1-r2-starter-wrangler`. Make changes in the factory, regenerate the templates, and publish the generated outputs. Do not edit the template repositories directly because the next publication replaces their working trees from the factory output.

## How publication works

From a clean `main` branch, run the publisher without a variant to process both templates:

```bash
npm run template:publish
```

Use `all` when you want the command to state that choice explicitly. `both` is accepted as an alias:

```bash
npm run template:publish -- all
```

Pass `openai` or `wrangler` when you want to limit the run to one template:

```bash
npm run template:publish -- openai
```

The publisher performs the following work in clearly labeled phases:

1. Surfaces any retained recovery mirrors from earlier fresh publications
2. Confirms that the factory worktree is clean and that `HEAD` matches `origin/main`
3. Runs the factory tooling tests and generates both templates once, even when both repositories are selected
4. Compares every selected generated tree with its GitHub template repository in a disposable checkout
5. Shows the complete staged diff for every planned publication
6. For each changed existing repository, asks whether to append a normal commit or replace `main` with a fresh root commit when `--history` was not supplied
7. Resolves the root-commit default or prompts for a missing append message, then asks for final yes-or-no publication approval
8. Publishes `main`, confirms the remote commit, and verifies that GitHub recognizes the repository as a template
9. After an interactive fresh publication, offers a yes-or-no choice to move the verified recovery mirror to Trash
10. Prints a compact summary showing whether each selected template was unchanged, created, updated, replaced, or cancelled

If a generated tree already matches its existing template repository, the publisher normally does not ask for a message or confirmation and does not create a commit or push. Explicit `--history fresh` is the exception because replacing maintainer history is itself the requested publication.

Explicit fresh mode is preflighted before tests and generation. If any selected template has a retained recovery mirror, the command stops immediately.

## First publication

When a selected GitHub repository does not exist, the publisher creates it as a public repository, pushes an initial commit, and enables the GitHub template setting. The initial commit message defaults to `Initial commit`, so no message is required for this first publication:

```bash
npm run template:publish -- openai
```

## Choosing history for an existing template

When a repository already exists and its generated tree changed, the publisher shows the diff and asks how to record the publication:

1. `append` (recommended) adds a normal commit to the template repository's maintainer history. It preserves an audit trail and makes rollback straightforward.
2. `fresh` replaces `main` with one new root commit containing the complete generated tree. It force-pushes with a lease and rewrites the template repository's maintainer history.

The publisher does not auto-squash commits. An append publication remains a normal child commit in the template repository. GitHub's separate template-generation behavior still gives a new downstream repository created with "Use this template" a single initial commit, regardless of how many maintainer commits the template repository has. See [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

### Append a normal update

Choose `append` at the interactive prompt or pass it explicitly:

```bash
npm run template:publish -- openai --history append --message "Add portable authorization boundary"
```

Append uses a normal push and reports the template as `updated`.

### Replace history with a fresh root

Choose `fresh` at the interactive prompt or pass it explicitly:

```bash
npm run template:publish -- openai --history fresh
```

Fresh mode defaults to `Initial commit`; pass `--message` only when you want a different root-commit message.

Before changing any ref, the publisher creates a bare mirror of the existing repository and verifies that the mirror contains the exact `main` commit observed during comparison. It stores the mirror under `TEMPLATE_PUBLISH_BACKUP_DIR` when that variable is set, otherwise under `${XDG_STATE_HOME:-$HOME/.local/state}/d1-r2-starter/template-publish-backups`. The summary prints the exact retained path.

Fresh mode creates a parentless commit, then pushes with `--force-with-lease` pinned to the previously observed remote commit. If another publication moves `main` first, the push fails without overwriting it. The interactive publication prompt names the repository and the history-replacing action; answer `y` or `yes` to continue, and any other answer cancels that publication.

After the rewritten remote and template setting are verified, an interactive run prints the published commit URL and asks whether to move the mirror to Trash. Answer `y` or `yes` to move it, or press Enter to retain it. A non-interactive run retains the mirror because `--yes` authorizes publication but does not request post-publication cleanup.

Every publisher run surfaces retained mirrors before generation. Fresh mode refuses to create another mirror for a repository that already has one, preventing unresolved backups from accumulating unnoticed. Append mode remains available because it does not rewrite history or need another recovery mirror.

### Manage retained mirrors

List every retained template publication mirror:

```bash
npm run template:backups
```

Limit the list to one variant:

```bash
npm run template:backups -- openai
```

After you have inspected a rewritten repository and no longer need its recovery mirrors, ask the manager to show the exact paths and move them to Trash:

```bash
npm run template:backups -- trash openai
```

The explicit `trash` action and required variant are the cleanup approval, so the command does not ask for a second confirmation. If restoration is needed instead, use the retained bare mirror to inspect and deliberately restore the previous refs.

Passing `--history fresh` also replaces history when the generated files are unchanged. This is useful when the only intended change is collapsing the template repository's maintainer history to a new root. An interactive run without `--history` continues to skip unchanged repositories.

## Commit messages

Creating a repository and replacing one with `fresh` both default to the root-commit message `Initial commit`. An append publication has no default that can describe its changes, so the publisher asks for its message after showing the diff when `--message` was not supplied.

Without a variant, one supplied message is used for every changed template selected by the run:

```bash
npm run template:publish -- --history append --message "Refresh generated templates"
```

For append mode, omit `--message` when the templates need different commit messages; the publisher prompts for each changed repository separately. Run the variants separately when they also need different history modes.

## Non-interactive publication

Pass `--yes` to disable interactive prompts and make the command invocation itself the approval to publish after every safety check passes. It supplies consent, not a history choice: an existing repository selected for publication still needs `--history`. `--message` supplies or overrides the commit message, but it is not always required. Creating a repository and replacing one with `fresh` both produce a root commit and therefore default to `Initial commit`; an `append` update has no meaningful default, so it requires `--message` under `--yes` or prompts without `--yes`.

The full staged diff is still printed before any commit. `--yes` does not bypass factory checks, generated-tree guards, remote leases, backup creation, or remote verification. It also does not delete a fresh-mode recovery mirror; cleanup remains a separate human decision after inspecting the rewritten repository.

Use non-interactive mode only when the complete command is the publication approval, such as a controlled release job:

```bash
npm run template:publish -- wrangler --history append --message "Refresh Worker dependencies" --yes
```

An explicit non-interactive fresh replacement uses the root-commit default unless `--message` overrides it:

```bash
npm run template:publish -- all --history fresh --yes
```

## Pre-publish checklist

- [ ] Shared core changes are complete and committed on `main`
- [ ] The Wrangler tree has been verified under its own toolchain with typecheck, migration application, and a `wrangler dev` smoke test
- [ ] The OpenAI Sites artifact has been confirmed with `npm run test:build` or through the Sites save-version workflow
- [ ] `dist/openai/.openai/hosting.json` has no `project_id`, allowing Sites to provision a new project from the reusable template
- [ ] Each generated tree contains the MIT license and matching package metadata
- [ ] The generated Wrangler tree contains no OpenAI, ChatGPT, Next.js, React, or Vinext residue

The publisher enforces the clean factory state, factory tooling tests, generation gates, emitted manifest project-linkage guard, residue rules, generated tests, explicit changed-path staging, fresh-mode mirror backup, unresolved-mirror accumulation guard, lease-protected history replacement, and remote verification. The runtime-specific smoke checks remain manual because they require provisioned Cloudflare or Sites environments.
