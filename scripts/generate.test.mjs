import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    copyGeneratedPath,
    emitOpenai,
    OPENAI_PACKAGE_SCRIPT_ALLOWLIST,
    OPENAI_SCRIPT_ALLOWLIST,
    scanForResidue,
    scanOpenaiResidue,
    RESIDUE_PATTERN,
    FORBIDDEN_DEPS,
} from "./generate-lib.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const VALIDATE_ARTIFACT_SCRIPT = join(
    SCRIPT_DIRECTORY,
    "validate-artifact.sh"
);
const REQUIRED_SITE_MIGRATIONS = Object.freeze([
    "0000_complex_thena.sql",
    "0001_add-content-type-demo.sql",
    "meta/_journal.json",
]);

function tempTree() {
    return mkdtempSync(join(tmpdir(), "gen-guard-"));
}

function writeArtifactFixture(root) {
    const workerDirectory = join(root, "dist", "server");
    const openaiDirectory = join(root, "dist", ".openai");
    const migrationRoot = join(openaiDirectory, "drizzle");
    mkdirSync(workerDirectory, { recursive: true });
    mkdirSync(openaiDirectory, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(
        join(workerDirectory, "index.js"),
        "export default { fetch() {} };\n"
    );
    writeFileSync(join(openaiDirectory, "hosting.json"), "{}\n");
    for (const migration of REQUIRED_SITE_MIGRATIONS) {
        const target = join(migrationRoot, migration);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "fixture\n");
    }
}

function runArtifactValidator(root) {
    return execFileSync("bash", [VALIDATE_ARTIFACT_SCRIPT], {
        encoding: "utf8",
        env: {
            ...process.env,
            SITES_ENV_READY: "1",
            SITES_PROJECT_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

test("scanForResidue passes a clean tree", () => {
    const root = tempTree();
    try {
        writeFileSync(join(root, "ok.ts"), "export const x = 1;\n");
        mkdirSync(join(root, "sub"));
        writeFileSync(join(root, "sub", "note.md"), "A Hono worker.\n");
        assert.deepEqual(scanForResidue(root), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("copyGeneratedPath excludes nested Git and macOS metadata", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const target = join(root, "target");
        mkdirSync(join(source, "nested", ".git"), { recursive: true });
        writeFileSync(join(source, "nested", ".DS_Store"), "metadata\n");
        writeFileSync(join(source, "nested", ".git", "config"), "private\n");
        writeFileSync(join(source, "nested", "keep.txt"), "public\n");

        copyGeneratedPath(source, target);

        assert.equal(existsSync(join(target, "nested", ".DS_Store")), false);
        assert.equal(existsSync(join(target, "nested", ".git")), false);
        assert.equal(existsSync(join(target, "nested", "keep.txt")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitOpenai removes the factory project_id from the reusable manifest", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        mkdirSync(join(source, ".openai"), { recursive: true });
        mkdirSync(join(source, "scripts"));
        writeFileSync(
            join(source, "package.json"),
            JSON.stringify({ scripts: { build: "vinext build" } })
        );
        writeFileSync(
            join(source, ".openai", "hosting.json"),
            `${JSON.stringify({
                d1: "DB",
                project_id: "factory-project",
                r2: "BUCKET",
            })}\n`
        );

        emitOpenai(source, output);

        const emitted = JSON.parse(
            readFileSync(join(output, ".openai", "hosting.json"), "utf8")
        );
        const factory = JSON.parse(
            readFileSync(join(source, ".openai", "hosting.json"), "utf8")
        );
        assert.deepEqual(emitted, { d1: "DB", r2: "BUCKET" });
        assert.equal(factory.project_id, "factory-project");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("emitOpenai allowlists runtime scripts and package commands", () => {
    const root = tempTree();
    try {
        const source = join(root, "source");
        const output = join(root, "output");
        mkdirSync(join(source, ".openai"), { recursive: true });
        mkdirSync(join(source, "scripts"));
        writeFileSync(
            join(source, "scripts", "sites-env.sh"),
            "#!/bin/bash\n"
        );
        writeFileSync(
            join(source, "scripts", "future-factory-tool.mjs"),
            "export {};\n"
        );
        writeFileSync(
            join(source, "package.json"),
            JSON.stringify({
                scripts: {
                    build: "vinext build",
                    "template:future": "node scripts/future-factory-tool.mjs",
                },
            })
        );
        writeFileSync(join(source, ".openai", "hosting.json"), "{}\n");

        emitOpenai(source, output);

        assert.equal(
            existsSync(join(output, "scripts", "sites-env.sh")),
            true
        );
        assert.equal(
            existsSync(join(output, "scripts", "future-factory-tool.mjs")),
            false
        );
        const emittedPackage = JSON.parse(
            readFileSync(join(output, "package.json"), "utf8")
        );
        assert.deepEqual(emittedPackage.scripts, { build: "vinext build" });
        assert.equal(OPENAI_SCRIPT_ALLOWLIST.includes("sites-env.sh"), true);
        assert.equal(OPENAI_PACKAGE_SCRIPT_ALLOWLIST.includes("build"), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact accepts the complete packaged migration history", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        assert.match(runArtifactValidator(root), /migration history/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact rejects a missing packaged migration", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        rmSync(
            join(
                root,
                "dist",
                ".openai",
                "drizzle",
                "0001_add-content-type-demo.sql"
            )
        );
        assert.throws(
            () => runArtifactValidator(root),
            (error) => {
                assert.match(
                    String(error.stderr),
                    /Missing packaged Sites migration file/
                );
                return true;
            }
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validate-artifact rejects the obsolete project_id placeholder", () => {
    const root = tempTree();
    try {
        writeArtifactFixture(root);
        writeFileSync(
            join(root, "dist", ".openai", "hosting.json"),
            '{"project_id":"REPLACE_WITH_YOUR_SITES_PROJECT_ID"}\n'
        );
        assert.throws(
            () => runArtifactValidator(root),
            (error) => {
                assert.match(
                    String(error.stderr),
                    /obsolete project_id placeholder/
                );
                return true;
            }
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue flags a forbidden token in file contents", () => {
    const root = tempTree();
    try {
        writeFileSync(join(root, "leak.ts"), 'const h = "oai-authenticated-user-email";\n');
        const violations = scanForResidue(root);
        assert.equal(violations.length >= 1, true);
        assert.match(violations[0], /leak\.ts/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue flags a forbidden token in a path", () => {
    const root = tempTree();
    try {
        mkdirSync(join(root, ".openai"));
        writeFileSync(join(root, ".openai", "hosting.json"), "{}\n");
        const violations = scanForResidue(root);
        assert.equal(violations.length >= 1, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanForResidue flags a forbidden dependency in package.json", () => {
    const root = tempTree();
    try {
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({ dependencies: { next: "16.0.0", hono: "4.13.1" } })
        );
        const violations = scanForResidue(root);
        assert.equal(violations.some((v) => v.includes("next")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("RESIDUE_PATTERN and FORBIDDEN_DEPS cover the expected tokens", () => {
    assert.match("vinext", RESIDUE_PATTERN);
    assert.match("chatgpt", RESIDUE_PATTERN);
    assert.match("codex-preview", RESIDUE_PATTERN);
    assert.equal(FORBIDDEN_DEPS.includes("next"), true);
    assert.equal(FORBIDDEN_DEPS.includes("vinext"), true);
});

// A minimal emitted-openai shell that scanOpenaiResidue should pass
function writeCleanOpenaiTree(root) {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "sites-env.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { build: "vinext build", typecheck: "tsc" } })
    );
}

test("scanOpenaiResidue passes a clean openai tree", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        assert.deepEqual(scanOpenaiResidue(root), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags a leaked factory-only docs/PUBLISH.md", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        mkdirSync(join(root, "docs"));
        writeFileSync(join(root, "docs", "PUBLISH.md"), "# factory only\n");
        const violations = scanOpenaiResidue(root);
        assert.equal(violations.some((v) => v.includes("docs/PUBLISH.md")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags an unexpected package command", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({
                scripts: {
                    build: "vinext build",
                    "template:backups": "node scripts/template-backups.mjs",
                },
            })
        );
        const violations = scanOpenaiResidue(root);
        assert.equal(
            violations.some((violation) =>
                violation.includes("template:backups")
            ),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags an unexpected script file", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        writeFileSync(
            join(root, "scripts", "template-backups.mjs"),
            "export {};\n"
        );
        const violations = scanOpenaiResidue(root);
        assert.equal(
            violations.some((violation) =>
                violation.includes("template-backups.mjs")
            ),
            true
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
