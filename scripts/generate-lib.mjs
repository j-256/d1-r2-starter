import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";

// Paths copied verbatim into BOTH emitted trees. This is the shared product
// (openai gets these via copy-root; only the wrangler emit consumes this list)
export const SHARED_PATHS = [
    "app-context.ts",
    "app-services.ts",
    "features",
    "platform",
    "db",
    "drizzle",
    "drizzle.config.ts",
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

// Only these runtime scripts belong in the emitted OpenAI template
export const OPENAI_SCRIPT_ALLOWLIST = Object.freeze([
    "build-verified.sh",
    "install-ci.sh",
    "sites-env.sh",
    "validate-artifact.sh",
]);

// Factory-only files that live at non-dropped root paths and so survive the
// copy-root, but must not ship in the openai template. Repo-relative POSIX
// paths, scrubbed after the copy in emitOpenai. docs/PUBLISH.md is the
// maintainer publish runbook: it describes this repo as the private factory
// and references the sibling wrangler variant, so it is not template content
export const OPENAI_DROP_FILES = ["docs/PUBLISH.md"];

// Only these package commands belong in the emitted OpenAI template
export const OPENAI_PACKAGE_SCRIPT_ALLOWLIST = Object.freeze([
    "install:ci",
    "dev",
    "build",
    "start",
    "test",
    "test:build",
    "validate:artifact",
    "lint",
    "typecheck",
    "db:generate",
]);

// Forbidden tokens for the WRANGLER tree (contents and paths), case-insensitive
export const RESIDUE_PATTERN = /oai-|\.openai|chatgpt|siwc|vinext|codex-preview/i;

// Package names banned from the WRANGLER package.json dependency maps
export const FORBIDDEN_DEPS = ["next", "react", "react-dom", "vinext"];

export const WRANGLER_PACKAGE_FILES = Object.freeze([
    "package.json",
    "package-lock.json",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const COPY_EXCLUDED_NAMES = new Set([".DS_Store", ".git"]);
// Binary-ish extensions the content scan should skip (paths still checked)
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|otf|webp)$/i;

export function copyGeneratedPath(from, to) {
    cpSync(from, to, {
        filter: (source) => !COPY_EXCLUDED_NAMES.has(basename(source)),
        recursive: true,
    });
}

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

/** Emits the openai tree without factory tooling or factory Site linkage */
export function emitOpenai(repoRoot, outDir) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
        if (OPENAI_DROP.includes(entry.name)) continue;
        const from = join(repoRoot, entry.name);
        const to = join(outDir, entry.name);
        copyGeneratedPath(from, to);
    }

    // Keep only runtime scripts in the copied scripts/ directory
    const scriptsDir = join(outDir, "scripts");
    for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
        if (OPENAI_SCRIPT_ALLOWLIST.includes(entry.name)) continue;
        rmSync(join(scriptsDir, entry.name), {
            force: true,
            recursive: true,
        });
    }

    // Drop factory-only files that survive the copy-root at non-dropped paths,
    // and remove a parent directory the drop leaves empty (e.g. a bare docs/)
    for (const relPath of OPENAI_DROP_FILES) {
        const segments = relPath.split("/");
        rmSync(join(outDir, ...segments), { force: true });
        if (segments.length > 1) {
            const parent = join(outDir, ...segments.slice(0, -1));
            if (existsSync(parent) && readdirSync(parent).length === 0) {
                rmSync(parent, { recursive: true, force: true });
            }
        }
    }

    // Keep only runtime commands in the emitted package.json
    const packagePath = join(outDir, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    if (pkg.scripts) {
        pkg.scripts = Object.fromEntries(
            OPENAI_PACKAGE_SCRIPT_ALLOWLIST
                .filter((key) => key in pkg.scripts)
                .map((key) => [key, pkg.scripts[key]])
        );
    }
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");

    // Remove the factory Site linkage from the reusable emitted template
    const hostingPath = join(outDir, ".openai", "hosting.json");
    const hosting = JSON.parse(readFileSync(hostingPath, "utf8"));
    delete hosting.project_id;
    writeFileSync(hostingPath, JSON.stringify(hosting, null, 2) + "\n");
}

/**
 * Scans an emitted openai tree for factory-only residue that the copy-root
 * subtraction can miss and returns "relpath: reason" strings; empty means clean
 * Symmetric with scanForResidue (wrangler) so the openai emit also fails loud
 * instead of shipping factory tooling into a template that goes public
 */
export function scanOpenaiResidue(root) {
    const violations = [];

    for (const relPath of OPENAI_DROP_FILES) {
        if (existsSync(join(root, ...relPath.split("/")))) {
            violations.push(`${relPath}: factory-only file must not ship`);
        }
    }

    const scriptsDirectory = join(root, "scripts");
    if (existsSync(scriptsDirectory)) {
        for (const entry of readdirSync(scriptsDirectory)) {
            if (!OPENAI_SCRIPT_ALLOWLIST.includes(entry)) {
                violations.push(
                    `scripts/${entry}: unexpected template script`
                );
            }
        }
    }

    const packagePath = join(root, "package.json");
    if (existsSync(packagePath)) {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
        const scripts = pkg.scripts ?? {};
        for (const key of Object.keys(scripts)) {
            if (!OPENAI_PACKAGE_SCRIPT_ALLOWLIST.includes(key)) {
                violations.push(
                    `package.json: unexpected template script "${key}"`
                );
            }
        }
    }

    return violations;
}

/** Emits the wrangler tree: shared set + the wrangler overlay at root */
export function emitWrangler(repoRoot, outDir) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const shared of SHARED_PATHS) {
        copyGeneratedPath(join(repoRoot, shared), join(outDir, shared));
    }

    // Lay the wrangler overlay contents at the tree root
    const overlay = join(repoRoot, "variants", "wrangler");
    for (const file of WRANGLER_PACKAGE_FILES) {
        if (!existsSync(join(overlay, file))) {
            throw new Error(`Missing Wrangler package file: ${file}`);
        }
    }
    for (const entry of readdirSync(overlay, { withFileTypes: true })) {
        copyGeneratedPath(join(overlay, entry.name), join(outDir, entry.name));
    }
}
