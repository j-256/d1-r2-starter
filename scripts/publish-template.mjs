import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createSystemDependencies,
    parsePublishArguments,
    publishTemplates,
    publishUsage,
} from "./publish-template-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
    const options = parsePublishArguments(process.argv.slice(2));
    if (options.help) {
        console.log(publishUsage());
    } else {
        await publishTemplates(options, createSystemDependencies(repoRoot));
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Template publication failed: ${message}`);
    console.error("");
    console.error(publishUsage());
    process.exitCode = 1;
}
