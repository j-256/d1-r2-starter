import {
    cpSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

// Paths copied verbatim into BOTH emitted trees. This is the shared product
// (openai gets these via copy-root; only the wrangler emit consumes this list)
export const SHARED_PATHS = [
    "storage",
    "db",
    "drizzle",
    "drizzle.config.ts",
    "runtime",
    "routes",
    "tests",
    "LICENSE",
];

// Top-level names removed from the openai copy-root: factory-only tooling,
// build output, agent scratch, and OS junk. Everything else at root is the
// openai shell and ships as-is
export const OPENAI_DROP = [
    ".git",
    "node_modules",
    "dist",
    "variants",
    ".vinext",
    ".wrangler",
    ".sites-runtime",
    "outputs",
    "work",
    ".superpowers",
    ".DS_Store",
];

// scripts/ is dropped selectively: the generator files must not ship, but the
// openai Sites scripts must. Handled in emitOpenai, not here
export const OPENAI_DROP_SCRIPTS = [
    "generate.mjs",
    "generate-lib.mjs",
    "generate.test.mjs",
];

// Forbidden tokens for the WRANGLER tree (contents and paths), case-insensitive
export const RESIDUE_PATTERN = /oai-|\.openai|chatgpt|siwc|vinext|codex-preview/i;

// Package names banned from the WRANGLER package.json dependency maps
export const FORBIDDEN_DEPS = ["next", "react", "react-dom", "vinext"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
// Binary-ish extensions the content scan should skip (paths still checked)
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|otf|webp)$/i;

function walk(root) {
    const files = [];
    function recurse(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                recurse(join(dir, entry.name));
            } else if (entry.isFile()) {
                files.push(join(dir, entry.name));
            }
        }
    }
    recurse(root);
    return files;
}

/**
 * Scans an emitted tree for forbidden residue. Returns an array of
 * "relpath: reason" strings; empty means clean. Checks: every relative path
 * against RESIDUE_PATTERN, every text file's contents against RESIDUE_PATTERN,
 * and package.json dependency maps against FORBIDDEN_DEPS
 */
export function scanForResidue(root) {
    const violations = [];
    for (const absolute of walk(root)) {
        const rel = relative(root, absolute).split(sep).join("/");

        if (RESIDUE_PATTERN.test(rel)) {
            violations.push(`${rel}: forbidden token in path`);
        }

        if (BINARY_EXT.test(rel)) continue;

        const contents = readFileSync(absolute, "utf8");
        const match = contents.match(RESIDUE_PATTERN);
        if (match) {
            violations.push(`${rel}: forbidden token "${match[0]}"`);
        }

        if (rel === "package.json") {
            let pkg;
            try {
                pkg = JSON.parse(contents);
            } catch {
                violations.push(`${rel}: invalid JSON`);
                continue;
            }
            const deps = {
                ...(pkg.dependencies ?? {}),
                ...(pkg.devDependencies ?? {}),
            };
            for (const banned of FORBIDDEN_DEPS) {
                if (banned in deps) {
                    violations.push(`${rel}: forbidden dependency "${banned}"`);
                }
            }
        }
    }
    return violations;
}

/** Emits the openai tree: copy-root minus drops, then placeholder the id */
export function emitOpenai(repoRoot, outDir) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
        if (OPENAI_DROP.includes(entry.name)) continue;
        const from = join(repoRoot, entry.name);
        const to = join(outDir, entry.name);
        cpSync(from, to, { recursive: true });
    }

    // Drop the generator files from the copied scripts/ dir
    const scriptsDir = join(outDir, "scripts");
    for (const name of OPENAI_DROP_SCRIPTS) {
        rmSync(join(scriptsDir, name), { force: true });
    }

    // Placeholder the real project_id in the emitted hosting.json only
    const hostingPath = join(outDir, ".openai", "hosting.json");
    const hosting = JSON.parse(readFileSync(hostingPath, "utf8"));
    hosting.project_id = "REPLACE_WITH_YOUR_SITES_PROJECT_ID";
    writeFileSync(hostingPath, JSON.stringify(hosting, null, 2) + "\n");
}

/** Emits the wrangler tree: shared set + the wrangler overlay at root */
export function emitWrangler(repoRoot, outDir) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const shared of SHARED_PATHS) {
        cpSync(join(repoRoot, shared), join(outDir, shared), {
            recursive: true,
        });
    }

    // Lay the wrangler overlay contents at the tree root
    const overlay = join(repoRoot, "variants", "wrangler");
    for (const entry of readdirSync(overlay, { withFileTypes: true })) {
        cpSync(join(overlay, entry.name), join(outDir, entry.name), {
            recursive: true,
        });
    }
}
