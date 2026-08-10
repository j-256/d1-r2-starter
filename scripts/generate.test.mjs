import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForResidue, RESIDUE_PATTERN, FORBIDDEN_DEPS } from "./generate-lib.mjs";

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
