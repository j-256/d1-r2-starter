# Publishing the template repositories

This repository is the source factory for two GitHub templates: `d1-r2-starter-openai` and `d1-r2-starter-wrangler`. Make changes in the factory, regenerate the templates, and publish the generated outputs. Do not edit the template repositories directly because the next publication replaces their working trees from the factory output.

## How publication works

From a clean `main` branch, choose the publication target explicitly. Use `all` to process both templates:

```bash
npm run template:publish -- all
```

Omitting the target is an error rather than an implicit request to publish both repositories. `both` is accepted as an explicit compatibility alias for `all`:

```bash
npm run template:publish -- both
```

Pass `openai` or `wrangler` when you want to limit the run to one template:

```bash
npm run template:publish -- openai
```

The publisher performs the following work in clearly labeled phases:

1. Surfaces any retained recovery mirrors from earlier fresh publications
2. Confirms that the factory worktree is clean and that `HEAD` matches `origin/main`
3. In clobber mode, moves selected retained recovery mirrors to Trash
4. Runs the factory tooling tests and generates both templates once, even when both repositories are selected
5. Compares every selected generated tree with its GitHub template repository in a disposable checkout
6. Shows the complete staged diff for every planned publication
7. For each changed existing repository, asks whether to append normal history or replace `main` with fresh history when `--history` was not supplied
8. In normal mode, resolves the root-commit default or prompts for a missing append message; in replay mode, prepares the relevant factory checkpoint commits and shows each diff
9. Asks for final yes-or-no publication approval, publishes `main` once, confirms the remote commit, and verifies that GitHub recognizes the repository as a template
10. After an ordinary interactive fresh publication, offers a yes-or-no choice to move the verified recovery mirror to Trash
11. Prints a compact summary showing whether each selected template was unchanged, created, updated, replaced, or cancelled

If a generated tree already matches its existing template repository, the publisher normally does not ask for a message or confirmation and does not create a commit or push. Explicit `--history fresh` is the exception because replacing maintainer history is itself the requested publication.

Explicit fresh mode is preflighted before tests and generation. Without `--clobber`, any selected template with a retained recovery mirror stops the command immediately.

## First publication

When a selected GitHub repository does not exist, the publisher creates it as a public repository, pushes an initial commit, and enables the GitHub template setting. The initial commit message defaults to `Initial commit`, so no message is required for this first publication. Checkpoint replay adds its relevant commits after that baseline root before the repository is pushed.

```bash
npm run template:publish -- openai
```

## Choosing history for an existing template

When a repository already exists and is selected for a changed, replayed, or explicitly fresh publication, the publisher shows the relevant diff and asks how to record the publication:

1. `append` (recommended) adds a normal commit to the template repository's maintainer history. It preserves an audit trail and makes rollback straightforward.
2. `fresh` replaces `main` with history that starts at one new root commit. Normal mode stops at that complete-tree root; checkpoint replay adds its relevant commits afterward. Fresh mode force-pushes with a lease and rewrites the template repository's maintainer history.

The publisher does not auto-squash commits. An append publication remains a normal child commit in the template repository. GitHub's separate template-generation behavior still gives a new downstream repository created with "Use this template" a single initial commit, regardless of how many maintainer commits the template repository has. See [Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

### Replay curated factory checkpoints

Use checkpoint replay when the template repository's maintainer history should teach the architecture in the same deliberate steps as the factory. Supply the factory revision whose generated tree is the baseline; the publisher replays every first-parent commit after that revision through `HEAD`:

```bash
npm run template:publish -- all --history append --replay-from <baseline-revision>
```

Append replay first proves that each downstream repository exactly matches the generated baseline. If it does not, publication stops before creating or pushing anything and asks for the correct baseline or fresh history. This prevents an unrelated downstream state from being folded into the first replayed checkpoint.

Fresh replay creates a parentless `Initial commit` from the generated baseline, then adds the relevant factory checkpoints. Combine it with clobber when old history and retained mirrors should both be replaced and cleaned through the verified backup lifecycle:

```bash
npm run template:publish -- all --clobber --replay-from <baseline-revision> --yes
```

The publisher generates the baseline and every selected factory checkpoint in isolated snapshots. It preserves each checkpoint's subject and optional body, skips a checkpoint when it does not change that edition, shows the exact diff for every local commit, and verifies that the resulting tree matches the generated `HEAD` template. It then asks once per repository and pushes the complete sequence once.

`--message` cannot be combined with `--replay-from` because replayed messages come from the reviewed factory commits. Edit the factory commit message before publication when its downstream explanation needs improvement.

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

Normal fresh mode defaults to `Initial commit`; pass `--message` only when you want a different root-commit message. Replay always uses `Initial commit` for its generated baseline and preserves the factory messages that follow it.

Before changing the remote ref, the publisher creates a bare mirror of the existing repository and verifies that the mirror contains the exact `main` commit observed during comparison. It stores the mirror under `TEMPLATE_PUBLISH_BACKUP_DIR` when that variable is set, otherwise under `${XDG_STATE_HOME:-$HOME/.local/state}/d1-r2-starter/template-publish-backups`. The summary prints the exact retained path.

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

### Clobber selected histories and mirrors

Use clobber mode when the intended result is fresh root history with no retained publication mirrors after successful verification:

```bash
npm run template:publish -- all --clobber --yes
```

`--clobber` implies `--history fresh`, uses the normal `Initial commit` root-message default, and conflicts with `--history append`. After the clean-factory check, it moves pre-existing mirrors for the selected variants to Trash before generation. Each existing repository still gets a verified recovery mirror before its lease-protected force push; that new mirror moves to Trash only after the published commit and template setting are verified.

If publication or verification fails, the new recovery mirror remains available. If post-verification Trash cleanup fails, the command exits with an error that identifies the successfully published repository and retained mirror. Mirrors for unselected variants are never moved.

`--yes` authorizes publication without prompts. `--clobber` separately authorizes the fresh-history and mirror-cleanup lifecycle; neither flag silently acquires the other's meaning.

Passing `--history fresh` also replaces history when the generated files are unchanged. This is useful when the only intended change is collapsing the template repository's maintainer history to a new root. An interactive run without `--history` continues to skip unchanged repositories.

## Commit messages

Creating a repository and replacing one with `fresh` both default to the root-commit message `Initial commit`. An append publication has no default that can describe its changes, so the publisher asks for its message after showing the diff when `--message` was not supplied.

With `all`, one supplied message is used for every changed template selected by the run:

```bash
npm run template:publish -- all --history append --message "Refresh generated templates"
```

For append mode, omit `--message` when the templates need different commit messages; the publisher prompts for each changed repository separately. Run the variants separately when they also need different history modes.

Checkpoint replay is the exception to the one-message model. It carries each relevant factory subject and body into the template repository and reports how many commits each edition receives.

## Non-interactive publication

Pass `--yes` to disable interactive prompts and make the command invocation itself the approval to publish after every safety check passes. It supplies consent, not a history choice: an existing repository selected for publication still needs `--history` unless `--clobber` supplies fresh history. `--message` supplies or overrides the commit message, but it is not always required. Creating a repository and replacing one with `fresh` both produce a root commit and therefore default to `Initial commit`; an `append` update has no meaningful default, so it requires `--message` under `--yes` or prompts without `--yes`.

The full staged diff is still printed before any commit. `--yes` does not bypass factory checks, generated-tree guards, remote leases, backup creation, or remote verification. By itself, it also does not delete a fresh-mode recovery mirror; `--clobber` is the separate cleanup authorization.

With `--replay-from`, the disposable checkout commits are prepared locally so their exact diffs can be reviewed before approval. `--yes` approves publishing that prepared sequence; the remote still receives only one push after final-tree verification.

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
- [ ] Factory checkpoint subjects and bodies make sense in each downstream template that will receive them
- [ ] The Wrangler tree has been verified under its own toolchain with typecheck, migration application, and a `wrangler dev` smoke test
- [ ] The OpenAI Sites artifact has been confirmed with `npm run test:build` or through the Sites save-version workflow
- [ ] `dist/openai/.openai/hosting.json` has no `project_id`, allowing Sites to provision a new project from the reusable template
- [ ] Each generated tree contains the MIT license and matching package metadata
- [ ] The generated Wrangler tree contains no OpenAI, ChatGPT, Next.js, React, or Vinext residue

The publisher enforces the clean factory state, factory tooling tests, generation gates, emitted manifest project-linkage guard, residue rules, generated tests, explicit changed-path staging, replay baseline matching, replay final-tree equivalence, fresh-mode mirror backup, unresolved-mirror accumulation guard, lease-protected history replacement, and remote verification. The runtime-specific smoke checks remain manual because they require provisioned Cloudflare or Sites environments.
