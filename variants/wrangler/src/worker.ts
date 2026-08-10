import { Hono } from "hono";
import { createTextStoreRoute } from "../routes/text-store-route.ts";
import { runWithRequestContext } from "../runtime/storage-context.ts";
import { sharedSecretAuthorizer } from "../storage/authorizers/shared-secret.ts";
import {
    createStorageServices,
    type RuntimeStorageBindings,
} from "../storage/create-services.ts";

type Bindings = RuntimeStorageBindings & { SHARED_SECRET: string };

const app = new Hono<{ Bindings: Bindings }>();

// Every /api request builds request-scoped services + a real authorizer, then
// runs the shared route factory inside the storage context. No validation,
// auth, or response logic lives here; the factory owns all of it.
app.use("/api/*", async (c, next) => {
    const services = createStorageServices(c.env);
    const authorizer = sharedSecretAuthorizer(c.env.SHARED_SECRET);
    return runWithRequestContext({ authorizer, services }, () => next());
});

const d1 = createTextStoreRoute("d1");
const r2 = createTextStoreRoute("r2");

app.get("/api/d1", (c) => d1.get(c.req.raw));
app.put("/api/d1", (c) => d1.put(c.req.raw));
app.delete("/api/d1", (c) => d1.delete(c.req.raw));

app.get("/api/r2", (c) => r2.get(c.req.raw));
app.put("/api/r2", (c) => r2.put(c.req.raw));
app.delete("/api/r2", (c) => r2.delete(c.req.raw));

export default app;
