import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createSystemDependencies,
    parsePublishArguments,
    publishTemplates,
    publishUsage,
    resolvePublishInvocation,
} from "./publish-template-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
    const invocation = resolvePublishInvocation(process.argv.slice(2));
    if (invocation.notice) console.error(invocation.notice);
    const options = parsePublishArguments(invocation.args);
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
