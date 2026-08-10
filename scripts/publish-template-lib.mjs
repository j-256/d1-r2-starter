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

export const TEMPLATE_VARIANTS = Object.freeze({
    openai: Object.freeze({
        outputDirectory: "dist/openai",
        repository: "j-256/d1-r2-starter-openai",
    }),
    wrangler: Object.freeze({
        outputDirectory: "dist/wrangler",
        repository: "j-256/d1-r2-starter-wrangler",
    }),
});

const DEFAULT_BRANCH = "main";
const FACTORY_REMOTE = "origin";
const INITIAL_COMMIT_MESSAGE = "Initial commit";
const NOT_FOUND_STATUS = 404;
const PUBLISH_TEMP_PREFIX = "d1-r2-template-publish-";
const TEMPLATE_REMOTE = "origin";
const PUBLISHED_STATUSES = new Set(["created", "updated"]);

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
    if (variant !== undefined && !(variant in TEMPLATE_VARIANTS)) {
        throw new Error(
            `Unknown template variant: ${variant}. Choose openai or wrangler.`
        );
    }
    if (message !== undefined && !message.trim()) {
        throw new Error("--message cannot be empty.");
    }

    return {
        help: false,
        message: message?.trim(),
        variant,
        yes,
    };
}

export function publishUsage() {
    return [
        "Usage:",
        "  npm run template:publish -- [openai|wrangler] [--message <message>] [--yes]",
        "",
        "Options:",
        "  openai|wrangler      Limit publication to one template; omit for both",
        "  --message <message>  Use one commit message for every changed template",
        "  --yes                Skip confirmations; updates also require --message",
        "  --help               Show this help",
    ].join("\n");
}

export function resolveCommitMessage(repositoryExists, requestedMessage) {
    if (requestedMessage) return requestedMessage;
    if (!repositoryExists) return INITIAL_COMMIT_MESSAGE;
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
    return variant ? [variant] : Object.keys(TEMPLATE_VARIANTS);
}

function logPhase(dependencies, title, leadingBlank = true) {
    if (leadingBlank) dependencies.log("");
    dependencies.log(`== ${title} ==`);
}

function logSummary(dependencies, results) {
    logPhase(dependencies, "Summary");
    const labelWidth = Math.max(
        ...results.map(({ variant }) => variant.length)
    ) + 2;
    for (const result of results) {
        dependencies.log(`${result.variant.padEnd(labelWidth)}${result.status}`);
    }
    dependencies.log("");
    const published = results.some(
        ({ status }) => PUBLISHED_STATUSES.has(status)
    );
    dependencies.log(published ? "Publication complete." : "Nothing published.");
}

async function commitMessageFor(plan, options, dependencies) {
    if (options.message || !plan.exists) {
        return resolveCommitMessage(plan.exists, options.message);
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

export async function publishTemplates(options, dependencies) {
    const variants = selectedVariants(options.variant);
    const workspaces = [];

    logPhase(dependencies, "Verify factory", false);
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

            const action = exists ? "update" : "create";
            const plan = {
                action,
                changedPaths,
                config,
                exists,
                variant,
                workspace,
            };
            plans.push(plan);
            dependencies.log(
                changedPaths.length === 0
                    ? `${variant}: unchanged`
                    : `${variant}: ${action} ready`
            );
        }

        const results = plans
            .filter(({ changedPaths }) => changedPaths.length === 0)
            .map(({ action, config, variant }) => ({
                action,
                repository: config.repository,
                status: "unchanged",
                variant,
            }));
        const changedPlans = plans.filter(
            ({ changedPaths }) => changedPaths.length > 0
        );

        if (changedPlans.length > 0) {
            logPhase(dependencies, "Publish changed templates");
        }
        for (const plan of changedPlans) {
            dependencies.log("");
            dependencies.log(
                `${plan.variant}: ${plan.action} ${plan.config.repository}`
            );
            await dependencies.stagePaths(
                plan.workspace.checkout,
                plan.changedPaths
            );
            await dependencies.showStagedDiff(plan.workspace.checkout);
            const commitMessage = await commitMessageFor(
                plan,
                options,
                dependencies
            );
            const confirmed = options.yes || await dependencies.confirm({
                action: plan.action,
                repository: plan.config.repository,
            });
            if (!confirmed) {
                dependencies.log(`${plan.variant}: cancelled`);
                results.push({
                    action: plan.action,
                    repository: plan.config.repository,
                    status: "cancelled",
                    variant: plan.variant,
                });
                continue;
            }

            const commit = await dependencies.commitPaths(
                plan.workspace.checkout,
                plan.changedPaths,
                commitMessage
            );
            if (plan.exists) {
                await dependencies.pushUpdate(plan.workspace.checkout);
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

            const status = plan.exists ? "updated" : "created";
            dependencies.log(`${plan.variant}: ${status} ${commit}`);
            results.push({
                action: plan.action,
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
                } else {
                    mkdirSync(checkout);
                    runCommand(
                        "git",
                        ["init", "--quiet", "-b", DEFAULT_BRANCH, checkout],
                        { cwd: repoRoot }
                    );
                }
                return { checkout, tempRoot };
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

        async confirm({ action, repository }) {
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
                    `Type ${repository} to ${action} and publish this template: `
                );
                return answer.trim() === repository;
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

        async commitPaths(checkout, changedPaths, message) {
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
            return captured("git", ["-C", checkout, "rev-parse", "HEAD"], {
                cwd: repoRoot,
            }).trim();
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
