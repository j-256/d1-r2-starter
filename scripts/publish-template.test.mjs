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
    mergeChangedPaths,
    parseHttpStatus,
    parsePublishArguments,
    publishTemplates,
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

function fakeDependencies(options = {}) {
    const operations = [];
    const defaultChangedPaths = options.changedPaths ?? ["README.md"];
    const defaultExists = options.exists ?? true;

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
            async confirm({ repository }) {
                operations.push(`confirm:${repository}`);
                return options.confirmedByRepository?.[repository]
                    ?? options.confirmed
                    ?? true;
            },
            async requestCommitMessage({ repository }) {
                operations.push(`requestCommitMessage:${repository}`);
                return options.messagesByRepository?.[repository]
                    ?? options.requestedMessage
                    ?? UPDATE_MESSAGE;
            },
            async commitPaths(checkout, paths, message) {
                operations.push(
                    `commit:${checkout}:${message}:${paths.join(",")}`
                );
                return `published-${checkout}`;
            },
            async pushUpdate(checkout) {
                operations.push(`pushUpdate:${checkout}`);
            },
            async createRepository(_checkout, repository) {
                operations.push(`createRepository:${repository}`);
            },
            async ensureTemplate(repository) {
                operations.push(`ensureTemplate:${repository}`);
            },
            async verifyPublished({ repository }) {
                operations.push(`verifyPublished:${repository}`);
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

test("parsePublishArguments defaults to both templates", () => {
    assert.deepEqual(parsePublishArguments([]), {
        help: false,
        message: undefined,
        variant: undefined,
        yes: false,
    });
});

test("parsePublishArguments accepts a variant, message, and confirmation flag", () => {
    assert.deepEqual(
        parsePublishArguments([
            "openai",
            "--message",
            UPDATE_MESSAGE,
            "--yes",
        ]),
        {
            help: false,
            message: UPDATE_MESSAGE,
            variant: "openai",
            yes: true,
        }
    );
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
});

test("resolveCommitMessage defaults only for initial publication", () => {
    assert.equal(resolveCommitMessage(false), "Initial commit");
    assert.equal(resolveCommitMessage(true, UPDATE_MESSAGE), UPDATE_MESSAGE);
    assert.throws(
        () => resolveCommitMessage(true),
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
        const commit = await dependencies.commitPaths(
            workspace.checkout,
            paths,
            "Initial commit"
        );
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
            message: UPDATE_MESSAGE,
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
            `commit:${OPENAI_REPOSITORY}:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(
        fake.operations.includes(
            `commit:${WRANGLER_REPOSITORY}:${UPDATE_MESSAGE}:README.md`
        ),
        true
    );
    assert.equal(fake.operations.includes("log:openai    updated"), true);
    assert.equal(fake.operations.includes("log:wrangler  updated"), true);
});

test("publishTemplates reports unchanged variants without staging", async () => {
    const fake = fakeDependencies({ changedPaths: [], exists: true });
    const results = await publishTemplates(
        {
            help: false,
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
            `commit:${OPENAI_REPOSITORY}:Initial commit:README.md`
        ),
        true
    );
});

test("publishTemplates updates an existing repository with a normal push", async () => {
    const fake = fakeDependencies({ exists: true });
    const [result] = await publishTemplates(
        {
            help: false,
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
            `commit:${WRANGLER_REPOSITORY}:${UPDATE_MESSAGE}:README.md`
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
    const requestMessage = fake.operations.indexOf(
        `requestCommitMessage:${OPENAI_REPOSITORY}`
    );
    const confirm = fake.operations.indexOf(`confirm:${OPENAI_REPOSITORY}`);
    assert.equal(showDiff < requestMessage, true);
    assert.equal(requestMessage < confirm, true);
    assert.equal(
        fake.operations.includes(
            `commit:${OPENAI_REPOSITORY}:${UPDATE_MESSAGE}:README.md`
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

test("publishTemplates cancels before committing or publishing", async () => {
    const fake = fakeDependencies({ confirmed: false, exists: true });
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
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("commit:")),
        false
    );
    assert.equal(
        fake.operations.some(
            (operation) => operation.startsWith("pushUpdate:")
        ),
        false
    );
    assert.equal(fake.operations.includes("log:Nothing published."), true);
    assert.equal(
        fake.operations.at(-1),
        `cleanup:${OPENAI_REPOSITORY}`
    );
});
