import assert from "node:assert/strict";
import test from "node:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    copyGeneratedPath,
    scanForResidue,
    scanOpenaiResidue,
    RESIDUE_PATTERN,
    FORBIDDEN_DEPS,
} from "./generate-lib.mjs";

function tempTree() {
    return mkdtempSync(join(tmpdir(), "gen-guard-"));
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

test("scanOpenaiResidue flags dangling generate scripts in package.json", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({
                scripts: {
                    build: "vinext build",
                    generate: "node scripts/generate.mjs",
                },
            })
        );
        const violations = scanOpenaiResidue(root);
        assert.equal(violations.some((v) => v.includes("generate")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("scanOpenaiResidue flags a leaked generator script under scripts/", () => {
    const root = tempTree();
    try {
        writeCleanOpenaiTree(root);
        writeFileSync(join(root, "scripts", "generate.mjs"), "// leaked\n");
        const violations = scanOpenaiResidue(root);
        assert.equal(violations.some((v) => v.includes("generate.mjs")), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
