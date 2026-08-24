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
    const testDir = join(treeDir, "test");
    const testFiles = readdirSync(testDir)
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => join("test", name));
    if (testFiles.length === 0) {
        console.error(`  no test files found in ${label}/test`);
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

function assertOpenaiProjectIdAbsent(treeDir) {
    const hosting = JSON.parse(
        readFileSync(join(treeDir, ".openai", "hosting.json"), "utf8")
    );
    if (Object.hasOwn(hosting, "project_id")) {
        console.error("openai emit retained project_id");
        process.exit(1);
    }
    console.log("  openai project_id omission verified");
}

console.log("Generating dist/openai ...");
const openaiDir = join(distRoot, "openai");
emitOpenai(repoRoot, openaiDir);
assertOpenaiProjectIdAbsent(openaiDir);
runResidueGuard(openaiDir, "openai", scanOpenaiResidue);
runInTreeTests(openaiDir, "openai");

console.log("Generating dist/wrangler ...");
const wranglerDir = join(distRoot, "wrangler");
emitWrangler(repoRoot, wranglerDir);
runResidueGuard(wranglerDir, "wrangler");
runInTreeTests(wranglerDir, "wrangler");

console.log("\nDone. Emitted dist/openai and dist/wrangler.");
