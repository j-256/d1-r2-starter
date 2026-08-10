import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createTemplateBackupDependencies,
    manageTemplateBackups,
    parseTemplateBackupArguments,
    templateBackupUsage,
} from "./template-backups-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
    const options = parseTemplateBackupArguments(process.argv.slice(2));
    if (options.help) {
        console.log(templateBackupUsage());
    } else {
        await manageTemplateBackups(
            options,
            createTemplateBackupDependencies(repoRoot)
        );
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Template backup management failed: ${message}`);
    console.error("");
    console.error(templateBackupUsage());
    process.exitCode = 1;
}
