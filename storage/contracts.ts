/** Provider-neutral contracts used by the application and storage adapters. */
export const STORAGE_KINDS = ["d1", "r2"] as const;

export type StorageKind = (typeof STORAGE_KINDS)[number];

export type StoredTextItem = {
    key: string;
    size: number;
    updatedAt: string;
    value?: string;
};

export type PutTextItem = {
    key: string;
    value: string;
};

export interface TextStore {
    delete(key: string): Promise<boolean>;
    get(key: string): Promise<StoredTextItem | null>;
    list(limit: number): Promise<StoredTextItem[]>;
    put(item: PutTextItem): Promise<StoredTextItem>;
}

export type StorageServices = Readonly<Record<StorageKind, TextStore>>;

export const STORAGE_LIMITS = {
    keyCharacters: 256,
    listItems: 50,
    valueCharacters: 100_000,
} as const;
