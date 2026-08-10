import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { TEMPLATE_VARIANTS } from "./template-variants.mjs";

const BACKUP_ACTIONS = Object.freeze({
    list: "list",
    trash: "trash",
});
const BACKUP_DIRECTORY_ENV = "TEMPLATE_PUBLISH_BACKUP_DIR";
export const TEMPLATE_BACKUP_COMMANDS = Object.freeze({
    list: "npm run template:backups",
    trash: "npm run template:backups -- trash <variant>",
});
const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";

function commandFailure(command, args, result) {
    const details = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
    const suffix = details ? `\n${details}` : "";
    return new Error(
        `Command failed (${result.status ?? "unknown"}): ${command} ${args.join(" ")}${suffix}`
    );
}

function repositorySlug(repository) {
    return repository.replace(/[^A-Za-z0-9._-]+/g, "--");
}

export function repositoryAcceptancePhrase(repository) {
    return `${repository} accepted`;
}

export function templateBackupRoot({
    environment = process.env,
    homeDirectory = homedir(),
} = {}) {
    const configured = environment[BACKUP_DIRECTORY_ENV]?.trim();
    if (configured) return resolve(configured);

    const configuredStateHome = environment[XDG_STATE_HOME_ENV]?.trim();
    const stateHome = configuredStateHome
        ? resolve(configuredStateHome)
        : join(homeDirectory, ".local", "state");
    return join(
        stateHome,
        "d1-r2-starter",
        "template-publish-backups"
    );
}

export function backupTimestamp(date = new Date()) {
    return date.toISOString()
        .replaceAll("-", "")
        .replaceAll(":", "")
        .replace(/\.\d{3}Z$/, "Z");
}

export function availableBackupPath(
    root,
    repository,
    timestamp = backupTimestamp()
) {
    mkdirSync(root, { recursive: true });
    const basename = `${repositorySlug(repository)}-${timestamp}`;
    let suffix = 0;
    let candidate = join(root, `${basename}.git`);
    while (existsSync(candidate)) {
        suffix += 1;
        candidate = join(root, `${basename}-${suffix}.git`);
    }
    return candidate;
}

export function listRetainedMirrorBackups({
    backupRoot = templateBackupRoot(),
    repository,
}) {
    if (!repository) throw new Error("A template repository is required.");
    if (!existsSync(backupRoot)) return [];

    const slug = repositorySlug(repository);
    return readdirSync(backupRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) =>
            name === `${slug}.git`
            || (name.startsWith(`${slug}-`) && name.endsWith(".git"))
        )
        .sort()
        .map((name) => join(backupRoot, name));
}

export function moveMirrorBackupsToTrash(paths, { cwd } = {}) {
    if (paths.length === 0) return;
    const result = spawnSync("trash", paths, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw commandFailure("trash", paths, result);
    }
}

export function parseTemplateBackupArguments(args) {
    let help = false;
    const positional = [];

    for (const argument of args) {
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}`);
        }
        positional.push(argument);
    }

    const requestedAction = positional[0];
    const action = Object.hasOwn(BACKUP_ACTIONS, requestedAction)
        ? positional.shift()
        : BACKUP_ACTIONS.list;
    if (positional.length > 1) {
        throw new Error(`Unexpected argument: ${positional[1]}`);
    }
    const [variant] = positional;
    if (help) return { action, help: true, variant };
    if (variant !== undefined && !(variant in TEMPLATE_VARIANTS)) {
        throw new Error(
            `Unknown template variant: ${variant}. Choose openai or wrangler.`
        );
    }
    if (action === BACKUP_ACTIONS.trash && !variant) {
        throw new Error("trash requires an openai or wrangler variant.");
    }
    return { action, help: false, variant };
}

export function templateBackupUsage() {
    return [
        "Usage:",
        "  npm run template:backups",
        "  npm run template:backups -- [openai|wrangler]",
        "  npm run template:backups -- trash <openai|wrangler>",
        "",
        "Commands:",
        "  list                 List retained recovery mirrors (default)",
        "  trash <variant>      Move accepted mirrors for one template to Trash",
        "  --help               Show this help",
        "",
        "Environment:",
        "  TEMPLATE_PUBLISH_BACKUP_DIR  Override the mirror directory",
    ].join("\n");
}

function selectedVariants(variant) {
    return variant ? [variant] : Object.keys(TEMPLATE_VARIANTS);
}

function retainedBackupRecords(variant, dependencies) {
    return selectedVariants(variant).flatMap((selectedVariant) => {
        const repository = TEMPLATE_VARIANTS[selectedVariant].repository;
        return dependencies.listRetainedBackups(repository).map((path) => ({
            path,
            repository,
            variant: selectedVariant,
        }));
    });
}

export async function manageTemplateBackups(options, dependencies) {
    const records = retainedBackupRecords(options.variant, dependencies);
    if (records.length === 0) {
        dependencies.log("No retained template publication mirrors.");
        return [];
    }

    dependencies.log("Retained template publication mirrors:");
    for (const record of records) {
        dependencies.log(`  ${record.variant}: ${record.path}`);
    }

    if (options.action === BACKUP_ACTIONS.list) {
        dependencies.log("");
        dependencies.log(
            `After accepting a rewritten repository, run ${TEMPLATE_BACKUP_COMMANDS.trash}.`
        );
        return records;
    }

    const repository = TEMPLATE_VARIANTS[options.variant].repository;
    const confirmed = await dependencies.confirmAcceptance({ repository });
    if (!confirmed) {
        dependencies.log("Nothing moved to Trash.");
        return records;
    }
    await dependencies.moveToTrash(records.map(({ path }) => path));
    dependencies.log(`${options.variant}: accepted mirrors moved to Trash.`);
    return [];
}

export function createTemplateBackupDependencies(repoRoot) {
    return {
        confirmAcceptance: async ({ repository }) => {
            if (!process.stdin.isTTY || !process.stdout.isTTY) {
                throw new Error(
                    `Accepting the replacement for ${repository} requires a terminal.`
                );
            }
            const expected = repositoryAcceptancePhrase(repository);
            const readline = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                const answer = await readline.question(
                    `Type ${expected} to move its retained mirrors to Trash: `
                );
                return answer.trim() === expected;
            } finally {
                readline.close();
            }
        },
        listRetainedBackups(repository) {
            return listRetainedMirrorBackups({ repository });
        },
        log(message) {
            console.log(message);
        },
        moveToTrash(paths) {
            moveMirrorBackupsToTrash(paths, { cwd: repoRoot });
        },
    };
}
