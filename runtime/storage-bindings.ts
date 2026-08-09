import { AsyncLocalStorage } from "node:async_hooks";

export type StorageBindings = {
    BUCKET: R2Bucket;
    DB: D1Database;
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
