"use client";

import { useCallback, useEffect, useState } from "react";

type StoreKind = "d1" | "r2";

type StoredItem = {
    key: string;
    size?: number;
    updatedAt: string;
    value?: string;
};

type StoragePanelProps = {
    description: string;
    kind: StoreKind;
    title: string;
};

function formatDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function readJson(response: Response) {
    const payload = (await response.json()) as {
        deleted?: boolean;
        entries?: StoredItem[];
        entry?: StoredItem;
        error?: string;
        objects?: StoredItem[];
    };

    if (!response.ok) {
        throw new Error(payload.error ?? `Request failed (${response.status})`);
    }

    return payload;
}

function StoragePanel({ description, kind, title }: StoragePanelProps) {
    const [items, setItems] = useState<StoredItem[]>([]);
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [status, setStatus] = useState("Loading saved keys…");
    const [busy, setBusy] = useState(false);
    const endpoint = `/api/${kind}`;

    const refresh = useCallback(async () => {
        try {
            const payload = await readJson(
                await fetch(endpoint, { cache: "no-store" })
            );
            setItems(payload.entries ?? payload.objects ?? []);
            setStatus("Ready.");
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Refresh failed.");
        }
    }, [endpoint]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function save() {
        const normalizedKey = key.trim();
        if (!normalizedKey) {
            setStatus("Enter a key first.");
            return;
        }

        setBusy(true);
        setStatus("Saving…");
        try {
            const payload = await readJson(
                await fetch(endpoint, {
                    body: JSON.stringify({ key: normalizedKey, value }),
                    headers: { "content-type": "application/json" },
                    method: "PUT",
                })
            );
            setKey(payload.entry?.key ?? normalizedKey);
            setStatus(`Saved “${normalizedKey}”.`);
            await refresh();
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Save failed.");
        } finally {
            setBusy(false);
        }
    }

    async function read() {
        const normalizedKey = key.trim();
        if (!normalizedKey) {
            setStatus("Enter or select a key first.");
            return;
        }

        setBusy(true);
        setStatus("Reading…");
        try {
            const payload = await readJson(
                await fetch(`${endpoint}?key=${encodeURIComponent(normalizedKey)}`, {
                    cache: "no-store",
                })
            );
            setValue(payload.entry?.value ?? "");
            setStatus(`Read “${normalizedKey}”.`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Read failed.");
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        const normalizedKey = key.trim();
        if (!normalizedKey) {
            setStatus("Enter or select a key first.");
            return;
        }
        if (!window.confirm(`Delete “${normalizedKey}” from ${title}?`)) return;

        setBusy(true);
        setStatus("Deleting…");
        try {
            await readJson(
                await fetch(`${endpoint}?key=${encodeURIComponent(normalizedKey)}`, {
                    method: "DELETE",
                })
            );
            setKey("");
            setValue("");
            setStatus(`Deleted “${normalizedKey}”.`);
            await refresh();
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Delete failed.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="storage-panel" aria-labelledby={`${kind}-title`}>
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Cloudflare</p>
                    <h2 id={`${kind}-title`}>{title}</h2>
                </div>
                <span className="binding">{kind === "d1" ? "DB" : "BUCKET"}</span>
            </div>
            <p className="description">{description}</p>

            <div className="field">
                <label htmlFor={`${kind}-key`}>Key</label>
                <input
                    id={`${kind}-key`}
                    maxLength={256}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="example-key"
                    spellCheck={false}
                    value={key}
                />
            </div>
            <div className="field">
                <label htmlFor={`${kind}-value`}>Value</label>
                <textarea
                    id={`${kind}-value`}
                    maxLength={100000}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Any text value"
                    rows={7}
                    value={value}
                />
            </div>

            <div className="actions">
                <button disabled={busy} onClick={() => void save()} type="button">
                    Save
                </button>
                <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void read()}
                    type="button"
                >
                    Read
                </button>
                <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void remove()}
                    type="button"
                >
                    Delete
                </button>
            </div>

            <p className="status" aria-live="polite">{status}</p>

            <div className="saved-heading">
                <h3>Saved keys</h3>
                <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void refresh()}
                    type="button"
                >
                    Refresh
                </button>
            </div>
            {items.length ? (
                <ul className="saved-list">
                    {items.map((item) => (
                        <li key={item.key}>
                            <button
                                onClick={() => {
                                    setKey(item.key);
                                    if (typeof item.value === "string") {
                                        setValue(item.value);
                                    }
                                    setStatus(`Selected “${item.key}”.`);
                                }}
                                type="button"
                            >
                                <span>{item.key}</span>
                                <small>
                                    {typeof item.size === "number"
                                        ? `${item.size.toLocaleString()} bytes · `
                                        : ""}
                                    {formatDate(item.updatedAt)}
                                </small>
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="empty">No keys saved yet.</p>
            )}
        </section>
    );
}

export default function Home() {
    return (
        <main>
            <header className="page-header">
                <div>
                    <p className="eyebrow">Starter</p>
                    <h1>Storage workbench</h1>
                    <p>
                        Two deliberately small read/write examples using native
                        Cloudflare storage bindings.
                    </p>
                </div>
                <span className="private-label">Private Site</span>
            </header>

            <div className="panel-grid">
                <StoragePanel
                    description="Structured key/value rows in a relational SQLite database. Saving an existing key updates it."
                    kind="d1"
                    title="D1"
                />
                <StoragePanel
                    description="Text objects stored by key in object storage. Values are retrieved directly from each object."
                    kind="r2"
                    title="R2"
                />
            </div>
        </main>
    );
}
