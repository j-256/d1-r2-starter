import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
    availableBackupPath,
    listRetainedMirrorBackups,
    moveMirrorBackupsToTrash,
    TEMPLATE_BACKUP_COMMANDS,
    templateBackupRoot,
} from "./template-backups-lib.mjs";
import { TEMPLATE_VARIANTS } from "./template-variants.mjs";

export { TEMPLATE_VARIANTS };

const DEFAULT_BRANCH = "main";
const FACTORY_REMOTE = "origin";
const ALL_VARIANTS = "all";
const AFFIRMATIVE_RESPONSES = new Set(["y", "yes"]);
const BOTH_VARIANTS_ALIAS = "both";
const HISTORY_MODES = Object.freeze({
    append: "append",
    fresh: "fresh",
});
const INITIAL_COMMIT_MESSAGE = "Initial commit";
const NOT_FOUND_STATUS = 404;
const PUBLISH_TEMP_PREFIX = "d1-r2-template-publish-";
const PUBLICATION_ACTIONS = Object.freeze({
    create: "create",
    replace: "replace",
    update: "update",
});
const PUBLICATION_STATUSES = Object.freeze({
    cancelled: "cancelled",
    created: "created",
    replaced: "replaced",
    unchanged: "unchanged",
    updated: "updated",
});
const TEMPLATE_REMOTE = "origin";
const PUBLISHED_STATUSES = new Set([
    PUBLICATION_STATUSES.created,
    PUBLICATION_STATUSES.replaced,
    PUBLICATION_STATUSES.updated,
]);

export function isAffirmativeResponse(response) {
    return AFFIRMATIVE_RESPONSES.has(response.trim().toLowerCase());
}

export function publicationConfirmationQuestion({
    action,
    history,
    repository,
}) {
    if (history === HISTORY_MODES.fresh) {
        return `Replace main in ${repository} with a fresh root commit and force-push? [y/N] `;
    }
    if (action === PUBLICATION_ACTIONS.create) {
        return `Create and publish ${repository}? [y/N] `;
    }
    return `Append and publish a commit to ${repository}? [y/N] `;
}

function commandFailure(command, args, result) {
    const details = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
    const suffix = details ? `\n${details}` : "";
    return new Error(
        `Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}${suffix}`
    );
}

function runCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw commandFailure(command, args, result);
    }
    return result;
}

function captured(command, args, options = {}) {
    const result = runCommand(command, args, options);
    return result.stdout ?? "";
}

function inherited(command, args, cwd) {
    runCommand(command, args, { cwd, inherit: true });
}

function repositoryUrl(repository) {
    return `https://github.com/${repository}.git`;
}

export function parseHttpStatus(output) {
    const headerMatch = output.match(/^HTTP\/\S+\s+(\d{3})\b/m);
    if (headerMatch?.[1]) return Number.parseInt(headerMatch[1], 10);

    const errorMatch = output.match(/\(HTTP (\d{3})\)/);
    return errorMatch?.[1] ? Number.parseInt(errorMatch[1], 10) : null;
}

export function parsePublishArguments(args) {
    let help = false;
    let history;
    let message;
    let variant;
    let yes = false;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument === "--yes") {
            yes = true;
            continue;
        }
        if (argument === "--history") {
            const candidate = args[index + 1];
            if (!candidate || candidate.startsWith("-")) {
                throw new Error("--history requires append or fresh.");
            }
            history = candidate;
            index += 1;
            continue;
        }
        if (argument?.startsWith("--history=")) {
            history = argument.slice("--history=".length);
            continue;
        }
        if (argument === "--message") {
            const candidate = args[index + 1];
            if (!candidate || candidate.startsWith("-")) {
                throw new Error("--message requires a value.");
            }
            message = candidate;
            index += 1;
            continue;
        }
        if (argument?.startsWith("--message=")) {
            message = argument.slice("--message=".length);
            continue;
        }
        if (argument?.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}`);
        }
        if (variant) throw new Error(`Unexpected argument: ${argument}`);
        variant = argument;
    }

    if (help) return { help: true, yes };
    if (variant === BOTH_VARIANTS_ALIAS) variant = ALL_VARIANTS;
    if (
        variant !== undefined
        && variant !== ALL_VARIANTS
        && !(variant in TEMPLATE_VARIANTS)
    ) {
        throw new Error(
            `Unknown template variant: ${variant}. Choose all, openai, or wrangler.`
        );
    }
    if (history !== undefined && !Object.hasOwn(HISTORY_MODES, history)) {
        throw new Error(
            `Unknown history mode: ${history || "empty"}. Choose append or fresh.`
        );
    }
    if (message !== undefined && !message.trim()) {
        throw new Error("--message cannot be empty.");
    }

    return {
        help: false,
        history,
        message: message?.trim(),
        variant,
        yes,
    };
}

export function publishUsage() {
    return [
        "Usage:",
        "  npm run template:publish -- [all|openai|wrangler] [--history append|fresh] [--message <message>] [--yes]",
        "",
        "Options:",
        "  all                  Process both templates explicitly; both is an alias",
        "  openai|wrangler      Limit publication to one template",
        "  --history <mode>     Append a commit or replace main with a fresh root",
        "  --message <message>  Override the commit message; root commits default to Initial commit",
        "  --yes                Authorize publication without prompts; existing repos require history",
        "  --help               Show this help",
        "",
        "Environment:",
        "  TEMPLATE_PUBLISH_BACKUP_DIR  Override the persistent fresh-mode mirror directory",
    ].join("\n");
}

export function resolveCommitMessage({
    history,
    repositoryExists,
    requestedMessage,
}) {
    if (requestedMessage) return requestedMessage;
    if (!repositoryExists || history === HISTORY_MODES.fresh) {
        return INITIAL_COMMIT_MESSAGE;
    }
    throw new Error(
        "--message is required when updating an existing template repository."
    );
}

export function syncGeneratedTree(sourceRoot, targetRoot) {
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        throw new Error(`Generated template directory is missing: ${sourceRoot}`);
    }
    if (!existsSync(join(targetRoot, ".git"))) {
        throw new Error(`Temporary checkout has no .git directory: ${targetRoot}`);
    }
    if (existsSync(join(sourceRoot, ".git"))) {
        throw new Error(`Generated template must not contain .git: ${sourceRoot}`);
    }

    for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        rmSync(join(targetRoot, entry.name), { force: true, recursive: true });
    }

    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
        cpSync(join(sourceRoot, entry.name), join(targetRoot, entry.name), {
            force: true,
            preserveTimestamps: true,
            recursive: true,
        });
    }
}

function nullSeparatedPaths(output) {
    return output.split("\0").filter(Boolean);
}

export function mergeChangedPaths(trackedOutput, untrackedOutput) {
    return [...new Set([
        ...nullSeparatedPaths(trackedOutput),
        ...nullSeparatedPaths(untrackedOutput),
    ])].sort();
}

function selectedVariants(variant) {
    return !variant || variant === ALL_VARIANTS
        ? Object.keys(TEMPLATE_VARIANTS)
        : [variant];
}

function logPhase(dependencies, title, leadingBlank = true) {
    if (leadingBlank) dependencies.log("");
    dependencies.log(`== ${title} ==`);
}

async function logRetainedBackups(dependencies) {
    const records = [];
    for (const [variant, config] of Object.entries(TEMPLATE_VARIANTS)) {
        const paths = await dependencies.listRetainedBackups(
            config.repository
        );
        records.push(...paths.map((path) => ({ path, variant })));
    }
    if (records.length === 0) return records;

    logPhase(dependencies, "Retained recovery mirrors", false);
    for (const record of records) {
        dependencies.log(`  ${record.variant}: ${record.path}`);
    }
    dependencies.log("");
    dependencies.log(
        `Review or clean them with ${TEMPLATE_BACKUP_COMMANDS.list}.`
    );
    return records;
}

function assertExplicitFreshBackupsAvailable(
    options,
    variants,
    retainedBackups
) {
    if (options.history !== HISTORY_MODES.fresh) return;
    const selected = new Set(variants);
    const conflicts = retainedBackups.filter(({ variant }) =>
        selected.has(variant)
    );
    if (conflicts.length === 0) return;

    throw new Error([
        "Fresh publication cannot start while selected templates have retained recovery mirrors:",
        ...conflicts.map(({ path, variant }) => `  ${variant}: ${path}`),
        `Review them with ${TEMPLATE_BACKUP_COMMANDS.list}. Fresh publication stopped to avoid accumulating unresolved mirrors.`,
    ].join("\n"));
}

function logSummary(dependencies, results) {
    logPhase(dependencies, "Summary");
    const labelWidth = Math.max(
        ...results.map(({ variant }) => variant.length)
    ) + 2;
    for (const result of results) {
        const backup = result.backup
            ? ` (backup: ${result.backup})`
            : result.backupTrashed
                ? " (backup moved to Trash)"
                : "";
        dependencies.log(
            `${result.variant.padEnd(labelWidth)}${result.status}${backup}`
        );
    }
    if (results.some(({ backup }) => backup)) {
        dependencies.log("");
        dependencies.log(
            `After inspecting the replacement, clean up with ${TEMPLATE_BACKUP_COMMANDS.trash}.`
        );
    }
    dependencies.log("");
    const published = results.some(
        ({ status }) => PUBLISHED_STATUSES.has(status)
    );
    dependencies.log(published ? "Publication complete." : "Nothing published.");
}

async function commitMessageFor(plan, history, options, dependencies) {
    if (
        options.message
        || !plan.exists
        || history === HISTORY_MODES.fresh
    ) {
        return resolveCommitMessage({
            history,
            repositoryExists: plan.exists,
            requestedMessage: options.message,
        });
    }
    if (options.yes) {
        throw new Error(
            `--message is required with --yes when updating ${plan.config.repository}.`
        );
    }
    const message = await dependencies.requestCommitMessage({
        repository: plan.config.repository,
    });
    if (!message.trim()) throw new Error("Commit message cannot be empty.");
    return message.trim();
}

async function historyModeFor(plan, options, dependencies) {
    if (!plan.exists) return undefined;
    if (options.history) return options.history;
    if (options.yes) {
        throw new Error(
            `--history is required with --yes when publishing ${plan.config.repository}.`
        );
    }
    const history = await dependencies.requestHistoryMode({
        repository: plan.config.repository,
    });
    if (!Object.hasOwn(HISTORY_MODES, history)) {
        throw new Error(
            `Invalid history mode for ${plan.config.repository}: ${history}`
        );
    }
    return history;
}

async function assertFreshBackupAvailable(plan, history, dependencies) {
    if (history !== HISTORY_MODES.fresh) return;
    const retained = await dependencies.listRetainedBackups(
        plan.config.repository
    );
    if (retained.length === 0) return;

    throw new Error([
        `${plan.config.repository} already has a retained recovery mirror:`,
        ...retained.map((path) => `  ${path}`),
        `Review it with ${TEMPLATE_BACKUP_COMMANDS.list}. Fresh publication stopped to avoid accumulating unresolved mirrors.`,
    ].join("\n"));
}

function publicationAction(plan, history) {
    if (!plan.exists) return PUBLICATION_ACTIONS.create;
    return history === HISTORY_MODES.fresh
        ? PUBLICATION_ACTIONS.replace
        : PUBLICATION_ACTIONS.update;
}

function publicationStatus(plan, history) {
    if (!plan.exists) return PUBLICATION_STATUSES.created;
    return history === HISTORY_MODES.fresh
        ? PUBLICATION_STATUSES.replaced
        : PUBLICATION_STATUSES.updated;
}

export async function publishTemplates(options, dependencies) {
    const variants = selectedVariants(options.variant);
    const workspaces = [];

    const retainedBackups = await logRetainedBackups(dependencies);
    assertExplicitFreshBackupsAvailable(
        options,
        variants,
        retainedBackups
    );
    logPhase(dependencies, "Verify factory", retainedBackups.length > 0);
    await dependencies.assertFactoryReady();
    dependencies.log("Factory main matches origin/main.");

    logPhase(dependencies, "Test and generate");
    await dependencies.generate();
    dependencies.log("Factory checks and template generation passed.");

    logPhase(dependencies, "Compare templates");
    const plans = [];
    try {
        for (const variant of variants) {
            const config = TEMPLATE_VARIANTS[variant];
            const exists = await dependencies.repositoryExists(
                config.repository
            );
            const workspace = await dependencies.prepareCheckout({
                config,
                exists,
            });
            if (exists && !workspace.remoteCommit) {
                throw new Error(
                    `${config.repository}: temporary checkout did not capture remote main.`
                );
            }
            workspaces.push(workspace);
            await dependencies.syncGeneratedTree(
                config.outputDirectory,
                workspace.checkout
            );
            const changedPaths = await dependencies.collectChangedPaths(
                workspace.checkout
            );
            if (changedPaths.length === 0 && !exists) {
                throw new Error(
                    `${config.repository}: generated template contains no publishable files.`
                );
            }

            const explicitFresh = exists
                && options.history === HISTORY_MODES.fresh;
            const requiresPublication = changedPaths.length > 0
                || explicitFresh;
            const plan = {
                changedPaths,
                config,
                exists,
                requiresPublication,
                variant,
                workspace,
            };
            plans.push(plan);
            if (!requiresPublication) {
                dependencies.log(`${variant}: unchanged`);
            } else if (changedPaths.length === 0) {
                dependencies.log(`${variant}: fresh history ready`);
            } else if (exists) {
                dependencies.log(`${variant}: existing repository changed`);
            } else {
                dependencies.log(`${variant}: create ready`);
            }
        }

        const results = plans
            .filter(({ requiresPublication }) => !requiresPublication)
            .map(({ config, variant }) => ({
                action: PUBLICATION_ACTIONS.update,
                repository: config.repository,
                status: PUBLICATION_STATUSES.unchanged,
                variant,
            }));
        const publishPlans = plans.filter(
            ({ requiresPublication }) => requiresPublication
        );

        if (publishPlans.length > 0) {
            logPhase(dependencies, "Publish templates");
        }
        for (const plan of publishPlans) {
            dependencies.log("");
            dependencies.log(
                `${plan.variant}: publish ${plan.config.repository}`
            );
            if (plan.changedPaths.length > 0) {
                await dependencies.stagePaths(
                    plan.workspace.checkout,
                    plan.changedPaths
                );
            }
            await dependencies.showStagedDiff(plan.workspace.checkout);
            if (plan.changedPaths.length === 0) {
                dependencies.log(
                    "Generated files are unchanged; fresh mode will replace history with the same tree."
                );
            }
            const history = await historyModeFor(
                plan,
                options,
                dependencies
            );
            const action = publicationAction(plan, history);
            if (history) dependencies.log(`History mode: ${history}`);
            await assertFreshBackupAvailable(plan, history, dependencies);
            const commitMessage = await commitMessageFor(
                plan,
                history,
                options,
                dependencies
            );
            const confirmed = options.yes || await dependencies.confirm({
                action,
                history,
                repository: plan.config.repository,
            });
            if (!confirmed) {
                dependencies.log(`${plan.variant}: cancelled`);
                results.push({
                    action,
                    repository: plan.config.repository,
                    status: PUBLICATION_STATUSES.cancelled,
                    variant: plan.variant,
                });
                continue;
            }

            let backup;
            if (history === HISTORY_MODES.fresh) {
                backup = await dependencies.createMirrorBackup({
                    expectedCommit: plan.workspace.remoteCommit,
                    repository: plan.config.repository,
                });
                dependencies.log(`Mirror backup created at ${backup}`);
            }
            const commit = await dependencies.createCommit({
                changedPaths: plan.changedPaths,
                checkout: plan.workspace.checkout,
                expectedCommit: plan.workspace.remoteCommit,
                history,
                message: commitMessage,
            });
            if (plan.exists) {
                if (history === HISTORY_MODES.fresh) {
                    await dependencies.pushFresh({
                        checkout: plan.workspace.checkout,
                        commit,
                        expectedCommit: plan.workspace.remoteCommit,
                    });
                } else {
                    await dependencies.pushUpdate(plan.workspace.checkout);
                }
            } else {
                await dependencies.createRepository(
                    plan.workspace.checkout,
                    plan.config.repository
                );
            }
            await dependencies.ensureTemplate(plan.config.repository);
            await dependencies.verifyPublished({
                commit,
                repository: plan.config.repository,
            });

            const status = publicationStatus(plan, history);
            dependencies.log(`${plan.variant}: ${status} ${commit}`);
            let backupTrashed = false;
            if (backup && !options.yes) {
                dependencies.log(
                    `Verified replacement: https://github.com/${plan.config.repository}/commit/${commit}`
                );
                const cleanupRequested =
                    await dependencies.confirmBackupCleanup({
                        repository: plan.config.repository,
                    });
                if (cleanupRequested) {
                    try {
                        await dependencies.moveBackupsToTrash([backup]);
                        dependencies.log("Mirror backup moved to Trash.");
                        backup = undefined;
                        backupTrashed = true;
                    } catch (error) {
                        const message = error instanceof Error
                            ? error.message
                            : String(error);
                        dependencies.log(
                            `Could not move the mirror to Trash: ${message}`
                        );
                    }
                }
            }
            if (backup) {
                dependencies.log(`Mirror backup retained at ${backup}`);
            }
            results.push({
                action,
                backup,
                backupTrashed,
                commit,
                repository: plan.config.repository,
                status,
                variant: plan.variant,
            });
        }

        results.sort(
            (left, right) =>
                variants.indexOf(left.variant) - variants.indexOf(right.variant)
        );
        logSummary(dependencies, results);
        return results;
    } finally {
        await Promise.all(
            workspaces.map((workspace) => dependencies.cleanup(workspace))
        );
    }
}

export function createSystemDependencies(repoRoot) {
    return {
        async assertFactoryReady() {
            const status = captured(
                "git",
                ["status", "--porcelain=v1", "--untracked-files=all"],
                { cwd: repoRoot }
            );
            if (status) {
                throw new Error(
                    "The factory worktree must be clean before publishing a template."
                );
            }

            const branch = captured(
                "git",
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
                { cwd: repoRoot }
            ).trim();
            if (branch !== DEFAULT_BRANCH) {
                throw new Error(
                    `Publish templates from ${DEFAULT_BRANCH}, not ${branch || "detached HEAD"}.`
                );
            }

            runCommand(
                "git",
                ["fetch", "--quiet", FACTORY_REMOTE, DEFAULT_BRANCH],
                { cwd: repoRoot }
            );
            const head = captured("git", ["rev-parse", "HEAD"], {
                cwd: repoRoot,
            }).trim();
            const upstream = captured(
                "git",
                ["rev-parse", `refs/remotes/${FACTORY_REMOTE}/${DEFAULT_BRANCH}`],
                { cwd: repoRoot }
            ).trim();
            if (head !== upstream) {
                throw new Error(
                    `Factory HEAD must match ${FACTORY_REMOTE}/${DEFAULT_BRANCH}. Push the reviewed factory commit first.`
                );
            }
        },

        async generate() {
            inherited("npm", ["run", "test:generate"], repoRoot);
            inherited("npm", ["run", "generate"], repoRoot);
        },

        async repositoryExists(repository) {
            const result = runCommand(
                "gh",
                ["api", "--include", `repos/${repository}`],
                { allowFailure: true, cwd: repoRoot }
            );
            if (result.status === 0) return true;

            const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
            if (parseHttpStatus(output) === NOT_FOUND_STATUS) return false;
            throw commandFailure(
                "gh",
                ["api", "--include", `repos/${repository}`],
                result
            );
        },

        async prepareCheckout({ config, exists }) {
            const tempRoot = mkdtempSync(join(tmpdir(), PUBLISH_TEMP_PREFIX));
            const checkout = join(tempRoot, "checkout");
            try {
                let remoteCommit;
                if (exists) {
                    runCommand(
                        "git",
                        [
                            "clone",
                            "--quiet",
                            "--branch",
                            DEFAULT_BRANCH,
                            "--single-branch",
                            repositoryUrl(config.repository),
                            checkout,
                        ],
                        { cwd: repoRoot }
                    );
                    remoteCommit = captured(
                        "git",
                        ["-C", checkout, "rev-parse", "HEAD"],
                        { cwd: repoRoot }
                    ).trim();
                } else {
                    mkdirSync(checkout);
                    runCommand(
                        "git",
                        ["init", "--quiet", "-b", DEFAULT_BRANCH, checkout],
                        { cwd: repoRoot }
                    );
                }
                return { checkout, remoteCommit, tempRoot };
            } catch (error) {
                rmSync(tempRoot, { force: true, recursive: true });
                throw error;
            }
        },

        async syncGeneratedTree(outputDirectory, checkout) {
            syncGeneratedTree(join(repoRoot, outputDirectory), checkout);
        },

        async collectChangedPaths(checkout) {
            const tracked = captured(
                "git",
                ["-C", checkout, "diff", "--name-only", "-z", "--"],
                { cwd: repoRoot }
            );
            const untracked = captured(
                "git",
                [
                    "-C",
                    checkout,
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
                { cwd: repoRoot }
            );
            return mergeChangedPaths(tracked, untracked);
        },

        async stagePaths(checkout, changedPaths) {
            runCommand(
                "git",
                ["-C", checkout, "add", "--", ...changedPaths],
                { cwd: repoRoot }
            );
        },

        async showStagedDiff(checkout) {
            inherited(
                "git",
                ["-C", checkout, "diff", "--cached", "--check", "--"],
                repoRoot
            );
            inherited(
                "git",
                ["-C", checkout, "status", "--short"],
                repoRoot
            );
            inherited(
                "git",
                ["-C", checkout, "--no-pager", "diff", "--cached", "--binary", "--"],
                repoRoot
            );
        },

        async confirm({ action, history, repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    "Interactive confirmation requires a terminal. Pass --yes for an intentional non-interactive publication."
                );
            }

            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                const answer = await readline.question(
                    publicationConfirmationQuestion({
                        action,
                        history,
                        repository,
                    })
                );
                return isAffirmativeResponse(answer);
            } finally {
                readline.close();
            }
        },

        async requestHistoryMode({ repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `Choosing history for ${repository} requires a terminal. Pass --history for a non-interactive publication.`
                );
            }

            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                console.log(`History mode for ${repository}:`);
                console.log("  1. append (recommended): add a normal commit");
                console.log("  2. fresh: replace main with one new root commit");
                while (true) {
                    const answer = (await readline.question(
                        "Choose 1 or 2: "
                    )).trim().toLowerCase();
                    if (answer === "1" || answer === HISTORY_MODES.append) {
                        return HISTORY_MODES.append;
                    }
                    if (answer === "2" || answer === HISTORY_MODES.fresh) {
                        return HISTORY_MODES.fresh;
                    }
                    console.log("Choose 1 for append or 2 for fresh.");
                }
            } finally {
                readline.close();
            }
        },

        async requestCommitMessage({ repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `A commit message for ${repository} requires a terminal. Pass --message for a non-interactive publication.`
                );
            }

            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                return await readline.question(
                    `Commit message for ${repository}: `
                );
            } finally {
                readline.close();
            }
        },

        async confirmBackupCleanup({ repository }) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `Choosing recovery-mirror cleanup for ${repository} requires a terminal.`
                );
            }
            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                const answer = await readline.question(
                    `Move the recovery mirror for ${repository} to Trash? [y/N] `
                );
                return isAffirmativeResponse(answer);
            } finally {
                readline.close();
            }
        },

        async listRetainedBackups(repository) {
            return listRetainedMirrorBackups({ repository });
        },

        async moveBackupsToTrash(paths) {
            moveMirrorBackupsToTrash(paths, { cwd: repoRoot });
        },

        async createMirrorBackup({
            backupRoot = templateBackupRoot(),
            expectedCommit,
            repository,
            url = repositoryUrl(repository),
        }) {
            if (!expectedCommit) {
                throw new Error(
                    `Cannot back up ${repository} without the observed remote commit.`
                );
            }
            const retained = listRetainedMirrorBackups({
                backupRoot,
                repository,
            });
            if (retained.length > 0) {
                throw new Error(
                    `${repository} already has a retained recovery mirror. Fresh publication stopped before creating another one.`
                );
            }
            const backup = availableBackupPath(backupRoot, repository);
            try {
                runCommand(
                    "git",
                    ["clone", "--mirror", "--quiet", url, backup],
                    { cwd: repoRoot }
                );
            } catch (error) {
                rmSync(backup, { force: true, recursive: true });
                throw error;
            }
            const backedUpCommit = captured(
                "git",
                ["-C", backup, "rev-parse", `refs/heads/${DEFAULT_BRANCH}`],
                { cwd: repoRoot }
            ).trim();
            if (backedUpCommit !== expectedCommit) {
                throw new Error(
                    `${repository} moved after comparison. Nothing was rewritten. The newer mirror is retained at ${backup}.`
                );
            }
            return backup;
        },

        async createCommit({
            changedPaths,
            checkout,
            expectedCommit,
            history,
            message,
        }) {
            let commit;
            if (history === HISTORY_MODES.fresh) {
                const currentCommit = captured(
                    "git",
                    ["-C", checkout, "rev-parse", "HEAD"],
                    { cwd: repoRoot }
                ).trim();
                if (!expectedCommit || currentCommit !== expectedCommit) {
                    throw new Error(
                        "The temporary template checkout moved before the fresh commit. Nothing was pushed."
                    );
                }
                const tree = captured(
                    "git",
                    ["-C", checkout, "write-tree"],
                    { cwd: repoRoot }
                ).trim();
                commit = captured(
                    "git",
                    ["-C", checkout, "commit-tree", tree, "-m", message],
                    { cwd: repoRoot }
                ).trim();
                runCommand(
                    "git",
                    [
                        "-C",
                        checkout,
                        "update-ref",
                        `refs/heads/${DEFAULT_BRANCH}`,
                        commit,
                        expectedCommit,
                    ],
                    { cwd: repoRoot }
                );
            } else {
                if (changedPaths.length === 0) {
                    throw new Error(
                        "A normal template commit requires changed paths."
                    );
                }
                runCommand(
                    "git",
                    [
                        "-C",
                        checkout,
                        "commit",
                        "--quiet",
                        "-m",
                        message,
                        "--",
                        ...changedPaths,
                    ],
                    { cwd: repoRoot }
                );
                commit = captured(
                    "git",
                    ["-C", checkout, "rev-parse", "HEAD"],
                    { cwd: repoRoot }
                ).trim();
            }
            const status = captured(
                "git",
                ["-C", checkout, "status", "--porcelain=v1"],
                { cwd: repoRoot }
            );
            if (status) {
                throw new Error(
                    "The temporary template checkout changed during commit. Nothing was pushed."
                );
            }
            return commit;
        },

        async pushUpdate(checkout) {
            runCommand(
                "git",
                [
                    "-C",
                    checkout,
                    "push",
                    "--quiet",
                    TEMPLATE_REMOTE,
                    DEFAULT_BRANCH,
                ],
                { cwd: repoRoot }
            );
        },

        async pushFresh({ checkout, commit, expectedCommit }) {
            runCommand(
                "git",
                [
                    "-C",
                    checkout,
                    "push",
                    "--quiet",
                    `--force-with-lease=refs/heads/${DEFAULT_BRANCH}:${expectedCommit}`,
                    TEMPLATE_REMOTE,
                    `${commit}:refs/heads/${DEFAULT_BRANCH}`,
                ],
                { cwd: repoRoot }
            );
        },

        async createRepository(checkout, repository) {
            runCommand(
                "gh",
                [
                    "repo",
                    "create",
                    repository,
                    "--public",
                    "--source",
                    checkout,
                    "--remote",
                    TEMPLATE_REMOTE,
                    "--push",
                ],
                { cwd: repoRoot }
            );
        },

        async ensureTemplate(repository) {
            const template = captured(
                "gh",
                ["repo", "view", repository, "--json", "isTemplate", "--jq", ".isTemplate"],
                { cwd: repoRoot }
            ).trim();
            if (template !== "true") {
                runCommand(
                    "gh",
                    ["repo", "edit", repository, "--template"],
                    { cwd: repoRoot }
                );
            }
        },

        async verifyPublished({ commit, repository }) {
            const remote = captured(
                "git",
                ["ls-remote", repositoryUrl(repository), `refs/heads/${DEFAULT_BRANCH}`],
                { cwd: repoRoot }
            ).trim();
            const remoteCommit = remote.split(/\s+/)[0];
            if (remoteCommit !== commit) {
                throw new Error(
                    `Remote ${DEFAULT_BRANCH} does not match the published commit.`
                );
            }

            const template = captured(
                "gh",
                ["repo", "view", repository, "--json", "isTemplate", "--jq", ".isTemplate"],
                { cwd: repoRoot }
            ).trim();
            if (template !== "true") {
                throw new Error(`${repository} is not marked as a template repository.`);
            }
        },

        async cleanup(workspace) {
            rmSync(workspace.tempRoot, { force: true, recursive: true });
        },

        log(message) {
            console.log(message);
        },
    };
}
