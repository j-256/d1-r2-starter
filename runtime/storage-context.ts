import { AsyncLocalStorage } from "node:async_hooks";
import type {
    StorageKind,
    StorageServices,
    TextStore,
} from "../storage/contracts";

const storageContext = new AsyncLocalStorage<StorageServices>();

/**
 * Keeps Worker bindings request-scoped while leaving application code unaware
 * of Cloudflare's environment object.
 */
export function runWithStorageServices<T>(
    services: StorageServices,
    callback: () => T
): T {
    return storageContext.run(services, callback);
}

export function getStorageService(kind: StorageKind): TextStore {
    const services = storageContext.getStore();
    if (!services) {
        throw new Error("Storage services are unavailable for this request.");
    }
    return services[kind];
}
