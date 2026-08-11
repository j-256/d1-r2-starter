import { Hono } from "hono";
import { runWithAppContext } from "../app-context.ts";
import { createAppServices } from "../app-services.ts";
import {
    documentCollectionHandlers,
    documentItemHandlers,
} from "../features/documents/http.ts";
import type { RuntimeBindings } from "../platform/cloudflare-bindings.ts";
import { sharedSecretAuthorizer } from "../platform/authorizers/shared-secret.ts";

type Bindings = RuntimeBindings & { SHARED_SECRET: string };

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", async (c, next) => {
    const services = createAppServices(c.env);
    const authorizer = sharedSecretAuthorizer(c.env.SHARED_SECRET);
    return runWithAppContext({ authorizer, services }, () => next());
});

app.get("/api/documents", (c) => documentCollectionHandlers.get(c.req.raw));
app.post("/api/documents", (c) => documentCollectionHandlers.post(c.req.raw));
app.get(
    "/api/documents/:id",
    (c) => documentItemHandlers.get(c.req.raw, c.req.param("id"))
);
app.delete(
    "/api/documents/:id",
    (c) => documentItemHandlers.delete(c.req.raw, c.req.param("id"))
);

export default app;
