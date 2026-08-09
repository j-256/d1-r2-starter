import { getStorageBindings } from "../runtime/storage-bindings";

export type D1Value = {
    key: string;
    updatedAt: string;
    value: string;
};

const schemaSql = `
    CREATE TABLE IF NOT EXISTS d1_values (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`;

let schemaPromise: Promise<void> | null = null;

function getBinding() {
    const binding = getStorageBindings().DB;
    if (!binding) {
        throw new Error("The Cloudflare D1 binding is unavailable.");
    }
    return binding;
}

async function ensureSchema() {
    if (!schemaPromise) {
        schemaPromise = getBinding()
            .prepare(schemaSql)
            .run()
            .then(() => undefined)
            .catch((error) => {
                schemaPromise = null;
                throw error;
            });
    }
    await schemaPromise;
}

export async function listD1Values() {
    await ensureSchema();
    const result = await getBinding()
        .prepare(
            `SELECT key, value, updated_at AS updatedAt
             FROM d1_values
             ORDER BY updated_at DESC, key ASC
             LIMIT 50`
        )
        .all<D1Value>();
    return result.results;
}

export async function readD1Value(key: string) {
    await ensureSchema();
    return getBinding()
        .prepare(
            `SELECT key, value, updated_at AS updatedAt
             FROM d1_values
             WHERE key = ?1`
        )
        .bind(key)
        .first<D1Value>();
}

export async function writeD1Value(key: string, value: string) {
    await ensureSchema();
    const updatedAt = new Date().toISOString();
    await getBinding()
        .prepare(
            `INSERT INTO d1_values (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value,
                 updated_at = excluded.updated_at`
        )
        .bind(key, value, updatedAt)
        .run();
    return { key, value, updatedAt } satisfies D1Value;
}

export async function deleteD1Value(key: string) {
    await ensureSchema();
    const result = await getBinding()
        .prepare("DELETE FROM d1_values WHERE key = ?1")
        .bind(key)
        .run();
    return result.meta.changes > 0;
}
