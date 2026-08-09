import assert from "node:assert/strict";
import test from "node:test";
import {
    D1TextStore,
    type SqlDatabase,
    type SqlPreparedStatement,
    type SqlRunResult,
} from "../storage/adapters/d1-text-store.ts";
import {
    R2TextStore,
    type ObjectBucket,
    type ObjectMetadata,
    type TextObjectBody,
} from "../storage/adapters/r2-text-store.ts";
import { parseStorageApiPayload } from "../storage/api-payload.ts";
import type { TextStore } from "../storage/contracts.ts";

type TestRow = {
    key: string;
    size: number;
    updatedAt: string;
    value: string;
};

class FakeSqlStatement implements SqlPreparedStatement {
    private readonly database: FakeSqlDatabase;
    private readonly query: string;
    private values: unknown[] = [];

    constructor(database: FakeSqlDatabase, query: string) {
        this.database = database;
        this.query = query;
    }

    bind(...values: unknown[]): SqlPreparedStatement {
        this.values = values;
        return this;
    }

    async all(): Promise<{ results: unknown[] }> {
        const limit = this.numberAt(0);
        const rows = [...this.database.rows.values()]
            .sort((left, right) => (
                right.updatedAt.localeCompare(left.updatedAt) ||
                left.key.localeCompare(right.key)
            ))
            .slice(0, limit);
        return { results: rows };
    }

    async first(): Promise<unknown | null> {
        return this.database.rows.get(this.stringAt(0)) ?? null;
    }

    async run(): Promise<SqlRunResult> {
        if (this.query.includes("CREATE TABLE")) {
            this.database.schemaInitializations += 1;
            return { meta: { changes: 0 } };
        }
        if (this.query.includes("INSERT INTO d1_values")) {
            const row: TestRow = {
                key: this.stringAt(0),
                size: new TextEncoder().encode(this.stringAt(1)).byteLength,
                value: this.stringAt(1),
                updatedAt: this.stringAt(2),
            };
            this.database.rows.set(row.key, row);
            return { meta: { changes: 1 } };
        }
        if (this.query.includes("DELETE FROM d1_values")) {
            const deleted = this.database.rows.delete(this.stringAt(0));
            return { meta: { changes: deleted ? 1 : 0 } };
        }
        throw new Error(`Unsupported test query: ${this.query}`);
    }

    private numberAt(index: number): number {
        const value = this.values[index];
        if (typeof value !== "number") throw new TypeError("Expected a number.");
        return value;
    }

    private stringAt(index: number): string {
        const value = this.values[index];
        if (typeof value !== "string") throw new TypeError("Expected a string.");
        return value;
    }
}

class FakeSqlDatabase implements SqlDatabase {
    readonly rows = new Map<string, TestRow>();
    schemaInitializations = 0;

    prepare(query: string): SqlPreparedStatement {
        return new FakeSqlStatement(this, query);
    }
}

class FakeObjectBucket implements ObjectBucket {
    private readonly objects = new Map<string, TextObjectBody>();

    async delete(key: string): Promise<void> {
        this.objects.delete(key);
    }

    async get(key: string): Promise<TextObjectBody | null> {
        return this.objects.get(key) ?? null;
    }

    async list(): Promise<{ objects: ObjectMetadata[] }> {
        return { objects: [...this.objects.values()] };
    }

    async put(
        key: string,
        value: string,
        options: {
            customMetadata: Record<string, string>;
            httpMetadata: { contentType: string };
        }
    ): Promise<ObjectMetadata> {
        assert.equal(options.httpMetadata.contentType, "text/plain; charset=utf-8");
        const metadata: ObjectMetadata = {
            customMetadata: options.customMetadata,
            key,
            size: new TextEncoder().encode(value).byteLength,
            uploaded: new Date("2026-01-01T00:00:00.000Z"),
        };
        this.objects.set(key, {
            ...metadata,
            async text() {
                return value;
            },
        });
        return metadata;
    }
}

async function verifyTextStore(store: TextStore): Promise<void> {
    const key = "portable:test";
    const value = "strict TypeScript";

    assert.equal(await store.get(key), null);
    const written = await store.put({ key, value });
    assert.equal(written.key, key);
    assert.equal(written.value, value);
    assert.deepEqual(await store.get(key), written);
    const listed = await store.list(50);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.key, written.key);
    assert.equal(listed[0]?.updatedAt, written.updatedAt);
    assert.equal(await store.delete(key), true);
    assert.equal(await store.get(key), null);
}

test("D1 and R2 adapters honor the same TextStore contract", async (context) => {
    const now = () => "2026-08-09T00:00:00.000Z";
    const database = new FakeSqlDatabase();

    await context.test("D1", async () => {
        await verifyTextStore(new D1TextStore(database, now));
        assert.equal(database.schemaInitializations, 1);
    });

    await context.test("R2", async () => {
        await verifyTextStore(new R2TextStore(new FakeObjectBucket(), now));
    });
});

test("D1 schema initialization is shared by adapters for one binding", async () => {
    const database = new FakeSqlDatabase();
    await new D1TextStore(database).list(10);
    await new D1TextStore(database).list(10);
    assert.equal(database.schemaInitializations, 1);
});

test("API payload parsing rejects malformed provider data", () => {
    assert.deepEqual(parseStorageApiPayload({ entries: [] }), { entries: [] });
    assert.deepEqual(parseStorageApiPayload({ entries: [{ key: 1 }] }), {
        error: "The server returned an invalid D1 list.",
    });
    assert.deepEqual(parseStorageApiPayload({}), {
        error: "The server returned an unexpected response.",
    });
});
