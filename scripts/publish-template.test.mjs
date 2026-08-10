import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createSystemDependencies,
    isAffirmativeResponse,
    mergeChangedPaths,
    parseHttpStatus,
    parsePublishArguments,
    publishTemplates,
    publicationConfirmationQuestion,
    publishUsage,
    resolveCommitMessage,
    syncGeneratedTree,
} from "./publish-template-lib.mjs";

const UPDATE_MESSAGE = "Refresh generated template";
const HTTP_NOT_FOUND = 404;
const OPENAI_REPOSITORY = "j-256/d1-r2-starter-openai";
const WRANGLER_REPOSITORY = "j-256/d1-r2-starter-wrangler";

function tempTree() {
    return mkdtempSync(join(tmpdir(), "publish-template-test-"));
}

function runGit(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function configureTestGit(cwd) {
    runGit(cwd, ["config", "user.name", "Template Test"]);
    runGit(cwd, ["config", "user.email", "template@example.test"]);
}

function createTemplateRemote(root) {
    const remote = join(root, "template.git");
    const seed = join(root, "seed");
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main", seed]);
    configureTestGit(seed);
    writeFileSync(join(seed, "README.md"), "# Initial\n");
    writeFileSync(join(seed, "stale.txt"), "remove\n");
    runGit(seed, ["add", "--", "README.md", "stale.txt"]);
    runGit(seed, ["commit", "-m", "Initial commit", "--", "README.md", "stale.txt"]);
    runGit(seed, ["remote", "add", "origin", remote]);
    runGit(seed, ["push", "--quiet", "origin", "main"]);
    return {
        initialCommit: runGit(seed, ["rev-parse", "HEAD"]).trim(),
        remote,
    };
}

function fakeDependencies(options = {}) {
    const operations = [];
    const defaultChangedPaths = options.changedPaths ?? ["README.md"];
    const defaultExists = options.exists ?? true;
    const trashedBackups = new Set();

    return {
        dependencies: {
            async assertFactoryReady() {
                operations.push("assertFactoryReady");
            },
            async generate() {
                operations.push("generate");
            },
            async repositoryExists(repository) {
                operations.push(`repositoryExists:${repository}`);
                return options.existsByRepository?.[repository] ?? defaultExists;
            },
            async prepareCheckout({ config }) {
                operations.push(`prepareCheckout:${config.repository}`);
                return {
                    checkout: config.repository,
                    remoteCommit: options.remoteCommitByRepository?.[
                        config.repository
                    ] ?? `remote-${config.repository}`,
                    tempRoot: `temp:${config.repository}`,
                };
            },
            async syncGeneratedTree(outputDirectory, checkout) {
                operations.push(`sync:${outputDirectory}:${checkout}`);
            },
            async collectChangedPaths(checkout) {
                operations.push(`collectChangedPaths:${checkout}`);
                return options.changedPathsByRepository?.[checkout]
                    ?? defaultChangedPaths;
            },
            async stagePaths(checkout, paths) {
                operations.push(`stage:${checkout}:${paths.join(",")}`);
            },
            async showStagedDiff(checkout) {
                operations.push(`showStagedDiff:${checkout}`);
            },
            async confirm({ history, repository }) {
                operations.push(`confirm:${repository}:${history ?? "create"}`);
                return options.confirmedByRepository?.[repository]
                    ?? options.confirmed
                    ?? true;
            },
            async requestHistoryMode({ repository }) {
                operations.push(`requestHistoryMode:${repository}`);
                return options.historyByRepository?.[repository]
                    ?? options.requestedHistory
                    ?? "append";
            },
            async requestCommitMessage({ repository }) {
                operations.push(`requestCommitMessage:${repository}`);
                return options.messagesByRepository?.[repository]
                    ?? options.requestedMessage
                    ?? UPDATE_MESSAGE;
            },
            async confirmBackupCleanup({ repository }) {
                operations.push(`confirmBackupCleanup:${repository}`);
                return options.cleanupBackupByRepository?.[repository]
                    ?? options.cleanupBackup
                    ?? false;
            },
            async listRetainedBackups(repository) {
                operations.push(`listRetainedBackups:${repository}`);
                return (
                    options.retainedBackupsByRepository?.[repository] ?? []
                ).filter((path) => !trashedBackups.has(path));
            },
            async moveBackupsToTrash(paths) {
                operations.push(`moveBackupsToTrash:${paths.join(",")}`);
                if (options.trashError) throw options.trashError;
                for (const path of paths) trashedBackups.add(path);
            },
            async createMirrorBackup({ repository }) {
                operations.push(`createMirrorBackup:${repository}`);
                return `backup:${repository}`;
            },
            async createCommit({
                changedPaths,
                checkout,
                history,
                message,
            }) {
                operations.push(
                    `commit:${checkout}:${history ?? "create"}:${message}:${changedPaths.join(",")}`
                );
                return `published-${checkout}`;
            },
            async pushUpdate(checkout) {
                operations.push(`pushUpdate:${checkout}`);
            },
            async pushFresh({ checkout }) {
                operations.push(`pushFresh:${checkout}`);
            },
            async createRepository(_checkout, repository) {
                operations.push(`createRepository:${repository}`);
            },
            async ensureTemplate(repository) {
                operations.push(`ensureTemplate:${repository}`);
            },
            async verifyPublished({ repository }) {
                operations.push(`verifyPublished:${repository}`);
                const error = options.verifyErrorByRepository?.[repository]
                    ?? options.verifyError;
                if (error) throw error;
            },
            async cleanup(workspace) {
                operations.push(`cleanup:${workspace.checkout}`);
            },
            log(message) {
                operations.push(`log:${message}`);
            },
        },
        operations,
    };
}

test("parsePublishArguments requires an explicit template target", () => {
    assert.throws(
        () => parsePublishArguments([]),
        /Pass all for both templates/
    );
    assert.deepEqual(parsePublishArguments(["all"]), {
        clobber: false,
        help: false,
        history: undefined,
        message: undefined,
        variant: "all",
        yes: false,
    });
    assert.deepEqual(parsePublishArguments(["--help"]), {
        help: true,
        yes: false,
    });
});

test("parsePublishArguments accepts a variant, history, message, and confirmation flag", () => {
    assert.deepEqual(
        parsePublishArguments([
            "openai",
            "--history=fresh",
            "--message",
            UPDATE_MESSAGE,
            "--yes",
        ]),
        {
            clobber: false,
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: true,
        }
    );
});

test("parsePublishArguments expands clobber to fresh history", () => {
    assert.deepEqual(
        parsePublishArguments(["all", "--clobber", "--yes"]),
        {
            clobber: true,
            help: false,
            history: "fresh",
            message: undefined,
            variant: "all",
            yes: true,
        }
    );
    assert.throws(
        () => parsePublishArguments([
            "openai",
            "--clobber",
            "--history",
            "append",
        ]),
        /cannot be combined with --history append/
    );
});

test("parsePublishArguments accepts explicit all and both selections", () => {
    assert.equal(parsePublishArguments(["all"]).variant, "all");
    assert.equal(parsePublishArguments(["both"]).variant, "all");
});

test("parsePublishArguments rejects unknown variants and malformed options", () => {
    assert.throws(
        () => parsePublishArguments(["other"]),
        /Unknown template variant/
    );
    assert.throws(
        () => parsePublishArguments(["openai", "--message", "--yes"]),
        /--message requires a value/
    );
    assert.throws(
        () => parsePublishArguments(["--history", "rewrite"]),
        /Unknown history mode/
    );
});

test("publishUsage documents history modes and persistent backups", () => {
    const usage = publishUsage();
    assert.match(usage, /all\|openai\|wrangler/);
    assert.match(usage, /both is an alias/);
    assert.match(usage, /--history append\|fresh/);
    assert.match(usage, /--clobber/);
    assert.match(usage, /root commits default to Initial commit/);
    assert.match(usage, /existing repos need history or clobber/);
    assert.match(usage, /TEMPLATE_PUBLISH_BACKUP_DIR/);
});

test("isAffirmativeResponse accepts short yes answers", () => {
    assert.equal(isAffirmativeResponse("y"), true);
    assert.equal(isAffirmativeResponse(" YES "), true);
    assert.equal(isAffirmativeResponse(""), false);
    assert.equal(isAffirmativeResponse("no"), false);
    assert.equal(
        isAffirmativeResponse(`${OPENAI_REPOSITORY} fresh`),
        false
    );
});

test("publicationConfirmationQuestion names each target and action", () => {
    assert.equal(
        publicationConfirmationQuestion({
            action: "create",
            repository: OPENAI_REPOSITORY,
        }),
        `Create and publish ${OPENAI_REPOSITORY}? [y/N] `
    );
    assert.equal(
        publicationConfirmationQuestion({
            action: "update",
            history: "append",
            repository: OPENAI_REPOSITORY,
        }),
        `Append and publish a commit to ${OPENAI_REPOSITORY}? [y/N] `
    );
    assert.equal(
        publicationConfirmationQuestion({
            action: "replace",
            history: "fresh",
            repository: OPENAI_REPOSITORY,
        }),
        `Replace main in ${OPENAI_REPOSITORY} with a fresh root commit and force-push? [y/N] `
    );
});

test("resolveCommitMessage defaults for root commits only", () => {
    assert.equal(
        resolveCommitMessage({ repositoryExists: false }),
        "Initial commit"
    );
    assert.equal(
        resolveCommitMessage({
            history: "fresh",
            repositoryExists: true,
        }),
        "Initial commit"
    );
    assert.equal(
        resolveCommitMessage({
            history: "append",
            repositoryExists: true,
            requestedMessage: UPDATE_MESSAGE,
        }),
        UPDATE_MESSAGE
    );
    assert.throws(
        () => resolveCommitMessage({
            history: "append",
            repositoryExists: true,
        }),
        /--message is required/
    );
});

test("parseHttpStatus recognizes GitHub API response formats", () => {
    assert.equal(parseHttpStatus("HTTP/2.0 404 Not Found\n"), HTTP_NOT_FOUND);
    assert.equal(parseHttpStatus("gh: Not Found (HTTP 404)\n"), HTTP_NOT_FOUND);
    assert.equal(parseHttpStatus("network unavailable\n"), null);
});

test("syncGeneratedTree replaces content while preserving Git metadata", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const target = join(root, "target");
        mkdirSync(join(source, "nested"), { recursive: true });
        mkdirSync(join(target, ".git"), { recursive: true });
        writeFileSync(join(source, ".gitignore"), "node_modules\n");
        writeFileSync(join(source, "nested", "value.txt"), "generated\n");
        writeFileSync(join(target, ".git", "marker"), "preserve\n");
        writeFileSync(join(target, "stale.txt"), "remove\n");

        syncGeneratedTree(source, target);

        assert.equal(readFileSync(join(target, ".git", "marker"), "utf8"), "preserve\n");
        assert.equal(readFileSync(join(target, ".gitignore"), "utf8"), "node_modules\n");
        assert.equal(readFileSync(join(target, "nested", "value.txt"), "utf8"), "generated\n");
        assert.equal(existsSync(join(target, "stale.txt")), false);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("mergeChangedPaths combines explicit tracked and untracked paths", () => {
    assert.deepEqual(
        mergeChangedPaths("README.md\0old.txt\0", ".gitignore\0README.md\0"),
        [".gitignore", "README.md", "old.txt"]
    );
});

test("system dependencies stage and commit explicit generated paths", async () => {
    const root = tempTree();
    const dependencies = createSystemDependencies(root);
    let workspace;
    try {
        const output = join(root, "dist", "openai");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, ".gitignore"), "node_modules\n");
        writeFileSync(join(output, "README.md"), "# Generated\n");

        workspace = await dependencies.prepareCheckout({
            config: {
                outputDirectory: "dist/openai",
                repository: "unused/local-test",
            },
            exists: false,
        });
        runGit(workspace.checkout, ["config", "user.name", "Template Test"]);
        runGit(workspace.checkout, [
            "config",
            "user.email",
            "template@example.test",
        ]);

        await dependencies.syncGeneratedTree(
            "dist/openai",
            workspace.checkout
        );
        const paths = await dependencies.collectChangedPaths(workspace.checkout);
        assert.deepEqual(paths, [".gitignore", "README.md"]);

        await dependencies.stagePaths(workspace.checkout, paths);
        const commit = await dependencies.createCommit({
            changedPaths: paths,
            checkout: workspace.checkout,
            history: undefined,
            message: "Initial commit",
        });
        assert.match(commit, /^[0-9a-f]{40,64}$/);
        assert.equal(
            runGit(workspace.checkout, ["status", "--porcelain=v1"]),
            ""
        );
    } finally {
        if (workspace) await dependencies.cleanup(workspace);
        rmSync(root, { force: true, recursive: true });
    }
});

test("system dependencies replace main with a backed-up parentless commit", async () => {
    const root = tempTree();
    try {
        const { initialCommit, remote } = createTemplateRemote(root);
        const checkout = join(root, "checkout");
        const backupRoot = join(root, "backups");
        execFileSync("git", [
            "clone",
            "--quiet",
            "--branch",
            "main",
            remote,
            checkout,
        ]);
        configureTestGit(checkout);
        writeFileSync(join(checkout, "README.md"), "# Fresh\n");
        writeFileSync(join(checkout, "fresh.txt"), "new\n");
        rmSync(join(checkout, "stale.txt"));

        const dependencies = createSystemDependencies(root);
        const changedPaths = await dependencies.collectChangedPaths(checkout);
        assert.deepEqual(changedPaths, [
            "README.md",
            "fresh.txt",
            "stale.txt",
        ]);
        await dependencies.stagePaths(checkout, changedPaths);
        const backup = await dependencies.createMirrorBackup({
            backupRoot,
            expectedCommit: initialCommit,
            repository: "local/template",
            url: remote,
        });
        const commit = await dependencies.createCommit({
            changedPaths,
            checkout,
            expectedCommit: initialCommit,
            history: "fresh",
            message: "Fresh template",
        });

        assert.equal(existsSync(backup), true);
        assert.equal(
            runGit(backup, ["rev-parse", "refs/heads/main"]).trim(),
            initialCommit
        );
        await assert.rejects(
            dependencies.createMirrorBackup({
                backupRoot,
                expectedCommit: initialCommit,
                repository: "local/template",
                url: remote,
            }),
            /already has a retained recovery mirror/
        );
        assert.equal(
            runGit(checkout, ["rev-list", "--parents", "-n", "1", commit]).trim(),
            commit
        );
        assert.equal(
            runGit(checkout, ["ls-tree", "-r", "--name-only", commit]),
            "README.md\nfresh.txt\n"
        );
        await dependencies.pushFresh({
            checkout,
            commit,
            expectedCommit: initialCommit,
        });
        assert.equal(
            runGit(remote, ["rev-parse", "refs/heads/main"]).trim(),
            commit
        );
        assert.equal(existsSync(backup), true);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("fresh publication lease rejects a remote that moved after backup", async () => {
    const root = tempTree();
    try {
        const { initialCommit, remote } = createTemplateRemote(root);
        const checkout = join(root, "checkout");
        const rival = join(root, "rival");
        execFileSync("git", ["clone", "--quiet", "--branch", "main", remote, checkout]);
        execFileSync("git", ["clone", "--quiet", "--branch", "main", remote, rival]);
        configureTestGit(checkout);
        configureTestGit(rival);

        writeFileSync(join(checkout, "README.md"), "# Fresh\n");
        const dependencies = createSystemDependencies(root);
        const changedPaths = await dependencies.collectChangedPaths(checkout);
        await dependencies.stagePaths(checkout, changedPaths);
        const backup = await dependencies.createMirrorBackup({
            backupRoot: join(root, "backups"),
            expectedCommit: initialCommit,
            repository: "local/template",
            url: remote,
        });
        const commit = await dependencies.createCommit({
            changedPaths,
            checkout,
            expectedCommit: initialCommit,
            history: "fresh",
            message: "Fresh template",
        });

        writeFileSync(join(rival, "rival.txt"), "rival\n");
        runGit(rival, ["add", "--", "rival.txt"]);
        runGit(rival, ["commit", "-m", "Concurrent update", "--", "rival.txt"]);
        runGit(rival, ["push", "--quiet", "origin", "main"]);
        const rivalCommit = runGit(rival, ["rev-parse", "HEAD"]).trim();

        await assert.rejects(
            dependencies.pushFresh({
                checkout,
                commit,
                expectedCommit: initialCommit,
            }),
            /force-with-lease/
        );
        assert.equal(
            runGit(remote, ["rev-parse", "refs/heads/main"]).trim(),
            rivalCommit
        );
        assert.equal(
            runGit(backup, ["rev-parse", "refs/heads/main"]).trim(),
            initialCommit
        );
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("factory preflight requires clean main matching origin/main", async () => {
    const root = tempTree();
    try {
        const factory = join(root, "factory");
        const remote = join(root, "origin.git");
        mkdirSync(factory);
        execFileSync("git", ["init", "--bare", remote]);
        execFileSync("git", ["init", "-b", "main", factory]);
        runGit(factory, ["config", "user.name", "Template Test"]);
        runGit(factory, ["config", "user.email", "template@example.test"]);
        writeFileSync(join(factory, "README.md"), "# Factory\n");
        runGit(factory, ["add", "--", "README.md"]);
        runGit(factory, [
            "commit",
            "-m",
            "Initial commit",
            "--",
            "README.md",
        ]);
        runGit(factory, ["remote", "add", "origin", remote]);
        runGit(factory, [
            "push",
            "--quiet",
            "--set-upstream",
            "origin",
            "main",
        ]);

        const dependencies = createSystemDependencies(factory);
        await assert.doesNotReject(dependencies.assertFactoryReady());

        writeFileSync(join(factory, "README.md"), "# Dirty factory\n");
        await assert.rejects(
            dependencies.assertFactoryReady(),
            /factory worktree must be clean/
        );
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("publishTemplates compares both variants before publishing and runs setup once", async () => {
    const fake = fakeDependencies({ exists: true });
    const results = await publishTemplates(
        {
            help: false,
            history: "append",
            message: UPDATE_MESSAGE,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "updated", variant: "openai" },
            { status: "updated", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.filter(
            (operation) => operation === "assertFactoryReady"
        ).length,
        1
    );
    assert.equal(
        fake.operations.filter((operation) => operation === "generate").length,
        1
    );
    assert.equal(
        fake.operations.indexOf(`collectChangedPaths:${WRANGLER_REPOSITORY}`)
            < fake.operations.indexOf(
                `stage:${OPENAI_REPOSITORY}:README.md`
            ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(fake.operations.includes("log:openai    updated"), true);
    assert.equal(fake.operations.includes("log:wrangler  updated"), true);
});

test("publishTemplates processes both variants for an explicit all selection", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const results = await publishTemplates(
        {
            help: false,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ variant }) => variant),
        ["openai", "wrangler"]
    );
});

test("publishTemplates rejects an omitted target before doing work", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                yes: true,
            },
            fake.dependencies
        ),
        /Pass all for both templates/
    );
    assert.deepEqual(fake.operations, []);
});

test("publishTemplates rejects inconsistent clobber options before doing work", async () => {
    const fake = fakeDependencies({ exists: true });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "append",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /requires fresh history/
    );
    assert.deepEqual(fake.operations, []);
});

test("publishTemplates reports unchanged variants without staging", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const results = await publishTemplates(
        {
            help: false,
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "unchanged", variant: "openai" },
            { status: "unchanged", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("stage:")),
        false
    );
    assert.equal(fake.operations.includes("log:Nothing published."), true);
});

test("publishTemplates creates a missing repository", async () => {
    const fake = fakeDependencies({ exists: false });
    const [result] = await publishTemplates(
        { help: false, variant: "openai", yes: true },
        fake.dependencies
    );

    assert.equal(result.action, "create");
    assert.equal(result.status, "created");
    assert.equal(
        fake.operations.includes(`createRepository:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("pushUpdate:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:create:Initial commit:README.md`
        ),
        true
    );
});

test("publishTemplates updates an existing repository with a normal push", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "append",
            message: UPDATE_MESSAGE,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.action, "update");
    assert.equal(result.status, "updated");
    assert.equal(
        fake.operations.includes(`pushUpdate:${WRANGLER_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("createRepository:")
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
});

test("publishTemplates replaces existing history only after creating a mirror", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.action, "replace");
    assert.equal(result.status, "replaced");
    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:fresh:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(`pushFresh:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.includes(`pushUpdate:${OPENAI_REPOSITORY}`),
        false
    );
    const backup = fake.operations.indexOf(
        `createMirrorBackup:${OPENAI_REPOSITORY}`
    );
    const commit = fake.operations.indexOf(
        `commit:${OPENAI_REPOSITORY}:fresh:${UPDATE_MESSAGE}:README.md`
    );
    const push = fake.operations.indexOf(`pushFresh:${OPENAI_REPOSITORY}`);
    assert.equal(backup < commit, true);
    assert.equal(commit < push, true);
    assert.equal(
        fake.operations.some(
            (operation) => operation.includes(
                `replaced (backup: backup:${OPENAI_REPOSITORY})`
            )
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            "log:After inspecting the replacement, clean up with npm run template:backups -- trash <variant>."
        ),
        true
    );
});

test("explicit fresh mode replaces history even when files are unchanged", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.status, "replaced");
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("stage:")),
        false
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:fresh:${UPDATE_MESSAGE}:`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(`pushFresh:${WRANGLER_REPOSITORY}`),
        true
    );
});

test("publishTemplates surfaces retained mirrors before factory verification", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        changedPaths: [],
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });
    await publishTemplates(
        {
            help: false,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(
        fake.operations.includes("log:== Retained recovery mirrors =="),
        true
    );
    assert.equal(
        fake.operations.includes(`log:  openai: ${backup}`),
        true
    );
    assert.equal(
        fake.operations.indexOf(`listRetainedBackups:${OPENAI_REPOSITORY}`)
            < fake.operations.indexOf("assertFactoryReady"),
        true
    );
});

test("publishTemplates refuses to accumulate fresh-mode mirrors", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });

    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "fresh",
                message: UPDATE_MESSAGE,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /stopped to avoid accumulating unresolved mirrors/
    );
    assert.equal(
        fake.operations.includes(`createMirrorBackup:${OPENAI_REPOSITORY}`),
        false
    );
    assert.equal(fake.operations.includes("assertFactoryReady"), false);
    assert.equal(fake.operations.includes("generate"), false);
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
});

test("clobber replaces all histories and cleans old and verified mirrors", async () => {
    const openaiBackup = "/state/openai-backup.git";
    const wranglerBackup = "/state/wrangler-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
            [WRANGLER_REPOSITORY]: [wranglerBackup],
        },
    });
    const results = await publishTemplates(
        {
            clobber: true,
            help: false,
            history: "fresh",
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ backup, backupTrashed, status, variant }) => ({
            backup,
            backupTrashed,
            status,
            variant,
        })),
        [
            {
                backup: undefined,
                backupTrashed: true,
                status: "replaced",
                variant: "openai",
            },
            {
                backup: undefined,
                backupTrashed: true,
                status: "replaced",
                variant: "wrangler",
            },
        ]
    );
    const oldCleanup = fake.operations.indexOf(
        `moveBackupsToTrash:${openaiBackup},${wranglerBackup}`
    );
    assert.equal(
        fake.operations.includes(
            "log:Clobber mode will move mirrors for selected targets to Trash after factory verification."
        ),
        true
    );
    assert.equal(
        fake.operations.indexOf("assertFactoryReady") < oldCleanup,
        true
    );
    assert.equal(oldCleanup < fake.operations.indexOf("generate"), true);
    for (const repository of [OPENAI_REPOSITORY, WRANGLER_REPOSITORY]) {
        assert.equal(
            fake.operations.includes(
                `commit:${repository}:fresh:Initial commit:README.md`
            ),
            true
        );
        const verify = fake.operations.indexOf(
            `verifyPublished:${repository}`
        );
        const cleanup = fake.operations.indexOf(
            `moveBackupsToTrash:backup:${repository}`
        );
        assert.equal(verify < cleanup, true);
        assert.equal(
            fake.operations.includes(`confirmBackupCleanup:${repository}`),
            false
        );
    }
});

test("clobber leaves retained mirrors for unselected variants untouched", async () => {
    const openaiBackup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        changedPaths: [],
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
        },
    });
    const [result] = await publishTemplates(
        {
            clobber: true,
            help: false,
            history: "fresh",
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.variant, "wrangler");
    assert.equal(result.backupTrashed, true);
    assert.equal(
        fake.operations.some((operation) => operation.includes(openaiBackup)),
        true
    );
    assert.equal(
        fake.operations.some((operation) =>
            operation.startsWith("moveBackupsToTrash:")
            && operation.includes(openaiBackup)
        ),
        false
    );
});

test("clobber stops before generation when old mirror cleanup fails", async () => {
    const backup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
        trashError: new Error("trash unavailable"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /could not move selected retained recovery mirrors to Trash/
    );
    assert.equal(fake.operations.includes("assertFactoryReady"), true);
    assert.equal(fake.operations.includes("generate"), false);
});

test("clobber retains a new mirror when remote verification fails", async () => {
    const fake = fakeDependencies({
        exists: true,
        verifyError: new Error("verification failed"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /verification failed/
    );
    assert.equal(
        fake.operations.includes(`createMirrorBackup:${OPENAI_REPOSITORY}`),
        true
    );
    assert.equal(
        fake.operations.includes(
            `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
        ),
        false
    );
});

test("clobber reports a retained mirror when verified cleanup fails", async () => {
    const fake = fakeDependencies({
        exists: true,
        trashError: new Error("trash unavailable"),
    });

    await assert.rejects(
        publishTemplates(
            {
                clobber: true,
                help: false,
                history: "fresh",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /published and verified, but clobber cleanup failed/
    );
    assert.equal(
        fake.operations.indexOf(`verifyPublished:${OPENAI_REPOSITORY}`)
            < fake.operations.indexOf(
                `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
            ),
        true
    );
});

test("explicit non-interactive fresh mode defaults its root commit message", async () => {
    const fake = fakeDependencies({ exists: true });
    const results = await publishTemplates(
        {
            help: false,
            history: "fresh",
            variant: "all",
            yes: true,
        },
        fake.dependencies
    );

    assert.deepEqual(
        results.map(({ status, variant }) => ({ status, variant })),
        [
            { status: "replaced", variant: "openai" },
            { status: "replaced", variant: "wrangler" },
        ]
    );
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:fresh:Initial commit:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:fresh:Initial commit:README.md`
        ),
        true
    );
});

test("explicit fresh mode keeps the initial message default for a missing repo", async () => {
    const fake = fakeDependencies({ exists: false });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.status, "created");
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:create:Initial commit:README.md`
        ),
        true
    );
});

test("explicit fresh mode ignores retained mirrors for unselected variants", async () => {
    const openaiBackup = "/state/openai-backup.git";
    const fake = fakeDependencies({
        changedPaths: [],
        exists: true,
        retainedBackupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
        },
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "wrangler",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.variant, "wrangler");
    assert.equal(result.status, "replaced");
});

test("interactive fresh publication trashes a verified mirror on request", async () => {
    const fake = fakeDependencies({
        cleanupBackup: true,
        exists: true,
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.backup, undefined);
    assert.equal(result.backupTrashed, true);
    const verify = fake.operations.indexOf(
        `verifyPublished:${OPENAI_REPOSITORY}`
    );
    const requestCleanup = fake.operations.indexOf(
        `confirmBackupCleanup:${OPENAI_REPOSITORY}`
    );
    const trash = fake.operations.indexOf(
        `moveBackupsToTrash:backup:${OPENAI_REPOSITORY}`
    );
    assert.equal(verify < requestCleanup, true);
    assert.equal(requestCleanup < trash, true);
    assert.equal(
        fake.operations.some((operation) =>
            operation.includes("replaced (backup moved to Trash)")
        ),
        true
    );
});

test("interactive fresh publication retains a mirror when Trash fails", async () => {
    const fake = fakeDependencies({
        cleanupBackup: true,
        exists: true,
        trashError: new Error("trash unavailable"),
    });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    assert.equal(result.backupTrashed, false);
    assert.equal(
        fake.operations.includes(
            "log:Could not move the mirror to Trash: trash unavailable"
        ),
        true
    );
});

test("non-interactive fresh publication retains its verified mirror", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            history: "fresh",
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: true,
        },
        fake.dependencies
    );

    assert.equal(result.backup, `backup:${OPENAI_REPOSITORY}`);
    assert.equal(result.backupTrashed, false);
    assert.equal(
        fake.operations.includes(
            `confirmBackupCleanup:${OPENAI_REPOSITORY}`
        ),
        false
    );
    assert.equal(
        fake.operations.includes(
            `log:Mirror backup retained at backup:${OPENAI_REPOSITORY}`
        ),
        true
    );
});

test("publishTemplates prompts for an update message after showing the diff", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.status, "updated");
    const showDiff = fake.operations.indexOf(
        `showStagedDiff:${OPENAI_REPOSITORY}`
    );
    const requestHistory = fake.operations.indexOf(
        `requestHistoryMode:${OPENAI_REPOSITORY}`
    );
    const requestMessage = fake.operations.indexOf(
        `requestCommitMessage:${OPENAI_REPOSITORY}`
    );
    const confirm = fake.operations.indexOf(
        `confirm:${OPENAI_REPOSITORY}:append`
    );
    assert.equal(showDiff < requestHistory, true);
    assert.equal(requestHistory < requestMessage, true);
    assert.equal(requestMessage < confirm, true);
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:append:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
});

test("publishTemplates requires a message for a changed update with --yes", async () => {
    const fake = fakeDependencies({ exists: true });
    await assert.rejects(
        publishTemplates(
            {
                help: false,
                history: "append",
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /--message is required/
    );
    assert.equal(
        fake.operations.includes(`stage:${OPENAI_REPOSITORY}:README.md`),
        true
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
    assert.equal(
        fake.operations.at(-1),
        `cleanup:${OPENAI_REPOSITORY}`
    );
});

test("publishTemplates requires an explicit history mode with --yes", async () => {
    const fake = fakeDependencies({ exists: true });
    await assert.rejects(
        publishTemplates(
            {
                help: false,
                message: UPDATE_MESSAGE,
                variant: "openai",
                yes: true,
            },
            fake.dependencies
        ),
        /--history is required/
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
});

test("publishTemplates cancels before committing or publishing", async () => {
    const fake = fakeDependencies({
        confirmed: false,
        exists: true,
        requestedHistory: "fresh",
    });
    const [result] = await publishTemplates(
        {
            help: false,
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: false,
        },
        fake.dependencies
    );

    assert.equal(result.status, "cancelled");
    assert.equal(result.action, "replace");
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("createMirrorBackup:")
        ),
        false
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("push")
        ),
        false
    );
    assert.equal(fake.operations.includes("log:Nothing published."), true);
    assert.equal(
        fake.operations.at(-1),
        `cleanup:${OPENAI_REPOSITORY}`
    );
});
