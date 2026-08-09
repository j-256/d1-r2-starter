import {
    deleteD1Value,
    listD1Values,
    readD1Value,
    writeD1Value,
} from "../../../db/d1-values";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Unexpected D1 error.";
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
            const entry = await readD1Value(key.trim());
            if (!entry) {
                return Response.json({ error: `D1 key “${key.trim()}” was not found.` }, { status: 404 });
            }
            return Response.json({ entry }, { headers: { "cache-control": "no-store" } });
        }

        const entries = await listD1Values();
        return Response.json({ entries }, { headers: { "cache-control": "no-store" } });
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

        const entry = await writeD1Value((payload.key as string).trim(), payload.value);
        return Response.json({ entry });
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
        const deleted = await deleteD1Value(normalizedKey);
        return Response.json({ deleted, key: normalizedKey });
    } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
}
