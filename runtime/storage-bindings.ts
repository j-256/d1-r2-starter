import { AsyncLocalStorage } from "node:async_hooks";

export type D1RunResult = {
    meta: {
        changes: number;
    };
};

export type D1PreparedStatement = {
    all<T>(): Promise<{ results: T[] }>;
    bind(...values: unknown[]): D1PreparedStatement;
    first<T>(): Promise<T | null>;
    run(): Promise<D1RunResult>;
};

export type D1Binding = {
    prepare(query: string): D1PreparedStatement;
};

export type R2StoredObject = {
    customMetadata?: Record<string, string>;
    key: string;
    size: number;
    uploaded: Date;
};

export type R2ObjectBody = R2StoredObject & {
    text(): Promise<string>;
};

export type R2Binding = {
    delete(key: string): Promise<void>;
    get(key: string): Promise<R2ObjectBody | null>;
    list(options?: {
        include?: Array<"customMetadata" | "httpMetadata">;
        limit?: number;
    }): Promise<{ objects: R2StoredObject[] }>;
    put(
        key: string,
        value: string,
        options?: {
            customMetadata?: Record<string, string>;
            httpMetadata?: { contentType?: string };
        }
    ): Promise<R2StoredObject>;
};

export type StorageBindings = {
    BUCKET: R2Binding;
    DB: D1Binding;
};

const bindingContext = new AsyncLocalStorage<StorageBindings>();

export function runWithStorageBindings<T>(
    bindings: StorageBindings,
    callback: () => T
) {
    return bindingContext.run(bindings, callback);
}

export function getStorageBindings() {
    const bindings = bindingContext.getStore();
    if (!bindings) {
        throw new Error("Cloudflare storage bindings are unavailable for this request.");
    }
    return bindings;
}
