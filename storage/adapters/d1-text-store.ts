import type {
    PutTextItem,
    StoredTextItem,
    TextStore,
} from "../contracts";

export type SqlRunResult = {
    meta: {
        changes: number;
    };
};

export interface SqlPreparedStatement {
    all(): Promise<{ results: unknown[] }>;
    bind(...values: unknown[]): SqlPreparedStatement;
    first(): Promise<unknown | null>;
    run(): Promise<SqlRunResult>;
}

export interface SqlDatabase {
    prepare(query: string): SqlPreparedStatement;
}

type D1ValueRow = {
    key: string;
    size: number;
    updatedAt: string;
    value: string;
};

type Clock = () => string;

const createTableSql = `
    CREATE TABLE IF NOT EXISTS d1_values (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`;

const schemaInitializations = new WeakMap<SqlDatabase, Promise<void>>();

function systemClock(): string {
    return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseValueRow(value: unknown): D1ValueRow {
    if (
        !isRecord(value) ||
        typeof value["key"] !== "string" ||
        typeof value["size"] !== "number" ||
        !Number.isFinite(value["size"]) ||
        value["size"] < 0 ||
        typeof value["updatedAt"] !== "string" ||
        typeof value["value"] !== "string"
    ) {
        throw new Error("D1 returned an invalid d1_values row.");
    }

    return {
        key: value["key"],
        size: value["size"],
        updatedAt: value["updatedAt"],
        value: value["value"],
    };
}

function ensureSchema(database: SqlDatabase): Promise<void> {
    const existingInitialization = schemaInitializations.get(database);
    if (existingInitialization) return existingInitialization;

    const initialization = database
        .prepare(createTableSql)
        .run()
        .then(() => undefined)
        .catch((error: unknown) => {
            schemaInitializations.delete(database);
            throw error;
        });

    schemaInitializations.set(database, initialization);
    return initialization;
}

/** Adapts a D1-compatible SQLite binding to the provider-neutral TextStore API. */
export class D1TextStore implements TextStore {
    private readonly clock: Clock;
    private readonly database: SqlDatabase;

    constructor(database: SqlDatabase, clock: Clock = systemClock) {
        this.database = database;
        this.clock = clock;
    }

    async delete(key: string): Promise<boolean> {
        await ensureSchema(this.database);
        const result = await this.database
            .prepare("DELETE FROM d1_values WHERE key = ?1")
            .bind(key)
            .run();
        return result.meta.changes > 0;
    }

    async get(key: string): Promise<StoredTextItem | null> {
        await ensureSchema(this.database);
        const row = await this.database
            .prepare(
                `SELECT key, value, length(CAST(value AS BLOB)) AS size,
                        updated_at AS updatedAt
                 FROM d1_values
                 WHERE key = ?1`
            )
            .bind(key)
            .first();
        return row === null ? null : parseValueRow(row);
    }

    async list(limit: number): Promise<StoredTextItem[]> {
        await ensureSchema(this.database);
        const result = await this.database
            .prepare(
                `SELECT key, value, length(CAST(value AS BLOB)) AS size,
                        updated_at AS updatedAt
                 FROM d1_values
                 ORDER BY updated_at DESC, key ASC
                 LIMIT ?1`
            )
            .bind(limit)
            .all();
        return result.results.map(parseValueRow);
    }

    async put(item: PutTextItem): Promise<StoredTextItem> {
        await ensureSchema(this.database);
        const updatedAt = this.clock();
        await this.database
            .prepare(
                `INSERT INTO d1_values (key, value, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     updated_at = excluded.updated_at`
            )
            .bind(item.key, item.value, updatedAt)
            .run();

        return {
            key: item.key,
            size: new TextEncoder().encode(item.value).byteLength,
            updatedAt,
            value: item.value,
        };
    }
}
