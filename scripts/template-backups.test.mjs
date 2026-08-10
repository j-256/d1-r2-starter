import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    availableBackupPath,
    listRetainedMirrorBackups,
    manageTemplateBackups,
    parseTemplateBackupArguments,
    templateBackupRoot,
    templateBackupUsage,
} from "./template-backups-lib.mjs";

const OPENAI_REPOSITORY = "j-256/d1-r2-starter-openai";
const WRANGLER_REPOSITORY = "j-256/d1-r2-starter-wrangler";

function tempTree() {
    return mkdtempSync(join(tmpdir(), "template-backups-test-"));
}

function fakeDependencies(options = {}) {
    const operations = [];
    return {
        dependencies: {
            listRetainedBackups(repository) {
                operations.push(`listRetainedBackups:${repository}`);
                return options.backupsByRepository?.[repository] ?? [];
            },
            log(message) {
                operations.push(`log:${message}`);
            },
            async moveToTrash(paths) {
                operations.push(`moveToTrash:${paths.join(",")}`);
            },
        },
        operations,
    };
}

test("templateBackupRoot honors explicit and XDG state locations", () => {
    assert.equal(
        templateBackupRoot({
            environment: {
                TEMPLATE_PUBLISH_BACKUP_DIR: "/custom/backups",
                XDG_STATE_HOME: "/ignored",
            },
            homeDirectory: "/home/test",
        }),
        "/custom/backups"
    );
    assert.equal(
        templateBackupRoot({
            environment: { XDG_STATE_HOME: "/state" },
            homeDirectory: "/home/test",
        }),
        "/state/d1-r2-starter/template-publish-backups"
    );
    assert.equal(
        templateBackupRoot({
            environment: {},
            homeDirectory: "/home/test",
        }),
        "/home/test/.local/state/d1-r2-starter/template-publish-backups"
    );
});

test("listRetainedMirrorBackups finds legacy timestamped mirrors", () => {
    const root = tempTree();
    try {
        const openaiBackup = availableBackupPath(
            root,
            OPENAI_REPOSITORY,
            "20260810T120000Z"
        );
        mkdirSync(openaiBackup);
        const collision = availableBackupPath(
            root,
            OPENAI_REPOSITORY,
            "20260810T120000Z"
        );
        const wranglerBackup = availableBackupPath(
            root,
            WRANGLER_REPOSITORY,
            "20260810T120000Z"
        );
        mkdirSync(collision);
        mkdirSync(wranglerBackup);
        writeFileSync(join(root, "unrelated.txt"), "ignore\n");

        assert.deepEqual(
            listRetainedMirrorBackups({
                backupRoot: root,
                repository: OPENAI_REPOSITORY,
            }),
            [collision, openaiBackup].sort()
        );
        assert.deepEqual(
            listRetainedMirrorBackups({
                backupRoot: root,
                repository: WRANGLER_REPOSITORY,
            }),
            [wranglerBackup]
        );
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test("parseTemplateBackupArguments supports listing and selected cleanup", () => {
    assert.deepEqual(parseTemplateBackupArguments([]), {
        action: "list",
        help: false,
        variant: undefined,
    });
    assert.deepEqual(parseTemplateBackupArguments(["openai"]), {
        action: "list",
        help: false,
        variant: "openai",
    });
    assert.deepEqual(parseTemplateBackupArguments(["list", "wrangler"]), {
        action: "list",
        help: false,
        variant: "wrangler",
    });
    assert.deepEqual(parseTemplateBackupArguments(["trash", "wrangler"]), {
        action: "trash",
        help: false,
        variant: "wrangler",
    });
    assert.throws(
        () => parseTemplateBackupArguments(["trash"]),
        /requires an openai or wrangler variant/
    );
    assert.throws(
        () => parseTemplateBackupArguments(["other"]),
        /Unknown template variant/
    );
});

test("templateBackupUsage documents listing and explicit cleanup", () => {
    const usage = templateBackupUsage();
    assert.match(usage, /npm run template:backups/);
    assert.match(usage, /trash <openai\|wrangler>/);
    assert.match(usage, /Trash/);
});

test("manageTemplateBackups lists retained mirrors without moving them", async () => {
    const backup = "/state/openai.git";
    const fake = fakeDependencies({
        backupsByRepository: {
            [OPENAI_REPOSITORY]: [backup],
        },
    });
    const result = await manageTemplateBackups(
        { action: "list", help: false, variant: undefined },
        fake.dependencies
    );

    assert.equal(result[0].path, backup);
    assert.equal(
        fake.operations.includes(`log:  openai: ${backup}`),
        true
    );
    assert.equal(
        fake.operations.some((operation) => operation.startsWith("moveToTrash:")),
        false
    );
});

test("manageTemplateBackups moves only the explicit variant to Trash", async () => {
    const openaiBackup = "/state/openai.git";
    const wranglerBackup = "/state/wrangler.git";
    const fake = fakeDependencies({
        backupsByRepository: {
            [OPENAI_REPOSITORY]: [openaiBackup],
            [WRANGLER_REPOSITORY]: [wranglerBackup],
        },
    });
    const result = await manageTemplateBackups(
        { action: "trash", help: false, variant: "openai" },
        fake.dependencies
    );

    assert.deepEqual(result, []);
    assert.equal(
        fake.operations.includes(`moveToTrash:${openaiBackup}`),
        true
    );
    assert.equal(
        fake.operations.includes(`listRetainedBackups:${WRANGLER_REPOSITORY}`),
        false
    );
    assert.equal(
        fake.operations.includes(
            "log:openai: retained mirrors moved to Trash."
        ),
        true
    );
});
