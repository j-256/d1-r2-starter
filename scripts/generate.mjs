import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    emitOpenai,
    emitWrangler,
    scanForResidue,
    scanOpenaiResidue,
} from "./generate-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "dist");

const TEST_FLAGS = [
    "--experimental-sqlite",
    "--experimental-strip-types",
    "--test",
];

function runInTreeTests(treeDir, label) {
    console.log(`  running buildless suite in ${label} ...`);
    const testsDir = join(treeDir, "tests");
    const testFiles = readdirSync(testsDir)
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => join("tests", name));
    if (testFiles.length === 0) {
        console.error(`  no test files found in ${label}/tests`);
        process.exit(1);
    }
    execFileSync(process.execPath, [...TEST_FLAGS, ...testFiles], {
        cwd: treeDir,
        stdio: "inherit",
    });
}

function runResidueGuard(treeDir, label, scan = scanForResidue) {
    const violations = scan(treeDir);
    if (violations.length > 0) {
        console.error(`RESIDUE GUARD FAILED for ${label}:`);
        for (const violation of violations) console.error(`  - ${violation}`);
        process.exit(1);
    }
    console.log(`  residue guard passed for ${label}`);
}

function assertOpenaiPlaceholder(treeDir) {
    const hosting = JSON.parse(
        readFileSync(join(treeDir, ".openai", "hosting.json"), "utf8")
    );
    if (hosting.project_id !== "REPLACE_WITH_YOUR_SITES_PROJECT_ID") {
        console.error("openai emit did not placeholder project_id");
        process.exit(1);
    }
    console.log("  openai project_id placeholder verified");
}

console.log("Generating dist/openai ...");
const openaiDir = join(distRoot, "openai");
emitOpenai(repoRoot, openaiDir);
assertOpenaiPlaceholder(openaiDir);
runResidueGuard(openaiDir, "openai", scanOpenaiResidue);
runInTreeTests(openaiDir, "openai");

console.log("Generating dist/wrangler ...");
const wranglerDir = join(distRoot, "wrangler");
emitWrangler(repoRoot, wranglerDir);
runResidueGuard(wranglerDir, "wrangler");
runInTreeTests(wranglerDir, "wrangler");

console.log("\nDone. Emitted dist/openai and dist/wrangler.");
