import type {
    PutTextItem,
    StoredTextItem,
    TextStore,
} from "../contracts";

export type ObjectMetadata = {
    customMetadata?: Record<string, string>;
    key: string;
    size: number;
    uploaded: Date;
};

export type TextObjectBody = ObjectMetadata & {
    text(): Promise<string>;
};

export interface ObjectBucket {
    delete(key: string): Promise<void>;
    get(key: string): Promise<TextObjectBody | null>;
    list(options: {
        include: Array<"customMetadata">;
        limit: number;
    }): Promise<{ objects: ObjectMetadata[] }>;
    put(
        key: string,
        value: string,
        options: {
            customMetadata: Record<string, string>;
            httpMetadata: { contentType: string };
        }
    ): Promise<ObjectMetadata>;
}

type Clock = () => string;

function systemClock(): string {
    return new Date().toISOString();
}

function updatedAtFor(object: ObjectMetadata): string {
    return object.customMetadata?.["updatedAt"] ?? object.uploaded.toISOString();
}

/** Adapts an R2-compatible object bucket to the provider-neutral TextStore API. */
export class R2TextStore implements TextStore {
    private readonly bucket: ObjectBucket;
    private readonly clock: Clock;

    constructor(bucket: ObjectBucket, clock: Clock = systemClock) {
        this.bucket = bucket;
        this.clock = clock;
    }

    async delete(key: string): Promise<boolean> {
        await this.bucket.delete(key);
        return true;
    }

    async get(key: string): Promise<StoredTextItem | null> {
        const object = await this.bucket.get(key);
        if (!object) return null;

        return {
            key: object.key,
            size: object.size,
            updatedAt: updatedAtFor(object),
            value: await object.text(),
        };
    }

    async list(limit: number): Promise<StoredTextItem[]> {
        const result = await this.bucket.list({
            include: ["customMetadata"],
            limit,
        });

        return result.objects.map((object) => ({
            key: object.key,
            size: object.size,
            updatedAt: updatedAtFor(object),
        }));
    }

    async put(item: PutTextItem): Promise<StoredTextItem> {
        const updatedAt = this.clock();
        const object = await this.bucket.put(item.key, item.value, {
            customMetadata: { updatedAt },
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });

        return {
            key: item.key,
            size: object.size,
            updatedAt,
            value: item.value,
        };
    }
}
