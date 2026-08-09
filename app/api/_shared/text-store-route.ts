import { getStorageService } from "../../../runtime/storage-context";
import {
    STORAGE_LIMITS,
    type StorageKind,
} from "../../../storage/contracts";

type ValidationResult<T> =
    | { ok: true; value: T }
    | { error: string; ok: false };

type WritePayload = {
    key: string;
    value: string;
};

const resourceLabels = {
    d1: "D1",
    r2: "R2",
} satisfies Record<StorageKind, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown, kind: StorageKind): string {
    return error instanceof Error
        ? error.message
        : `Unexpected ${resourceLabels[kind]} error.`;
}

function validateKey(value: unknown): ValidationResult<string> {
    if (typeof value !== "string" || !value.trim()) {
        return { error: "A key is required.", ok: false };
    }

    const key = value.trim();
    if (key.length > STORAGE_LIMITS.keyCharacters) {
        return {
            error: `Keys may contain at most ${STORAGE_LIMITS.keyCharacters} characters.`,
            ok: false,
        };
    }
    return { ok: true, value: key };
}

function validateWritePayload(value: unknown): ValidationResult<WritePayload> {
    if (!isRecord(value)) {
        return { error: "The request body must be a JSON object.", ok: false };
    }

    const keyResult = validateKey(value["key"]);
    if (!keyResult.ok) return keyResult;

    if (typeof value["value"] !== "string") {
        return { error: "The value must be text.", ok: false };
    }
    if (value["value"].length > STORAGE_LIMITS.valueCharacters) {
        return {
            error: `Values may contain at most ${STORAGE_LIMITS.valueCharacters.toLocaleString()} characters.`,
            ok: false,
        };
    }

    return {
        ok: true,
        value: {
            key: keyResult.value,
            value: value["value"],
        },
    };
}

function noStore(payload: unknown, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    headers.set("cache-control", "no-store");
    return Response.json(payload, { ...init, headers });
}

export function createTextStoreRoute(kind: StorageKind) {
    const label = resourceLabels[kind];

    return {
        async delete(request: Request): Promise<Response> {
            try {
                const keyResult = validateKey(
                    new URL(request.url).searchParams.get("key")
                );
                if (!keyResult.ok) {
                    return Response.json(
                        { error: keyResult.error },
                        { status: 400 }
                    );
                }

                const deleted = await getStorageService(kind).delete(
                    keyResult.value
                );
                return Response.json({ deleted, key: keyResult.value });
            } catch (error) {
                return Response.json(
                    { error: errorMessage(error, kind) },
                    { status: 500 }
                );
            }
        },

        async get(request: Request): Promise<Response> {
            try {
                const key = new URL(request.url).searchParams.get("key");
                if (key !== null) {
                    const keyResult = validateKey(key);
                    if (!keyResult.ok) {
                        return Response.json(
                            { error: keyResult.error },
                            { status: 400 }
                        );
                    }

                    const entry = await getStorageService(kind).get(
                        keyResult.value
                    );
                    if (!entry) {
                        return noStore(
                            {
                                error: `${label} key “${keyResult.value}” was not found.`,
                            },
                            { status: 404 }
                        );
                    }
                    return noStore({ entry });
                }

                const items = await getStorageService(kind).list(
                    STORAGE_LIMITS.listItems
                );
                return kind === "d1"
                    ? noStore({ entries: items })
                    : noStore({ objects: items });
            } catch (error) {
                return noStore(
                    { error: errorMessage(error, kind) },
                    { status: 500 }
                );
            }
        },

        async put(request: Request): Promise<Response> {
            try {
                let body: unknown;
                try {
                    body = await request.json();
                } catch {
                    return Response.json(
                        { error: "The request body must contain valid JSON." },
                        { status: 400 }
                    );
                }

                const payloadResult = validateWritePayload(body);
                if (!payloadResult.ok) {
                    return Response.json(
                        { error: payloadResult.error },
                        { status: 400 }
                    );
                }

                const entry = await getStorageService(kind).put(
                    payloadResult.value
                );
                return Response.json({ entry });
            } catch (error) {
                return Response.json(
                    { error: errorMessage(error, kind) },
                    { status: 500 }
                );
            }
        },
    };
}
