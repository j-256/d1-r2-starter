import { getStorageBindings } from "../../../runtime/storage-bindings";

export const dynamic = "force-dynamic";

function getBucket() {
    const bucket = getStorageBindings().BUCKET;
    if (!bucket) {
        throw new Error("The Cloudflare R2 binding is unavailable.");
    }
    return bucket;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Unexpected R2 error.";
}

function validateKey(key: unknown) {
    if (typeof key !== "string" || !key.trim()) return "A key is required.";
    if (key.trim().length > 256) return "Keys may contain at most 256 characters.";
    return null;
}

export async function GET(request: Request) {
    try {
        const key = new URL(request.url).searchParams.get("key");
        if (key !== null) {
            const validationError = validateKey(key);
            if (validationError) {
                return Response.json({ error: validationError }, { status: 400 });
            }
            const object = await getBucket().get(key.trim());
            if (!object) {
                return Response.json({ error: `R2 key “${key.trim()}” was not found.` }, { status: 404 });
            }
            const entry = {
                key: object.key,
                size: object.size,
                updatedAt: object.customMetadata?.updatedAt ?? object.uploaded.toISOString(),
                value: await object.text(),
            };
            return Response.json({ entry }, { headers: { "cache-control": "no-store" } });
        }

        const listed = await getBucket().list({
            include: ["customMetadata", "httpMetadata"],
            limit: 50,
        });
        const objects = listed.objects.map((object) => ({
            key: object.key,
            size: object.size,
            updatedAt: object.customMetadata?.updatedAt ?? object.uploaded.toISOString(),
        }));
        return Response.json({ objects }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        const payload = (await request.json()) as { key?: unknown; value?: unknown };
        const validationError = validateKey(payload.key);
        if (validationError) {
            return Response.json({ error: validationError }, { status: 400 });
        }
        if (typeof payload.value !== "string") {
            return Response.json({ error: "The value must be text." }, { status: 400 });
        }
        if (payload.value.length > 100000) {
            return Response.json({ error: "Values may contain at most 100,000 characters." }, { status: 400 });
        }

        const key = (payload.key as string).trim();
        const updatedAt = new Date().toISOString();
        const object = await getBucket().put(key, payload.value, {
            customMetadata: { updatedAt },
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        return Response.json({
            entry: { key, size: object.size, updatedAt, value: payload.value },
        });
    } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const key = new URL(request.url).searchParams.get("key");
        const validationError = validateKey(key);
        if (validationError) {
            return Response.json({ error: validationError }, { status: 400 });
        }
        const normalizedKey = (key as string).trim();
        await getBucket().delete(normalizedKey);
        return Response.json({ deleted: true, key: normalizedKey });
    } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
}
